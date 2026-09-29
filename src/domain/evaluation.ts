import { hashString } from './rule';

/**
 * Phase 1 contract for real quality evaluation: the vocabulary for one sample
 * judged against one rule, plus one pure counter. Offline only — no network, no
 * secret, no storage call. `scripts/eval-rules.mjs` is deliberately untouched.
 */

/** `random` samples estimate population rates; `hard` samples must be reported
 * on their own and never averaged with them. */
export type SampleSource = 'random' | 'hard';

/** Rule tuning may only use `dev`; `holdout` stays untouched by those edits. */
export type SampleSplit = 'dev' | 'holdout';

/** The three label states shared by every labeller. */
export type LabelState = 'match' | 'no-match' | 'undecided';

/** Jev's outcome; `error` is a failed call, not a label. */
export type JevStatus = LabelState | 'error';

/** Alias to report when the provider does not say which model answered. */
export const UNKNOWN_MODEL = 'unknown';

/** The rules-and-model configuration a judgement is compared against. */
export interface EvaluationConfig {
  /** `questionsFingerprint` of the exact questions sent. */
  rulesFingerprint: string;
  /** Provider/model actually used, or {@link UNKNOWN_MODEL}. */
  model: string;
  threshold: number;
}

export function configFingerprint(config: EvaluationConfig): string {
  return hashString(JSON.stringify([config.rulesFingerprint, config.model, config.threshold]));
}

/** The exact model input for one rule: the serialized state actually sent
 * (author, quoted and replyingTo context) and the question, plus a fingerprint
 * of that same pair so a changed input can be detected. `hashString` is a
 * non-cryptographic fingerprint, not a secure hash. */
export interface SampleInput {
  stateJson: string;
  question: string;
  inputHash: string;
  truncated: boolean;
}

export function fingerprintInput(stateJson: string, question: string): string {
  return hashString(JSON.stringify([stateJson, question]));
}

/** Jev's outcome for one rule. `match`/`no-match` carry a score that must be a
 * finite 0..1 to count as a decision; `undecided` may omit it (no score is a
 * valid "no answer"); `error` carries a detail and never a fabricated score. */
export type JevJudgement =
  | { status: 'match' | 'no-match'; score: number; model: string; tokens: number }
  | { status: 'undecided'; score?: number; model: string; tokens: number }
  | { status: 'error'; detail: string; model: string; tokens: number };

/** A usable probability: finite and within 0..1. */
export function isValidScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Candidate from one independent non-Jev model. Never human confirmation. */
export interface MachineLabel {
  source: 'machine';
  modelId: string;
  state: LabelState;
  reason: string;
}

/** Human tri-state confirmation with its reason. */
export interface HumanLabel {
  source: 'human';
  state: LabelState;
  reason: string;
}

export function isLabelState(value: unknown): value is LabelState {
  return value === 'match' || value === 'no-match' || value === 'undecided';
}

/** True only for a human-confirmed label; a machine candidate is rejected. */
export function isHumanLabel(value: unknown): value is HumanLabel {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.source === 'human' && isLabelState(record.state) && typeof record.reason === 'string';
}

/** The unit of counting: one sample judged against exactly one rule, so
 * overlapping rules stay separate records instead of being merged. */
export interface RuleEvaluation {
  sampleId: string;
  postId: string;
  threadId: string;
  source: SampleSource;
  split: SampleSplit;
  config: EvaluationConfig;
  ruleId: string;
  input: SampleInput;
  jev: JevJudgement;
  human: HumanLabel | null;
  machine: readonly MachineLabel[];
}

export interface EvaluationCounts {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** Human match, Jev undecided: not recovered, kept apart from `fn`. */
  undecidedPositives: number;
  /** Human no-match, Jev undecided. */
  undecidedNegatives: number;
  /** Human match, the call errored: not recovered, not a negative. */
  errorPositives: number;
  /** Human no-match, the call errored. */
  errorNegatives: number;
  /** Human marked undecided: excluded from every metric. */
  humanUndecided: number;
  /** No human label: excluded from every metric. */
  unreviewed: number;
  precisionDenominator: number;
  recallDenominator: number;
  precision: number | null;
  recall: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function groupKey(record: RuleEvaluation): string {
  return `${record.ruleId}|${record.source}|${record.split}|${configFingerprint(record.config)}`;
}

/**
 * Counts records that already share one rule, one rules/model config and one
 * sample source and split. Mixing any of them is rejected outright, so the
 * caller must group first and random/hard or dev/holdout can never be averaged
 * silently. Only a human-confirmed, decided label enters a rate; Jev undecided
 * and error stay separate from no-match, and a human undecided label is never
 * forced into one. A `match`/`no-match` whose score is not a finite 0..1 is
 * treated as undecided, so a bad score can never be counted as a hit or a
 * normal non-match.
 */
export function countEvaluation(records: readonly RuleEvaluation[]): EvaluationCounts {
  if (records.length > 0) {
    const expected = groupKey(records[0]);
    for (const record of records) {
      if (groupKey(record) !== expected) {
        throw new Error(
          'countEvaluation received more than one group; group by ruleId, source, split and config first',
        );
      }
    }
  }

  const counts: EvaluationCounts = {
    tp: 0,
    fp: 0,
    tn: 0,
    fn: 0,
    undecidedPositives: 0,
    undecidedNegatives: 0,
    errorPositives: 0,
    errorNegatives: 0,
    humanUndecided: 0,
    unreviewed: 0,
    precisionDenominator: 0,
    recallDenominator: 0,
    precision: null,
    recall: null,
  };

  for (const record of records) {
    const human = isHumanLabel(record.human) ? record.human : null;
    if (human === null) {
      counts.unreviewed += 1;
      continue;
    }
    if (human.state === 'undecided') {
      counts.humanUndecided += 1;
      continue;
    }
    const positive = human.state === 'match';
    switch (record.jev.status) {
      case 'match':
      case 'no-match': {
        // A decided status with a missing or out-of-range score is not usable:
        // it is counted as undecided (still a recall miss for a positive) and
        // can never be a hit or a normal non-match.
        if (!isValidScore(record.jev.score)) {
          if (positive) counts.undecidedPositives += 1;
          else counts.undecidedNegatives += 1;
          break;
        }
        const matched = record.jev.score >= record.config.threshold;
        if ((record.jev.status === 'match') !== matched) {
          throw new Error('Jev decision does not match its score and threshold');
        }
        if (positive) {
          if (matched) counts.tp += 1;
          else counts.fn += 1;
        } else if (matched) {
          counts.fp += 1;
        } else {
          counts.tn += 1;
        }
        break;
      }
      case 'undecided':
        if (positive) counts.undecidedPositives += 1;
        else counts.undecidedNegatives += 1;
        break;
      case 'error':
        if (positive) counts.errorPositives += 1;
        else counts.errorNegatives += 1;
        break;
    }
  }

  counts.precisionDenominator = counts.tp + counts.fp;
  counts.recallDenominator =
    counts.tp + counts.fn + counts.undecidedPositives + counts.errorPositives;
  counts.precision = ratio(counts.tp, counts.precisionDenominator);
  counts.recall = ratio(counts.tp, counts.recallDenominator);
  return counts;
}