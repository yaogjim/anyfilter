import { captureSkipReason, type CaptureSample } from '../domain/capture';
import { fingerprintInput, isValidScore, UNKNOWN_MODEL } from '../domain/evaluation';
import {
  settledBaselineOf,
  type BudgetLimit,
  type BudgetPrice,
  type JobVerdict,
  type SettledEvaluationBaseline,
} from '../domain/evaluation-budget';
import { JEV_SPEC, budgetConfigOfAllLabellers } from '../domain/evaluation-pricing';
import type { Post } from '../domain/post';
import { compileRules } from '../domain/rule-compiler';
import type { Rule } from '../domain/rule';
import type { Settings } from '../domain/settings';
import { loadCaptureSamples } from './capture-store';
import { enableEvaluationBudget, startEvaluationJob, settleEvaluationJob, abandonEvaluationJob, recheckActiveEvaluationJob, type BudgetStoreResult } from './evaluation-jobs';
import { questionsAs, scoresFrom } from './jev/jev-payload';
import { readModel, readUsage } from './jev/provider-adapter';
import { loadSettings } from './settings-store';

/**
 * Default-off, single-sample execution slice for a real TypeSafe Jev call.
 *
 * Phase 3 plugs the already-built pieces together for exactly one
 * (capture sample, compiled rule) pair: the offline capture library and the
 * persistent spending budget are the only stores read, and the network is reached
 * only after a reservation has been durably written.
 *
 * Security boundaries, enforced below rather than promised:
 *
 * - **Default off / zero fetch.** A call must be explicitly `authorized`. Without
 *   that, and without the budget switched on, the function reads no key and
 *   reaches no network. The budget's `startEvaluationJob` is the second gate: a
 *   refusal there stops the call before any `fetch`.
 * - **Reserve before send.** The worst-case reservation is persisted first; only a
 *   successful, non-deduped write allows a request. A repeat of the same task is
 *   never sent again: if the earlier run settled with a real verdict, that
 *   baseline is restored from storage, so the pair cannot be paid for twice and
 *   its answer is not lost on restart. A settled-without-result repeat is refused
 *   too, and never presented as a baseline.
 * - **Recheck before send, fail closed.** Immediately before `fetch`, the job is
 *   re-confirmed on the budget's serial write chain as still the current, pending
 *   job. A stop or a delete that landed after the reservation refuses the send;
 *   the money stays held by that stop/delete and nothing is retried.
 * - **No blind retry.** Once a request has been handed to `fetch`, any network
 *   failure, non-2xx answer or missing/malformed usage becomes `abandon(...,
 *   sent: true)`: the job is kept as `unknown` with its money still held. This
 *   module never retries on its own.
 * - **Money and verdict in one write.** A successful call settles the reservation
 *   and, in the same `storage.local` transaction, records the trusted real
 *   judgement — a finite score or an explicit `undecided`, the response model, the
 *   threshold, the sample id and the real token usage. Only identity and outcome
 *   are stored, never the body or a key, so a restarted worker rebuilds the
 *   baseline offline via `loadSettledEvaluationBaselines`.
 * - **Fixed, versioned model.** The request names `jev-1.13.0`, never the movable
 *   `jev-latest` alias, and is priced at the verified $0.042 / million input
 *   tokens with free output and a 64k whole-request input ceiling, under a USD 1
 *   cap. The reservation therefore cannot silently follow a repriced alias.
 * - **Exact same snapshot.** The input is the sample's own stored `stateJson`,
 *   never re-read DOM text, and the question is compiled from the settings that
 *   are current at call time. The recorded `inputHash` and `rulesFingerprint`
 *   therefore describe exactly what was sent.
 * - **No automatic outbound content.** Own posts and protected/unknown content
 *   are refused again here (`captureSkipReason`), even though the capture library
 *   already filtered them, so a corrupted record cannot be auto-sent.
 *
 * This module deliberately does not use the provider adapters (they request the
 * `jev-latest` alias) and does not touch the production filter, the preview path
 * or the score cache: it builds its own request, parses its own answer, and
 * settles the budget. It implements no authorization UI and no scheduler; the
 * next slice wires an explicit user action to `authorized` and the budget switch.
 */

/** The exact model requested. Pinned on purpose: an alias can be repointed and
 * repriced, so a bounded baseline must name the version it was priced for. */
export const JEV_MODEL = JEV_SPEC.model;

/** The TypeSafe endpoint the direct adapter uses. */
export const JEV_REQUEST_URL = JEV_SPEC.endpoint;

/**
 * Verified TypeSafe Jev 1.13 price: $0.042 per million input tokens, output free.
 * Stated the same way the budget states rates — whole micro-units per million
 * tokens — so nothing here is per single token.
 */
export const JEV_PRICE: BudgetPrice = JEV_SPEC.price;

/** USD 1 cap against the published 64k whole-request input ceiling. */
export const JEV_LIMIT: BudgetLimit = JEV_SPEC.limit;

/**
 * Output bound reserved for one answer. A single boolean question is answered
 * with a tiny JSON object; output is free for this model, so this contributes
 * nothing to the reservation. It only has to be a positive integer the budget can
 * record, and it must never be read as a real generation limit the request
 * enforces (the TypeSafe body carries no such field).
 */
export const JEV_MAX_OUTPUT_TOKENS = JEV_SPEC.maxOutputTokens;

/** A hung socket is abandoned; an abort counts as a sent request and is never
 * retried. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Explicitly switches the verification budget on with the pinned price and cap.
 * No network, no UI: it only persists the reservation table. */
export function enableJevEvaluationBudget(now = Date.now()): Promise<BudgetStoreResult> {
  return enableEvaluationBudget({ prices: [JEV_PRICE], limits: [JEV_LIMIT], now });
}

/** Switches the budget on with a price row and an isolated cap for every
 * labeller (Jev, OpenAI, DeepSeek). Each model keeps its own spend, reservations
 * and currency. No network, no UI. */
export function enableEvaluationBudgets(now = Date.now()): Promise<BudgetStoreResult> {
  const { prices, limits } = budgetConfigOfAllLabellers();
  return enableEvaluationBudget({ prices, limits, now });
}

/** Everything the caller needs to record one executed judgement. */
export interface JevTrace {
  readonly sampleId: string;
  readonly postId: string;
  readonly threadId: string;
  readonly ruleId: string;
  /** The pinned model requested (`jev-1.13.0`). */
  readonly requestedModel: string;
  /** The model the response reported, or {@link UNKNOWN_MODEL}. */
  readonly answeredModel: string;
  /** `questionsFingerprint` of the exact compiled question sent. */
  readonly rulesFingerprint: string;
  /** `rule.threshold ?? settings.threshold` at call time. */
  readonly threshold: number;
  /** Fingerprint of the exact `(stateJson, question)` pair that was sent. */
  readonly inputHash: string;
  /** The body was already clipped at capture time. */
  readonly truncated: boolean;
  /** Real usage, or `null` when it was never recorded. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Money recorded at settle time in micro-units, or `null`. */
  readonly costMicro: number | null;
  readonly jobId: string;
}

/** Why the slice stopped before sending anything. */
export type JevSkipReason =
  | 'not-authorized'
  | 'no-key'
  | 'sample-not-found'
  | 'not-sendable'
  | 'rule-not-compiled'
  | 'budget-disabled'
  | 'cap-exceeded'
  | 'budget-refused'
  | 'already-recorded'
  | 'job-inactive'
  | 'storage';

/** One sample judged against one rule. `match`/`no-match` carry a usable 0..1
 * score; `undecided` is a sent call with no usable answer; `unknown` is a sent
 * call whose answer or usage was not recorded and whose money stays held. */
export type JevExecutionResult =
  | {
      readonly kind: 'skipped';
      readonly sampleId: string;
      readonly ruleId: string;
      readonly reason: JevSkipReason;
      readonly detail: string;
    }
  | { readonly kind: 'match'; readonly score: number; readonly trace: JevTrace; readonly restored?: true }
  | { readonly kind: 'no-match'; readonly score: number; readonly trace: JevTrace; readonly restored?: true }
  | { readonly kind: 'undecided'; readonly detail: string; readonly trace: JevTrace; readonly restored?: true }
  | { readonly kind: 'unknown'; readonly detail: string; readonly trace: JevTrace };

export interface SingleSampleEvaluationRequest {
  /** Identity of the stored capture sample to judge. */
  readonly sampleId: string;
  /** The enabled semantic rule to ask about. */
  readonly ruleId: string;
  /** Explicit per-call authorization. Anything but `true` means zero network. */
  readonly authorized: boolean;
}

export interface ObservedState {
  readonly handle: string;
  readonly name: string;
  readonly text: string;
  readonly quoted: string | null;
  readonly replyingTo: { readonly author: string; readonly text: string } | null;
}

function stripAt(handle: string): string {
  return handle.startsWith('@') ? handle.slice(1) : handle;
}

/** Parses the sample's own `stateJson` into the exact object that will be sent.
 * The same object is also read locally; nothing is reconstructed or re-ordered,
 * so the request input stays byte-identical to the captured snapshot. */
export function parseStateJson(stateJson: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stateJson);
  } catch {
    return null;
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

/** Reads the known fields out of an already-parsed snapshot for local checks.
 * Anything that is not the known shape is refused instead of guessed at. */
export function observedStateOf(record: Record<string, unknown>): ObservedState | null {
  const author = record.author;
  if (typeof author !== 'object' || author === null) return null;
  const authorRecord = author as Record<string, unknown>;
  const handle = authorRecord.handle;
  const name = authorRecord.name;
  const text = record.text;
  if (typeof handle !== 'string' || typeof name !== 'string' || typeof text !== 'string') return null;
  const quoted = typeof record.quoted === 'string' ? record.quoted : null;
  let replyingTo: ObservedState['replyingTo'] = null;
  const reply = record.replyingTo;
  if (typeof reply === 'object' && reply !== null) {
    const replyRecord = reply as Record<string, unknown>;
    if (typeof replyRecord.author === 'string' && typeof replyRecord.text === 'string') {
      replyingTo = { author: replyRecord.author, text: replyRecord.text };
    }
  }
  return { handle, name, text, quoted, replyingTo };
}

/**
 * Rebuilds the post a stored sample describes, so the same local admissibility
 * rule the capture workflow used can be re-checked. A stored sample already
 * passed the `own` gate when it was captured (a sample stores no `own` field),
 * so this only re-asserts everything else: id/handle shape, non-empty and
 * un-protected text, and bounded context.
 */
export function postOfSample(sample: CaptureSample, state: ObservedState): Post {
  return {
    id: sample.postId,
    kind: state.replyingTo ? 'reply' : 'post',
    parent: state.replyingTo
      ? {
          id: '',
          name: '',
          handle: stripAt(state.replyingTo.author),
          text: state.replyingTo.text,
          avatarUrl: '',
        }
      : null,
    thread: sample.threadId,
    own: false,
    name: state.name,
    handle: stripAt(state.handle),
    time: sample.publishedAt,
    text: state.text,
    promoted: sample.promoted,
    avatarUrl: '',
    imageUrls: [],
    hasVideo: false,
    quotedName: '',
    quotedText: state.quoted ?? '',
    truncated: sample.truncated,
  };
}

export function skipped(
  sampleId: string,
  ruleId: string,
  reason: JevSkipReason,
  detail: string,
): JevExecutionResult {
  return { kind: 'skipped', sampleId, ruleId, reason, detail };
}

export function skipReasonForBudgetError(error: string): JevSkipReason {
  if (error === 'disabled') return 'budget-disabled';
  if (error === 'cap-exceeded') return 'cap-exceeded';
  if (error === 'storage') return 'storage';
  return 'budget-refused';
}

/** Runs one fetch under an abort timer; the timer is always cleared. */
export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') {
    return `request timed out after ${REQUEST_TIMEOUT_MS}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ruleById(settings: Settings, ruleId: string): Rule | undefined {
  return settings.rules.find((rule) => rule.id === ruleId && rule.enabled);
}

/**
 * Rebuilds a complete execution result from a job that was already settled and
 * persisted, so a repeat or a restarted worker gets the real judgement back
 * without a second paid call. Only {@link SettledEvaluationBaseline} records are
 * accepted: a settled-without-result job never yields a result and is reported as
 * a plain dedupe instead, so a held cost can never masquerade as a baseline.
 */
function resultFromBaseline(
  baseline: SettledEvaluationBaseline,
  sample: CaptureSample,
): JevExecutionResult {
  const trace: JevTrace = {
    sampleId: baseline.sampleId,
    postId: sample.postId,
    threadId: sample.threadId,
    ruleId: baseline.ruleId,
    requestedModel: JEV_MODEL,
    answeredModel: baseline.answeredModel ?? UNKNOWN_MODEL,
    rulesFingerprint: baseline.rulesFingerprint,
    threshold: baseline.threshold,
    inputHash: baseline.inputHash,
    truncated: sample.truncated,
    inputTokens: baseline.settledInputTokens,
    outputTokens: baseline.settledOutputTokens,
    costMicro: baseline.settledMicro,
    jobId: baseline.jobId,
  };
  if (baseline.verdict.status !== 'decided') {
    return {
      kind: 'undecided',
      detail: 'the stored result carried no usable answer for this rule',
      trace,
      restored: true,
    };
  }
  const score = baseline.verdict.score;
  return score >= baseline.threshold
    ? { kind: 'match', score, trace, restored: true }
    : { kind: 'no-match', score, trace, restored: true };
}

/**
 * Executes one authorized (sample, rule) evaluation against TypeSafe direct Jev.
 *
 * Order: authorization, key, sample, local admissibility, compiled rule,
 * persisted reservation, then — only after a durable reservation — the network.
 * See the module doc comment for the full boundary list.
 */
export async function runSingleSampleEvaluation(
  request: SingleSampleEvaluationRequest,
): Promise<JevExecutionResult> {
  const { sampleId, ruleId } = request;
  if (request.authorized !== true) {
    return skipped(sampleId, ruleId, 'not-authorized', 'evaluation is not authorized');
  }

  const settings = await loadSettings();
  const key = settings.keys.typesafe.trim();
  if (key === '') return skipped(sampleId, ruleId, 'no-key', 'no TypeSafe key is stored');

  const samples = await loadCaptureSamples();
  const sample = samples.find((candidate) => candidate.sampleId === sampleId);
  if (sample === undefined) {
    return skipped(sampleId, ruleId, 'sample-not-found', 'the sample is not in the capture library');
  }

  const sendState = parseStateJson(sample.stateJson);
  if (sendState === null) {
    return skipped(sampleId, ruleId, 'not-sendable', 'the stored sample state is not readable');
  }
  const state = observedStateOf(sendState);
  if (state === null) {
    return skipped(sampleId, ruleId, 'not-sendable', 'the stored sample state is not readable');
  }
  const post = postOfSample(sample, state);
  const inadmissible = captureSkipReason(post);
  if (inadmissible !== null) {
    return skipped(sampleId, ruleId, 'not-sendable', `sample refused locally: ${inadmissible}`);
  }

  const compiled = compileRules(settings.rules, { hasParent: post.parent !== null });
  const question = compiled.questions[ruleId];
  const rule = ruleById(settings, ruleId);
  if (question === undefined || rule === undefined) {
    return skipped(sampleId, ruleId, 'rule-not-compiled', 'the rule has no applicable compiled question');
  }
  const threshold = rule.threshold ?? settings.threshold;
  const inputHash = fingerprintInput(sample.stateJson, question);

  const started = await startEvaluationJob({
    model: JEV_MODEL,
    rulesFingerprint: compiled.key,
    ruleId,
    inputHash,
    maxOutputTokens: JEV_MAX_OUTPUT_TOKENS,
    sampleId,
    threshold,
  });
  if (!started.ok) {
    return skipped(sampleId, ruleId, skipReasonForBudgetError(started.error), started.detail);
  }
  if (started.deduped) {
    // A repeat is never sent again. If the earlier run persisted a real verdict,
    // return that baseline from `storage.local` instead of losing it; a
    // pending/unknown/settled-without-result job has no baseline to restore.
    const baseline = settledBaselineOf(started.job);
    if (baseline) return resultFromBaseline(baseline, sample);
    return skipped(
      sampleId,
      ruleId,
      'already-recorded',
      started.job.status === 'settled'
        ? 'this exact task settled without a recorded verdict; it is never sent twice'
        : 'this exact task is already recorded; it is never sent twice',
    );
  }

  const job = started.job;
  const trace: JevTrace = {
    sampleId,
    postId: sample.postId,
    threadId: sample.threadId,
    ruleId,
    requestedModel: JEV_MODEL,
    answeredModel: UNKNOWN_MODEL,
    rulesFingerprint: compiled.key,
    threshold,
    inputHash,
    truncated: sample.truncated,
    inputTokens: null,
    outputTokens: null,
    costMicro: null,
    jobId: job.jobId,
  };

  /** A sent call with no recorded answer keeps its reservation; never retried. */
  const abandonUnknown = async (detail: string): Promise<JevExecutionResult> => {
    await abandonEvaluationJob({ jobId: job.jobId, epoch: job.epoch, sent: true });
    return { kind: 'unknown', detail, trace };
  };

  // Fail closed: between reserving and sending, a stop or a delete may have run.
  // Re-confirm on the serial write chain that this exact pending job is still
  // active; if not, send nothing. Its money stays held by the stop/clear above.
  const active = await recheckActiveEvaluationJob(job.jobId, job.epoch);
  if (!active.ok) {
    return skipped(sampleId, ruleId, 'job-inactive', `request not sent: ${active.detail}`);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(JEV_REQUEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: sendState,
        questions: questionsAs({ [ruleId]: question }, 'noul'),
      }),
    });
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

  // Real usage is required. A missing or malformed count means the cost is
  // unknown, so the reservation is kept rather than settled against a guess.
  const usage = readUsage(json, { inputTokens: 'input_tokens', outputTokens: 'output_tokens' });
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return abandonUnknown('the response did not report usable token usage');
  }

  // The verdict is read and then written in the same transaction as the money,
  // so a settled job can never record a cost while losing what the model
  // answered. `undecided` is a real recorded outcome, never a silent negative.
  const responseModel = readModel(json) ?? null;
  const score = scoresFrom(json, 'noul')[ruleId];
  const verdict: JobVerdict = isValidScore(score)
    ? { status: 'decided', score }
    : { status: 'undecided' };

  const settled = await settleEvaluationJob({
    jobId: job.jobId,
    epoch: job.epoch,
    actualInputTokens: usage.inputTokens,
    actualOutputTokens: usage.outputTokens,
    sampleId,
    threshold,
    answeredModel: responseModel,
    verdict,
  });
  if (!settled.ok) {
    // The budget moved (stop/clear) while the call was in flight. The answer is
    // real but may not be written; do not retry and keep the money held.
    return { kind: 'unknown', detail: `settlement refused: ${settled.error}`, trace };
  }

  const recorded: JevTrace = {
    ...trace,
    answeredModel: settled.job.answeredModel ?? UNKNOWN_MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicro: settled.job.settledMicro,
  };

  if (verdict.status === 'undecided') {
    return { kind: 'undecided', detail: 'the response carried no usable answer for this rule', trace: recorded };
  }
  return verdict.score >= threshold
    ? { kind: 'match', score: verdict.score, trace: recorded }
    : { kind: 'no-match', score: verdict.score, trace: recorded };
}