import { captureSkipReason } from '../domain/capture';
import { fingerprintInput, UNKNOWN_MODEL, type LabelState } from '../domain/evaluation';
import { settledBaselineOf, type JobVerdict, type SettledEvaluationBaseline } from '../domain/evaluation-budget';
import { fitsInputCeiling, type LabellerSpec } from '../domain/evaluation-pricing';
import {
  machinePromptOf,
  machineRequestOf,
  machineResponseOf,
  parseMachineAnswer,
  type MachineLabellerId,
} from '../domain/machine-label';
import { compileRules } from '../domain/rule-compiler';
import { loadCaptureSamples } from './capture-store';
import { machineSpecOf } from './evaluation-connection';
import { loadEvaluationKeys } from './evaluation-keys';
import {
  describe,
  fetchWithTimeout,
  observedStateOf,
  parseStateJson,
  postOfSample,
  ruleById,
  skipReasonForBudgetError,
  type JevExecutionResult,
  type JevSkipReason,
} from './evaluation-jev';
import {
  abandonEvaluationJob,
  recheckActiveEvaluationJob,
  settleEvaluationJob,
  startEvaluationJob,
} from './evaluation-jobs';
import { loadSettings } from './settings-store';

/**
 * One (sample, rule) pair labelled by one independent machine model.
 *
 * The same boundaries as the Jev slice, enforced the same way: an explicit
 * `authorized` flag, a durable worst-case reservation before any request, a
 * fail-closed recheck immediately before `fetch`, no blind retry, and money and
 * answer settled in a single write.
 *
 * Independence from the other labellers is structural. This module reads the
 * capture sample, the compiled rule question and its own key; it never loads a
 * Jev baseline, another model's label, the feed's outcomes or a human label, and
 * builds the prompt from nothing else. It also has a distinct job identity per
 * model, so a repeat is deduped inside one model and never across models.
 *
 * Reasoning is switched off and output is capped, so the reservation (whole
 * input ceiling plus the full output bound at the model's dearest rate) really
 * is an upper bound on the bill. The request body is measured before sending:
 * one that could exceed the ceiling is refused, not sent.
 */

export interface MachineLabelRequest {
  readonly labeller: MachineLabellerId;
  readonly sampleId: string;
  readonly ruleId: string;
  readonly authorized: boolean;
}

export interface MachineTrace {
  readonly labeller: MachineLabellerId;
  readonly sampleId: string;
  readonly ruleId: string;
  readonly requestedModel: string;
  readonly answeredModel: string;
  readonly rulesFingerprint: string;
  readonly inputHash: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicro: number | null;
  readonly jobId: string;
}

export type MachineExecutionResult =
  | Extract<JevExecutionResult, { kind: 'skipped' }>
  | {
      readonly kind: 'labelled';
      readonly state: LabelState;
      readonly reason: string;
      readonly trace: MachineTrace;
      readonly restored?: true;
    }
  | { readonly kind: 'undecided'; readonly detail: string; readonly trace: MachineTrace; readonly restored?: true }
  | { readonly kind: 'unknown'; readonly detail: string; readonly trace: MachineTrace };

function skip(
  sampleId: string,
  ruleId: string,
  reason: JevSkipReason,
  detail: string,
): Extract<MachineExecutionResult, { kind: 'skipped' }> {
  return { kind: 'skipped', sampleId, ruleId, reason, detail };
}

function resultFromBaseline(
  labeller: MachineLabellerId,
  baseline: SettledEvaluationBaseline,
  spec: LabellerSpec,
): MachineExecutionResult {
  const trace: MachineTrace = {
    labeller,
    sampleId: baseline.sampleId,
    ruleId: baseline.ruleId,
    requestedModel: spec.model,
    answeredModel: baseline.answeredModel ?? UNKNOWN_MODEL,
    rulesFingerprint: baseline.rulesFingerprint,
    inputHash: baseline.inputHash,
    inputTokens: baseline.settledInputTokens,
    outputTokens: baseline.settledOutputTokens,
    costMicro: baseline.settledMicro,
    jobId: baseline.jobId,
  };
  if (baseline.verdict.status === 'labelled') {
    return { kind: 'labelled', state: baseline.verdict.state, reason: baseline.verdict.reason, trace, restored: true };
  }
  return { kind: 'undecided', detail: 'the stored result carried no usable answer', trace, restored: true };
}

export async function runSingleMachineLabel(request: MachineLabelRequest): Promise<MachineExecutionResult> {
  const { labeller, sampleId, ruleId } = request;
  const spec = await machineSpecOf(labeller);
  if (request.authorized !== true) {
    return skip(sampleId, ruleId, 'not-authorized', 'evaluation is not authorized');
  }

  const key = (await loadEvaluationKeys())[labeller];
  if (key === '') return skip(sampleId, ruleId, 'no-key', `no ${spec.label} key is stored`);

  const settings = await loadSettings();
  const samples = await loadCaptureSamples();
  const sample = samples.find((candidate) => candidate.sampleId === sampleId);
  if (sample === undefined) {
    return skip(sampleId, ruleId, 'sample-not-found', 'the sample is not in the capture library');
  }
  const parsed = parseStateJson(sample.stateJson);
  const state = parsed === null ? null : observedStateOf(parsed);
  if (state === null) {
    return skip(sampleId, ruleId, 'not-sendable', 'the stored sample state is not readable');
  }
  const post = postOfSample(sample, state);
  const inadmissible = captureSkipReason(post);
  if (inadmissible !== null) {
    return skip(sampleId, ruleId, 'not-sendable', `sample refused locally: ${inadmissible}`);
  }

  const compiled = compileRules(settings.rules, { hasParent: post.parent !== null });
  const question = compiled.questions[ruleId];
  const rule = ruleById(settings, ruleId);
  if (question === undefined || rule === undefined) {
    return skip(sampleId, ruleId, 'rule-not-compiled', 'the rule has no applicable compiled question');
  }
  const threshold = rule.threshold ?? settings.threshold;
  const inputHash = fingerprintInput(sample.stateJson, question);

  // Build and measure the exact body before anything is reserved or sent.
  const built = machineRequestOf(spec, key, machinePromptOf(sample.stateJson, question), spec.maxOutputTokens);
  if (!fitsInputCeiling(spec, built.body)) {
    return skip(sampleId, ruleId, 'not-sendable', 'the request is larger than the input ceiling reserved for it');
  }

  const started = await startEvaluationJob({
    model: spec.model,
    rulesFingerprint: compiled.key,
    ruleId,
    inputHash,
    maxOutputTokens: spec.maxOutputTokens,
    sampleId,
    threshold,
  });
  if (!started.ok) {
    return skip(sampleId, ruleId, skipReasonForBudgetError(started.error), started.detail);
  }
  if (started.deduped) {
    const baseline = settledBaselineOf(started.job);
    if (baseline) return resultFromBaseline(labeller, baseline, spec);
    return skip(
      sampleId,
      ruleId,
      'already-recorded',
      started.job.status === 'settled'
        ? 'this exact task settled without a recorded answer; it is never sent twice'
        : 'this exact task is already recorded; it is never sent twice',
    );
  }

  const job = started.job;
  const trace: MachineTrace = {
    labeller,
    sampleId,
    ruleId,
    requestedModel: spec.model,
    answeredModel: UNKNOWN_MODEL,
    rulesFingerprint: compiled.key,
    inputHash,
    inputTokens: null,
    outputTokens: null,
    costMicro: null,
    jobId: job.jobId,
  };
  const abandonUnknown = async (detail: string): Promise<MachineExecutionResult> => {
    await abandonEvaluationJob({ jobId: job.jobId, epoch: job.epoch, sent: true });
    return { kind: 'unknown', detail, trace };
  };

  const active = await recheckActiveEvaluationJob(job.jobId, job.epoch);
  if (!active.ok) {
    return skip(sampleId, ruleId, 'job-inactive', `request not sent: ${active.detail}`);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(built.url, { method: 'POST', headers: built.headers, body: built.body });
  } catch (error) {
    return abandonUnknown(describe(error));
  }
  if (!response.ok) return abandonUnknown(`HTTP ${response.status}`);

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    return abandonUnknown(`unreadable response: ${describe(error)}`);
  }

  const read = machineResponseOf(json);
  if (read.inputTokens === undefined || read.outputTokens === undefined) {
    return abandonUnknown('the response did not report usable token usage');
  }

  const answer = read.truncated ? null : parseMachineAnswer(read.text);
  const verdict: JobVerdict =
    answer === null
      ? { status: 'undecided' }
      : { status: 'labelled', state: answer.state, reason: answer.reason };

  const settled = await settleEvaluationJob({
    jobId: job.jobId,
    epoch: job.epoch,
    actualInputTokens: read.inputTokens,
    actualOutputTokens: read.outputTokens,
    sampleId,
    threshold,
    answeredModel: read.model ?? null,
    verdict,
  });
  if (!settled.ok) {
    return { kind: 'unknown', detail: `settlement refused: ${settled.error}`, trace };
  }

  const recorded: MachineTrace = {
    ...trace,
    answeredModel: settled.job.answeredModel ?? UNKNOWN_MODEL,
    inputTokens: read.inputTokens,
    outputTokens: read.outputTokens,
    costMicro: settled.job.settledMicro,
  };
  if (answer === null) {
    return {
      kind: 'undecided',
      detail: read.truncated ? 'the answer was cut short' : 'the response carried no readable answer',
      trace: recorded,
    };
  }
  return { kind: 'labelled', state: answer.state, reason: answer.reason, trace: recorded };
}
