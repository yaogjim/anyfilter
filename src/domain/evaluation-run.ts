import type { CaptureOutcome, CaptureSample } from './capture';
import { fingerprintInput } from './evaluation';
import {
  openJobs,
  reservedMicroOf,
  settledBaselines,
  type EvaluationJobState,
  type JobVerdict,
} from './evaluation-budget';
import { budgetConfigOfAllLabellers, isLabellerId, PRICING_CHECKED_ON, labellerOfModelName, type LabellerId } from './evaluation-pricing';
import type { BatchHaltReason, BatchProgress } from './evaluation-batch';
import { compileRules } from './rule-compiler';
import type { Settings } from './settings';

/**
 * Shared shapes for running a labeller over the whole capture library and for
 * exporting the outcome. Pure.
 */

export interface EvaluationRunStatus {
  readonly running: boolean;
  readonly labeller: LabellerId | null;
  readonly progress: BatchProgress | null;
  readonly startedAt: number | null;
}

export type EvaluationRunStartResult =
  | { readonly ok: true; readonly status: EvaluationRunStatus }
  | { readonly ok: false; readonly detail: string; readonly status: EvaluationRunStatus };

const HALT_REASONS: readonly BatchHaltReason[] = [
  'budget',
  'key',
  'storage',
  'stopped',
  'failures',
  'ceiling',
  'inactive',
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isBatchProgress(value: unknown): value is BatchProgress {
  const r = record(value);
  return (
    r !== null &&
    count(r.total) &&
    count(r.started) &&
    count(r.recorded) &&
    count(r.repeats) &&
    count(r.skipped) &&
    count(r.failed) &&
    (r.halted === null || HALT_REASONS.some((reason) => reason === r.halted)) &&
    typeof r.haltDetail === 'string' &&
    typeof r.finished === 'boolean'
  );
}

export function isEvaluationRunStatus(value: unknown): value is EvaluationRunStatus {
  const r = record(value);
  return (
    r !== null &&
    typeof r.running === 'boolean' &&
    (r.labeller === null || isLabellerId(r.labeller)) &&
    (r.progress === null || isBatchProgress(r.progress)) &&
    (r.startedAt === null || count(r.startedAt))
  );
}

export function isEvaluationRunStartResult(value: unknown): value is EvaluationRunStartResult {
  const r = record(value);
  if (r === null) return false;
  if (r.ok === true) return isEvaluationRunStatus(r.status);
  return r.ok === false && typeof r.detail === 'string' && isEvaluationRunStatus(r.status);
}

export function idleRunStatus(): EvaluationRunStatus {
  return { running: false, labeller: null, progress: null, startedAt: null };
}

/** The spending picture of one labeller. Money is integer micro-units of that
 * labeller's own currency; nothing is summed across models. */
export interface LabellerSpend {
  readonly labeller: LabellerId;
  readonly model: string;
  readonly currency: string;
  readonly capMicro: number | null;
  readonly spentMicro: number;
  readonly reservedMicro: number;
  readonly availableMicro: number | null;
  readonly settledJobs: number;
  readonly heldJobs: number;
}

export function isLabellerSpend(value: unknown): value is LabellerSpend {
  const r = record(value);
  return (
    r !== null &&
    isLabellerId(r.labeller) &&
    typeof r.model === 'string' &&
    typeof r.currency === 'string' &&
    (r.capMicro === null || count(r.capMicro)) &&
    count(r.spentMicro) &&
    count(r.reservedMicro) &&
    (r.availableMicro === null || typeof r.availableMicro === 'number') &&
    count(r.settledJobs) &&
    count(r.heldJobs)
  );
}

export function spendOf(
  state: EvaluationJobState,
  archived: Readonly<Record<string, number>> = {},
): readonly LabellerSpend[] {
  // One row per priced model, in catalog order: each model has its own cap.
  return budgetConfigOfAllLabellers().prices.flatMap((price) => {
    const labeller = labellerOfModelName(price.model);
    if (labeller === null) return [];
    const limit = state.limits.find((row) => row.model === price.model) ?? null;
    const row = state.prices.find((candidate) => candidate.model === price.model) ?? null;
    const spent = state.spentMicro[price.model] ?? 0;
    const reserved = reservedMicroOf(state, price.model);
    const jobs = state.jobs.filter((job) => job.model === price.model);
    return [
      {
        labeller,
        model: price.model,
        currency: limit?.currency ?? row?.currency ?? price.currency,
        capMicro: limit?.capMicro ?? null,
        spentMicro: spent,
        reservedMicro: reserved,
        availableMicro: limit === null ? null : limit.capMicro - spent - reserved,
        // Answers shed from the job store live on in the archive; the larger of the
        // two counts is the real number of answers, plus settlements with no answer.
        settledJobs:
          Math.max(archived[price.model] ?? 0, jobs.filter((job) => job.status === 'settled' && job.verdict !== null).length) +
          jobs.filter((job) => job.status === 'settled' && job.verdict === null).length,
        heldJobs: jobs.filter((job) => job.status === 'pending' || job.status === 'unknown').length,
      },
    ];
  });
}

/** Everything the panel needs in one read: the spending picture per labeller. */
export interface EvaluationOverview {
  /** On, with a price and cap row for every priced model. */
  readonly enabled: boolean;
  /** On, but written before some models had rows (for example Jev only). Turning
   * the budget on again adds the missing rows without touching any spend. */
  readonly partial: boolean;
  readonly spend: readonly LabellerSpend[];
  readonly openJobs: number;
  readonly sampleCount: number;
  readonly ruleCount: number;
}

export function isEvaluationOverview(value: unknown): value is EvaluationOverview {
  const r = record(value);
  return (
    r !== null &&
    typeof r.enabled === 'boolean' &&
    typeof r.partial === 'boolean' &&
    Array.isArray(r.spend) &&
    r.spend.every(isLabellerSpend) &&
    count(r.openJobs) &&
    count(r.sampleCount) &&
    count(r.ruleCount)
  );
}

export function overviewOf(
  state: EvaluationJobState,
  sampleCount: number,
  ruleCount: number,
  archived: Readonly<Record<string, number>> = {},
): EvaluationOverview {
  const { prices } = budgetConfigOfAllLabellers();
  const complete = prices.every(
    (price) =>
      state.prices.some((row) => row.model === price.model) && state.limits.some((row) => row.model === price.model),
  );
  return {
    enabled: state.enabled && complete,
    partial: state.enabled && !complete,
    spend: spendOf(state, archived),
    openJobs: openJobs(state).length,
    sampleCount,
    ruleCount,
  };
}

/* ------------------------------------------------------------------ export */

export const EVALUATION_EXPORT_VERSION = 1;

export interface ExportSample {
  readonly sampleId: string;
  readonly postId: string;
  readonly threadId: string;
  readonly inputHash: string;
  /** The exact stored state. Private: it contains the post text. */
  readonly stateJson: string;
  readonly truncated: boolean;
  readonly promoted: boolean;
  readonly capturedAt: number;
  readonly page: string;
  /** What the production feed did with this exact input, if it saw it. */
  readonly observed: readonly CaptureOutcome[];
}

export interface ExportResult {
  readonly labeller: LabellerId;
  readonly model: string;
  readonly answeredModel: string | null;
  /** The sample the task was first run for. */
  readonly sampleId: string;
  /** Every stored sample whose input for this rule is byte-identical, so one
   * answer covers all of them. Always includes `sampleId` when it is stored. */
  readonly sampleIds: readonly string[];
  readonly ruleId: string;
  readonly inputHash: string;
  readonly rulesFingerprint: string;
  readonly threshold: number;
  readonly verdict: JobVerdict;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicro: number;
}

export interface ExportFailure {
  readonly labeller: LabellerId;
  readonly model: string;
  readonly sampleId: string | null;
  readonly ruleId: string;
  readonly status: 'pending' | 'unknown' | 'settled-no-answer';
  readonly reservedMicro: number;
}

export interface ExportRule {
  readonly id: string;
  readonly label: string;
  readonly threshold: number;
  /** Compiled question for a post with a parent and for one without. Absent when
   * the rule does not apply in that context. */
  readonly questionWithParent: string | null;
  readonly questionWithoutParent: string | null;
}

export interface EvaluationExport {
  readonly version: typeof EVALUATION_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly pricingCheckedOn: string;
  readonly containsPostText: true;
  readonly rulesFingerprintWithParent: string;
  readonly rulesFingerprintWithoutParent: string;
  readonly rules: readonly ExportRule[];
  readonly samples: readonly ExportSample[];
  readonly results: readonly ExportResult[];
  readonly failures: readonly ExportFailure[];
  readonly spend: readonly LabellerSpend[];
}

/** Same test the executors use: a post has a parent when its state names one. */
function hasParentContext(stateJson: string): boolean {
  try {
    const reply = (JSON.parse(stateJson) as Record<string, unknown>).replyingTo;
    if (typeof reply !== 'object' || reply === null) return false;
    const record = reply as Record<string, unknown>;
    return typeof record.author === 'string' && typeof record.text === 'string';
  } catch {
    return false;
  }
}

function labellerOfModel(model: string): LabellerId | null {
  return labellerOfModelName(model);
}

/** Builds the export from stored facts only. Results are the settled baselines
 * that carry a real answer; a held or answerless job is listed as a failure and
 * never as a result. */
export function buildEvaluationExport(
  samples: readonly CaptureSample[],
  state: EvaluationJobState,
  settings: Settings,
  exportedAt: string,
): EvaluationExport {
  const withParent = compileRules(settings.rules, { hasParent: true });
  const withoutParent = compileRules(settings.rules, { hasParent: false });
  const rules: ExportRule[] = settings.rules
    .filter((rule) => rule.enabled && rule.kind === 'semantic')
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      threshold: rule.threshold ?? settings.threshold,
      questionWithParent: withParent.questions[rule.id] ?? null,
      questionWithoutParent: withoutParent.questions[rule.id] ?? null,
    }));

  const identical = new Map<string, string[]>();
  for (const sample of samples) {
    const compiled = hasParentContext(sample.stateJson) ? withParent : withoutParent;
    for (const rule of rules) {
      const question = compiled.questions[rule.id];
      if (question === undefined) continue;
      const key = `${rule.id}|${fingerprintInput(sample.stateJson, question)}`;
      (identical.get(key) ?? identical.set(key, []).get(key)!).push(sample.sampleId);
    }
  }

  const results: ExportResult[] = [];
  for (const baseline of settledBaselines(state)) {
    const labeller = labellerOfModel(baseline.model);
    if (labeller === null) continue;
    results.push({
      labeller,
      model: baseline.model,
      answeredModel: baseline.answeredModel,
      sampleId: baseline.sampleId,
      sampleIds: identical.get(`${baseline.ruleId}|${baseline.inputHash}`) ?? [baseline.sampleId],
      ruleId: baseline.ruleId,
      inputHash: baseline.inputHash,
      rulesFingerprint: baseline.rulesFingerprint,
      threshold: baseline.threshold,
      verdict: baseline.verdict,
      inputTokens: baseline.settledInputTokens,
      outputTokens: baseline.settledOutputTokens,
      costMicro: baseline.settledMicro,
    });
  }
  const failures: ExportFailure[] = [];
  for (const job of state.jobs) {
    const labeller = labellerOfModel(job.model);
    if (labeller === null) continue;
    if (job.status === 'settled') {
      if (job.verdict !== null) continue;
      failures.push({
        labeller,
        model: job.model,
        sampleId: job.sampleId,
        ruleId: job.ruleId,
        status: 'settled-no-answer',
        reservedMicro: job.reservedMicro,
      });
    } else {
      failures.push({
        labeller,
        model: job.model,
        sampleId: job.sampleId,
        ruleId: job.ruleId,
        status: job.status,
        reservedMicro: job.reservedMicro,
      });
    }
  }

  return {
    version: EVALUATION_EXPORT_VERSION,
    exportedAt,
    pricingCheckedOn: PRICING_CHECKED_ON,
    containsPostText: true,
    rulesFingerprintWithParent: withParent.key,
    rulesFingerprintWithoutParent: withoutParent.key,
    rules,
    samples: samples.map((sample) => ({
      sampleId: sample.sampleId,
      postId: sample.postId,
      threadId: sample.threadId,
      inputHash: sample.inputHash,
      stateJson: sample.stateJson,
      truncated: sample.truncated,
      promoted: sample.promoted,
      capturedAt: sample.capturedAt,
      page: sample.page,
      observed: sample.outcomes ?? [],
    })),
    results,
    failures,
    spend: spendOf(state),
  };
}
