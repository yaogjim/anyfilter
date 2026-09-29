import {
  configFingerprint,
  countEvaluation,
  isHumanLabel,
  type EvaluationCounts,
  type RuleEvaluation,
  type SampleSource,
  type SampleSplit,
} from '../domain/evaluation';

/**
 * Pure statistics over recorded per-rule evaluations.
 *
 * Offline and side-effect free: no network, no storage, no clock and no
 * randomisation, so the same records always produce the same numbers. This
 * module only *describes* a sample. It never asserts that a rule has met a 95%
 * or 90% target, and a machine candidate is never treated as ground truth.
 *
 * Records are grouped by rule, sample source, split and configuration before
 * counting, so random/hard and dev/holdout can never be averaged and a rule
 * tuned on `dev` can never leak into its `holdout` numbers.
 */

/** A two-sided Wilson score interval. */
export interface WilsonInterval {
  readonly low: number;
  readonly high: number;
}

/** z for a 95% two-sided interval. */
export const WILSON_Z_95 = 1.96;

/**
 * Conservative floor before a rate is treated as reportable. A handful of
 * fixtures can produce a point estimate of 1.0 that says nothing; below this
 * many effective samples the estimate is flagged insufficient.
 */
export const DEFAULT_MIN_SAMPLES = 20;

/**
 * Wilson score interval (the standard small-sample interval for a binomial
 * proportion). Returns `null` when there is no usable denominator or when the
 * arguments are not a valid count, rather than inventing a bound.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z: number = WILSON_Z_95,
): WilsonInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total)) return null;
  if (total <= 0 || successes < 0 || successes > total) return null;
  if (!Number.isFinite(z) || z <= 0) return null;

  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);

  return {
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * One rate with its effective denominator. `denominator` is exactly the count
 * of records that entered the rate, so a caller can reconcile it against
 * {@link EvaluationMetrics.excluded}. `sufficient` is the only signal a caller
 * may gate a claim on: it is false when the denominator is empty, when a rate
 * has no opposed cases, or when it is below `minSamples`.
 */
export interface RateEstimate {
  /** `successes / denominator`, or `null` when the denominator is 0. */
  readonly point: number | null;
  /** Wilson 95% interval, or `null` when the denominator is 0. */
  readonly interval: WilsonInterval | null;
  readonly successes: number;
  readonly denominator: number;
  readonly sufficient: boolean;
  /** Why the estimate is not sufficient; empty when it is. */
  readonly reasons: readonly string[];
}

/** The identity of one group: nothing is ever averaged across these fields. */
export interface EvaluationGroupKey {
  readonly ruleId: string;
  readonly source: SampleSource;
  readonly split: SampleSplit;
  readonly configFingerprint: string;
}

/** Records left out of every rate, listed so nothing is silently dropped. */
export interface EvaluationExcluded {
  readonly undecidedPositives: number;
  readonly undecidedNegatives: number;
  readonly errorPositives: number;
  readonly errorNegatives: number;
  /** Human marked undecided: excluded from every metric. */
  readonly humanUndecided: number;
  /** No human label: candidate machines cannot stand in for one. */
  readonly unreviewed: number;
  /** Subset of `unreviewed` that has machine candidates but no human label. */
  readonly machineOnly: number;
}

export interface EvaluationMetrics {
  readonly key: EvaluationGroupKey;
  readonly counts: EvaluationCounts;
  /** `tp / (tp + fp)`; requires at least one human-confirmed negative to mean anything. */
  readonly precision: RateEstimate;
  /** `tp / recallDenominator`, where undecided/error positives still count against it. */
  readonly recall: RateEstimate;
  readonly excluded: EvaluationExcluded;
  /** Records actually counted, after duplicate sample ids were dropped. */
  readonly total: number;
  /** Records dropped because their `sampleId` repeated inside this group. */
  readonly duplicatesDropped: number;
  /** `present` only when both rates are sufficient. Never a pass/fail verdict. */
  readonly evidence: 'insufficient' | 'present';
  /** Union of the per-rate insufficiencies, de-duplicated. */
  readonly reasons: readonly string[];
}

export interface SummariseOptions {
  /** Minimum effective denominator before a rate is reportable. */
  readonly minSamples?: number;
}

interface Bucket {
  readonly order: string;
  readonly key: EvaluationGroupKey;
  readonly records: RuleEvaluation[];
  readonly seenSampleIds: Set<string>;
  duplicatesDropped: number;
}

function groupOrder(ruleId: string, source: string, split: string, fingerprint: string): string {
  return `${ruleId}|${source}|${split}|${fingerprint}`;
}

function rateEstimate(
  successes: number,
  denominator: number,
  minSamples: number,
  blocked: readonly string[],
): RateEstimate {
  const reasons: string[] = [...blocked];
  if (denominator > 0 && denominator < minSamples) {
    reasons.push(`sample below minimum: ${denominator} < ${minSamples}`);
  }
  return {
    point: denominator === 0 ? null : successes / denominator,
    interval: wilsonInterval(successes, denominator),
    successes,
    denominator,
    sufficient: denominator > 0 && reasons.length === 0,
    reasons,
  };
}

function buildMetrics(bucket: Bucket, minSamples: number): EvaluationMetrics {
  const records = bucket.records;
  const counts = countEvaluation(records);

  // Human negatives are what makes a false positive possible, so precision
  // without any of them is a degenerate 1.0 and must not be reported.
  const humanNegatives =
    counts.tn + counts.fp + counts.undecidedNegatives + counts.errorNegatives;

  const precisionBlocked: string[] = [];
  if (counts.precisionDenominator === 0) {
    precisionBlocked.push('no decided positive claim: precision denominator is 0');
  } else if (humanNegatives === 0) {
    precisionBlocked.push('no human-confirmed negative: precision cannot be estimated');
  }

  const recallBlocked: string[] = [];
  if (counts.recallDenominator === 0) {
    recallBlocked.push('no human-confirmed positive: recall denominator is 0');
  }

  const precision = rateEstimate(
    counts.tp,
    counts.precisionDenominator,
    minSamples,
    precisionBlocked,
  );
  const recall = rateEstimate(counts.tp, counts.recallDenominator, minSamples, recallBlocked);

  const reasons = [...new Set([...precision.reasons, ...recall.reasons])];

  return {
    key: bucket.key,
    counts,
    precision,
    recall,
    excluded: {
      undecidedPositives: counts.undecidedPositives,
      undecidedNegatives: counts.undecidedNegatives,
      errorPositives: counts.errorPositives,
      errorNegatives: counts.errorNegatives,
      humanUndecided: counts.humanUndecided,
      unreviewed: counts.unreviewed,
      machineOnly: records.filter(
        (record) => !isHumanLabel(record.human) && record.machine.length > 0,
      ).length,
    },
    total: records.length,
    duplicatesDropped: bucket.duplicatesDropped,
    evidence: precision.sufficient && recall.sufficient ? 'present' : 'insufficient',
    reasons,
  };
}

/**
 * Groups evaluations by rule + source + split + configuration and returns one
 * statistics block per group. Nothing is aggregated across groups.
 *
 * A repeated `sampleId` inside one group is dropped and counted in
 * `duplicatesDropped` instead of inflating a rate; the same `sampleId` under a
 * different rule stays a separate record, because the same post can legitimately
 * be judged against several rules.
 */
export function summariseEvaluation(
  records: readonly RuleEvaluation[],
  options: SummariseOptions = {},
): readonly EvaluationMetrics[] {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error('minSamples must be a positive integer');
  }

  const buckets = new Map<string, Bucket>();
  for (const record of records) {
    const fingerprint = configFingerprint(record.config);
    const order = groupOrder(record.ruleId, record.source, record.split, fingerprint);
    let bucket = buckets.get(order);
    if (bucket === undefined) {
      bucket = {
        order,
        key: {
          ruleId: record.ruleId,
          source: record.source,
          split: record.split,
          configFingerprint: fingerprint,
        },
        records: [],
        seenSampleIds: new Set(),
        duplicatesDropped: 0,
      };
      buckets.set(order, bucket);
    }
    if (bucket.seenSampleIds.has(record.sampleId)) {
      bucket.duplicatesDropped += 1;
      continue;
    }
    bucket.seenSampleIds.add(record.sampleId);
    bucket.records.push(record);
  }

  return [...buckets.values()]
    .sort((left, right) => (left.order < right.order ? -1 : left.order > right.order ? 1 : 0))
    .map((bucket) => buildMetrics(bucket, minSamples));
}