import {
  MAX_CONTEXT_LENGTH,
  MAX_HANDLE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_POST_ID_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_THREAD_ID_LENGTH,
} from './capture';
import type { ReviewSnapshot, ReviewState, UndecidedReason } from './review';

/**
 * Human annotations made inside the timeline while review mode is on.
 *
 * They are hinted data: the person saw the model's judgement while deciding, so
 * `source` is fixed to `in-timeline-assisted` and these records can never stand
 * in for the blind review or become a model's answer key.
 */
export type ReviewOverall = 'hide' | 'keep' | 'uncertain';
export type ReviewRuleLabel = 'match' | 'no-match' | 'insufficient';

export const REVIEW_SOURCE = 'in-timeline-assisted';
export const MAX_REVIEW_RECORDS = 1000;
export const MAX_REVIEW_RULES = 100;
export const MAX_NO_RULE_REASON_LENGTH = 280;
/** Longest stored post text: the captured body plus its quote and parent
 * context, plus the fixed JSON scaffolding around them. */
export const MAX_REVIEW_STATE_LENGTH =
  MAX_TEXT_LENGTH + MAX_CONTEXT_LENGTH * 2 + MAX_NAME_LENGTH * 2 + 4 * MAX_HANDLE_LENGTH + 400;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OVERALLS: readonly ReviewOverall[] = ['hide', 'keep', 'uncertain'];
const RULE_LABELS: readonly ReviewRuleLabel[] = ['match', 'no-match', 'insufficient'];
const STATES: readonly ReviewState[] = ['kept', 'flagged', 'undecided'];
const UNDECIDED: readonly UndecidedReason[] = ['pending', 'failed', 'missing-answer', 'no-context'];

/** The label a given overall verdict can attach to a rule. */
export const RULE_LABEL_OF: Readonly<Record<ReviewOverall, ReviewRuleLabel>> = {
  hide: 'match',
  keep: 'no-match',
  uncertain: 'insufficient',
};

export interface ReviewRuleSummary {
  ruleId: string;
  score: number | null;
  threshold: number | null;
  hit: boolean;
}

/** What the feed had decided when the person annotated. */
export interface ReviewSnapshotSummary {
  state: ReviewState;
  direct: boolean;
  undecidedReason?: UndecidedReason;
  rulesFingerprint: string;
  rules: ReviewRuleSummary[];
}

export interface ReviewRuleTag {
  ruleId: string;
  label: ReviewRuleLabel;
}

/** What a content script may ask the background to store. */
export interface ReviewSaveInput {
  sampleId: string;
  inputHash: string;
  postId: string;
  threadId: string;
  /** `null` when only the "worth reading" flag is set. */
  overall: ReviewOverall | null;
  /** Only the rules the person actually ticked. A rule that is not listed was
   * not judged, and is never read as "did not match". */
  rules: ReviewRuleTag[];
  /** "No existing rule covers it": one sentence why. Only with `hide`, and only
   * when no rule is ticked. */
  noRuleCovers?: string;
  valuable: boolean;
  snapshot: ReviewSnapshotSummary;
  /** The exact model input (`observedStateJson`) the person judged. */
  stateJson: string;
}

export interface ReviewRecord extends ReviewSaveInput {
  /** Bumps on every correction of the same annotation. */
  revision: number;
  source: typeof REVIEW_SOURCE;
  at: number;
}

export type ReviewSaveError =
  | 'wrong-sender'
  | 'stale-epoch'
  | 'invalid'
  | 'full'
  | 'too-long'
  | 'storage';

export type ReviewSaveResult =
  | { ok: true; record: ReviewRecord | null; count: number }
  | { ok: false; error: ReviewSaveError; detail: string };

export type ReviewLoadResult =
  | { ok: true; epoch: number; records: ReviewRecord[] }
  | { ok: false; error: ReviewSaveError; detail: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function boundedString(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value !== '');
}

/** Identity of one annotation: the post as it was read, judged against one rule
 * set. A different text or a different rule set is a different annotation. */
export function recordKey(sampleId: string, inputHash: string, rulesFingerprint: string): string {
  return JSON.stringify([sampleId, inputHash, rulesFingerprint]);
}

export function recordKeyOf(record: ReviewSaveInput): string {
  return recordKey(record.sampleId, record.inputHash, record.snapshot.rulesFingerprint);
}

export function snapshotKey(snapshot: ReviewSnapshot): string {
  return recordKey(snapshot.sampleId, snapshot.inputHash, snapshot.rulesFingerprint);
}

/** The compact summary stored next to an annotation. */
export function summarize(snapshot: ReviewSnapshot): ReviewSnapshotSummary {
  return {
    state: snapshot.state,
    direct: snapshot.direct,
    ...(snapshot.undecidedReason ? { undecidedReason: snapshot.undecidedReason } : {}),
    rulesFingerprint: snapshot.rulesFingerprint,
    rules: snapshot.rules.map((rule) => ({
      ruleId: rule.ruleId,
      score: rule.score,
      threshold: rule.threshold,
      hit: rule.hit,
    })),
  };
}

function isRuleSummary(value: unknown): value is ReviewRuleSummary {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.ruleId === 'string' &&
    ID_PATTERN.test(record.ruleId) &&
    (record.score === null || (typeof record.score === 'number' && Number.isFinite(record.score))) &&
    (record.threshold === null ||
      (typeof record.threshold === 'number' && Number.isFinite(record.threshold))) &&
    typeof record.hit === 'boolean'
  );
}

function isSnapshotSummary(value: unknown): value is ReviewSnapshotSummary {
  const record = asRecord(value);
  if (!record) return false;
  return (
    STATES.some((state) => state === record.state) &&
    typeof record.direct === 'boolean' &&
    (record.undecidedReason === undefined || UNDECIDED.some((reason) => reason === record.undecidedReason)) &&
    boundedString(record.rulesFingerprint, 64, false) &&
    Array.isArray(record.rules) &&
    record.rules.length <= MAX_REVIEW_RULES &&
    record.rules.every(isRuleSummary)
  );
}

/** Validates the annotation a content script sends. Everything is bounded, and
 * the logical rules of an annotation are enforced here so no caller can store a
 * hide verdict without saying which rule (or that none covers it). */
export function isReviewSaveInput(value: unknown): value is ReviewSaveInput {
  const record = asRecord(value);
  if (!record) return false;
  if (!boundedString(record.sampleId, MAX_POST_ID_LENGTH + 20, false)) return false;
  if (!boundedString(record.inputHash, 32, false)) return false;
  if (!boundedString(record.postId, MAX_POST_ID_LENGTH, false)) return false;
  if (!boundedString(record.threadId, MAX_THREAD_ID_LENGTH)) return false;
  if (typeof record.valuable !== 'boolean') return false;
  if (!boundedString(record.stateJson, MAX_REVIEW_STATE_LENGTH, false)) return false;
  if (!isSnapshotSummary(record.snapshot)) return false;
  const overall = record.overall;
  if (overall !== null && !OVERALLS.some((item) => item === overall)) return false;
  if (!Array.isArray(record.rules) || record.rules.length > MAX_REVIEW_RULES) return false;
  const known = new Set(record.snapshot.rules.map((rule) => rule.ruleId));
  const seen = new Set<string>();
  for (const tag of record.rules) {
    const item = asRecord(tag);
    if (!item || typeof item.ruleId !== 'string' || !ID_PATTERN.test(item.ruleId)) return false;
    if (!RULE_LABELS.some((label) => label === item.label)) return false;
    if (!known.has(item.ruleId) || seen.has(item.ruleId)) return false;
    seen.add(item.ruleId);
    if (overall === null || item.label !== RULE_LABEL_OF[overall as ReviewOverall]) return false;
  }
  const reason = record.noRuleCovers;
  if (reason !== undefined) {
    if (overall !== 'hide' || record.rules.length > 0) return false;
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_NO_RULE_REASON_LENGTH) {
      return false;
    }
  }
  if (overall === null && !record.valuable) return false;
  if (overall === 'hide' && record.rules.length === 0 && reason === undefined) return false;
  return true;
}

export function isReviewRecord(value: unknown): value is ReviewRecord {
  const record = asRecord(value);
  return (
    record !== null &&
    isReviewSaveInput(value) &&
    typeof record.revision === 'number' &&
    Number.isInteger(record.revision) &&
    record.revision >= 1 &&
    record.source === REVIEW_SOURCE &&
    typeof record.at === 'number' &&
    Number.isFinite(record.at)
  );
}

/** Keeps only the fields of an annotation, so nothing extra ever gets stored. */
function cleanInput(input: ReviewSaveInput): ReviewSaveInput {
  return {
    sampleId: input.sampleId,
    inputHash: input.inputHash,
    postId: input.postId,
    threadId: input.threadId,
    overall: input.overall,
    rules: input.rules.map((tag) => ({ ruleId: tag.ruleId, label: tag.label })),
    ...(input.noRuleCovers !== undefined ? { noRuleCovers: input.noRuleCovers.trim() } : {}),
    valuable: input.valuable,
    snapshot: {
      state: input.snapshot.state,
      direct: input.snapshot.direct,
      ...(input.snapshot.undecidedReason ? { undecidedReason: input.snapshot.undecidedReason } : {}),
      rulesFingerprint: input.snapshot.rulesFingerprint,
      rules: input.snapshot.rules.map((rule) => ({ ...rule })),
    },
    stateJson: input.stateJson,
  };
}

export type ApplyResult =
  | { ok: true; records: ReviewRecord[]; record: ReviewRecord; evicted: number }
  | { ok: false; error: 'full' };

/**
 * Stores one annotation. A correction of the same annotation replaces the old one
 * and bumps its revision. When the list is over `cap`, the oldest annotation that
 * is not marked "worth reading" is evicted; if every annotation is protected the
 * new one is refused instead of deleting something the person marked.
 */
export function applyRecord(
  list: readonly ReviewRecord[],
  input: ReviewSaveInput,
  now: number,
  cap: number = MAX_REVIEW_RECORDS,
): ApplyResult {
  const key = recordKeyOf(input);
  const previous = list.find((item) => recordKeyOf(item) === key);
  const record: ReviewRecord = {
    ...cleanInput(input),
    revision: (previous?.revision ?? 0) + 1,
    source: REVIEW_SOURCE,
    at: now,
  };
  const records = list.filter((item) => recordKeyOf(item) !== key);
  records.push(record);
  let evicted = 0;
  while (records.length > cap) {
    const index = records.findIndex((item) => !item.valuable && item !== record);
    if (index === -1) return { ok: false, error: 'full' };
    records.splice(index, 1);
    evicted += 1;
  }
  return { ok: true, records, record, evicted };
}

/** Removes one annotation (undo). Removing something that is not there is not an
 * error: the result is the same list. */
export function removeRecord(
  list: readonly ReviewRecord[],
  sampleId: string,
  inputHash: string,
  rulesFingerprint: string,
): ReviewRecord[] {
  const key = recordKey(sampleId, inputHash, rulesFingerprint);
  return list.filter((item) => recordKeyOf(item) !== key);
}

export function isReviewSaveResult(value: unknown): value is ReviewSaveResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) {
    return (
      (record.record === null || isReviewRecord(record.record)) &&
      typeof record.count === 'number'
    );
  }
  return record.ok === false && typeof record.error === 'string' && typeof record.detail === 'string';
}

export function isReviewLoadResult(value: unknown): value is ReviewLoadResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) {
    return (
      typeof record.epoch === 'number' &&
      Array.isArray(record.records) &&
      record.records.every(isReviewRecord)
    );
  }
  return record.ok === false && typeof record.error === 'string' && typeof record.detail === 'string';
}

/** What the person has entered in the single-post panel, before saving. */
export interface ReviewDraft {
  overall: ReviewOverall | null;
  /** Ids of the ticked rules. */
  ruleIds: readonly string[];
  /** "No existing rule covers it" is chosen. */
  noRuleCovers: boolean;
  reason: string;
}

export type DraftProblem = 'no-overall' | 'no-rule-or-reason' | 'reason-empty' | 'reason-too-long';

/** Why a draft cannot be saved yet, or `null` when it can. */
export function draftProblem(draft: ReviewDraft): DraftProblem | null {
  if (draft.overall === null) return 'no-overall';
  if (draft.overall !== 'hide') return null;
  if (draft.noRuleCovers) {
    const reason = draft.reason.trim();
    if (reason === '') return 'reason-empty';
    return reason.length > MAX_NO_RULE_REASON_LENGTH ? 'reason-too-long' : null;
  }
  return draft.ruleIds.length === 0 ? 'no-rule-or-reason' : null;
}

/** The annotation a valid draft stands for. Only ticked rules are labelled. */
export function inputFromDraft(
  snapshot: ReviewSnapshot,
  draft: ReviewDraft,
  valuable: boolean,
): ReviewSaveInput | null {
  if (draftProblem(draft) !== null || draft.overall === null) return null;
  const overall = draft.overall;
  const known = new Set(snapshot.rules.map((rule) => rule.ruleId));
  const noRule = overall === 'hide' && draft.noRuleCovers;
  const rules = noRule
    ? []
    : draft.ruleIds
        .filter((id, index, all) => known.has(id) && all.indexOf(id) === index)
        .map((ruleId) => ({ ruleId, label: RULE_LABEL_OF[overall] }));
  return {
    sampleId: snapshot.sampleId,
    inputHash: snapshot.inputHash,
    postId: snapshot.postId,
    threadId: snapshot.threadId,
    overall,
    rules,
    ...(noRule ? { noRuleCovers: draft.reason.trim() } : {}),
    valuable,
    snapshot: summarize(snapshot),
    stateJson: snapshot.stateJson,
  };
}

/** Only the "worth reading" flag, keeping any existing annotation. */
export function inputWithValuable(
  snapshot: ReviewSnapshot,
  existing: ReviewRecord | undefined,
  valuable: boolean,
): ReviewSaveInput | null {
  if (existing) return { ...cleanInput(existing), valuable };
  if (!valuable) return null;
  return {
    sampleId: snapshot.sampleId,
    inputHash: snapshot.inputHash,
    postId: snapshot.postId,
    threadId: snapshot.threadId,
    overall: null,
    rules: [],
    valuable: true,
    snapshot: summarize(snapshot),
    stateJson: snapshot.stateJson,
  };
}

/** The existing annotation without its verdict (undo the label, keep the flag). */
export function inputWithoutLabel(existing: ReviewRecord): ReviewSaveInput | null {
  if (!existing.valuable) return null;
  const { noRuleCovers: _dropped, ...rest } = cleanInput(existing);
  return { ...rest, overall: null, rules: [] };
}

export type ReviewActionResult =
  | { ok: true }
  | { ok: false; error: ReviewSaveError | 'no-input' };

/** What the on-page review UI needs from the annotation store. The page never
 * sees the storage, only these operations, and success means the background
 * really stored (or removed) the annotation. */
export interface ReviewAnnotationPort {
  recordFor(snapshot: ReviewSnapshot): ReviewRecord | undefined;
  /** How many stored annotations carry a verdict, wherever their posts are now. */
  labeledCount(): number;
  saveDraft(snapshot: ReviewSnapshot, draft: ReviewDraft): Promise<ReviewActionResult>;
  setValuable(snapshot: ReviewSnapshot, valuable: boolean): Promise<ReviewActionResult>;
  removeLabel(snapshot: ReviewSnapshot): Promise<ReviewActionResult>;
}
