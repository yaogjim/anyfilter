import { excerptOf, type CapturePage, type CaptureSample } from './capture';
import {
  availableMicroOf,
  formatMicro,
  openJobs,
  reservedMicroOf,
  type EvaluationJobState,
} from './evaluation-budget';
import type { RuleScope } from './rule';
import type { Settings } from './settings';

/**
 * Wire contract for the minimal, manual, single-sample verification entry point.
 *
 * This module is pure: no network, no `chrome` call, no key and no model. It only
 * describes what the trusted extension page (the side panel) may show and ask
 * for, and validates what comes back over `chrome.runtime.sendMessage`.
 *
 * What it deliberately does *not* contain is the point of the design:
 *
 * - There is no price, endpoint, model or key field anywhere in the request. The
 *   panel can name one stored sample and one enabled semantic rule and nothing
 *   else, so no user input can repoint the call or reprice it. The model is pinned
 *   by the executor (`jev-1.13.0`), never carried on the wire.
 * - There is no "authorize" flag on the wire either. Authorization is not a value
 *   a caller can set; it is the background deciding that the sender is one of our
 *   own pages and that a human clicked. See
 *   `infrastructure/evaluation-verification.ts`.
 * - A candidate carries only a short excerpt, whether the body was truncated and
 *   an identifiable source. The stored `stateJson` and `contentKey` never travel
 *   on the candidate list, so a list is deliberately not the full text.
 * - The *one* sample a human selects can be read in full, on demand, through
 *   {@link VerificationSampleDetail}. That read exists because the panel asks a
 *   person to confirm that a whole third-party post may be sent, and a
 *   140-character excerpt cannot support that confirmation. It is served only to
 *   one of our own pages, renders locally, logs nothing, writes no store and
 *   reaches no network, so the body still never leaves the extension.
 */

/** Reasons the executor stopped before sending. A superset of the execution
 * slice's own reasons, plus the routing refusal. Naming the reasons here is what
 * lets the executor's result be returned unchanged: a reason the executor could
 * produce but that is missing here fails `pnpm typecheck` at the mapping site. */
export const VERIFICATION_SKIP_REASONS = [
  'not-authorized',
  'no-key',
  'sample-not-found',
  'not-sendable',
  'rule-not-compiled',
  'budget-disabled',
  'cap-exceeded',
  'budget-refused',
  'already-recorded',
  'job-inactive',
  'storage',
  /** The message did not come from one of our own pages. */
  'wrong-sender',
] as const;

export type VerificationSkipReason = (typeof VERIFICATION_SKIP_REASONS)[number];

/** Identity and outcome of one executed judgement. The stored body and the key
 * are never part of it. */
export interface VerificationTrace {
  readonly sampleId: string;
  readonly postId: string;
  readonly threadId: string;
  readonly ruleId: string;
  readonly requestedModel: string;
  readonly answeredModel: string;
  readonly rulesFingerprint: string;
  readonly threshold: number;
  readonly inputHash: string;
  readonly truncated: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicro: number | null;
  readonly jobId: string;
}

/** The outcome of one manually requested call. `unknown` means the request may
 * have been sent and no usable answer was recorded, so its reservation stays
 * held; it is never shown as a score. */
export type VerificationRunResult =
  | {
      readonly kind: 'skipped';
      readonly sampleId: string;
      readonly ruleId: string;
      readonly reason: VerificationSkipReason;
      readonly detail: string;
    }
  | { readonly kind: 'match'; readonly score: number; readonly trace: VerificationTrace }
  | { readonly kind: 'no-match'; readonly score: number; readonly trace: VerificationTrace }
  | { readonly kind: 'undecided'; readonly detail: string; readonly trace: VerificationTrace }
  | { readonly kind: 'unknown'; readonly detail: string; readonly trace: VerificationTrace };

/** What the panel may show for one stored sample. Note the absence of
 * `stateJson`, `handle` and `contentKey`. */
export interface VerificationCandidate {
  readonly sampleId: string;
  readonly postId: string;
  /** Short preview only, as stored at capture time. */
  readonly excerpt: string;
  /** Whether the captured body was already clipped, so the panel can say so. */
  readonly truncated: boolean;
  /** Which X surface the sample came from. */
  readonly page: CapturePage;
  /** Origin plus path at capture time: the identifiable source of the sample. */
  readonly pageUrl: string;
  /** A platform-promoted post is kept but flagged. */
  readonly promoted: boolean;
  /** Whether the captured snapshot carried parent context, so a `replies`-scoped
   * rule could actually be compiled for it. */
  readonly hasParent: boolean;
  readonly capturedAt: number;
}

function hasParentContext(stateJson: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(stateJson);
  } catch {
    return false;
  }
  if (typeof raw !== 'object' || raw === null) return false;
  const replyingTo = (raw as Record<string, unknown>).replyingTo;
  return typeof replyingTo === 'object' && replyingTo !== null;
}

/** Projects one stored sample down to the fields the panel is allowed to see. */
export function candidateOf(sample: CaptureSample): VerificationCandidate {
  return {
    sampleId: sample.sampleId,
    postId: sample.postId,
    excerpt: sample.excerpt,
    truncated: sample.truncated,
    page: sample.page,
    pageUrl: sample.pageUrl,
    promoted: sample.promoted,
    hasParent: hasParentContext(sample.stateJson),
    capturedAt: sample.capturedAt,
  };
}

export function candidatesOf(samples: readonly CaptureSample[]): VerificationCandidate[] {
  return samples.map(candidateOf);
}

/**
 * The exact stored text of one sample, read on demand for the selected sample
 * only.
 *
 * This is a deliberate, bounded exception to "the panel never holds the captured
 * body", and it exists because the panel asks a person to confirm that *this
 * whole post* may leave the browser. A short excerpt cannot support that
 * confirmation: the rest of the body, and any quoted or parent text, could carry
 * content the excerpt never showed. The panel therefore reads the stored body for
 * the one sample a human selected, renders it locally, and sends nothing.
 */
export interface VerificationPreviewAuthor {
  readonly handle: string;
  readonly name: string;
}

export interface VerificationPreviewContext {
  readonly author: string;
  readonly text: string;
}

export interface VerificationSampleDetail {
  readonly sampleId: string;
  readonly postId: string;
  readonly capturedAt: number;
  readonly author: VerificationPreviewAuthor;
  /** The full stored body, exactly as it would be sent. */
  readonly text: string;
  /** The quoted post, when the sample carried one; `null` otherwise. */
  readonly quoted: string | null;
  /** The parent post, when the sample was a reply; `null` otherwise. */
  readonly replyingTo: VerificationPreviewContext | null;
  /** The stored body was already clipped at capture time. */
  readonly truncated: boolean;
  /** The stored excerpt still reads as the head of the stored body. `false` means
   * the shorter preview the panel showed earlier describes different text, so the
   * sample must be presented as uncertain rather than as the text it showed. */
  readonly excerptMatches: boolean;
}

export const VERIFICATION_DETAIL_REFUSALS = ['wrong-sender', 'sample-not-found', 'unreadable'] as const;

/** Why the exact text could not be produced. */
export type VerificationDetailRefusal = (typeof VERIFICATION_DETAIL_REFUSALS)[number];

/**
 * The result of asking for one sample's exact text. A refusal carries a short
 * message only — never a body, a handle or any other field.
 */
export type VerificationDetailResult =
  | { readonly ok: true; readonly sample: VerificationSampleDetail }
  | { readonly ok: false; readonly reason: VerificationDetailRefusal; readonly message: string };

/**
 * Reads the exact text out of one sample's own stored snapshot. Returns `null`
 * when the snapshot is not the known shape or has no usable body, so a corrupted
 * record is refused instead of being rendered as a guess. Nothing is re-derived
 * from the DOM, and the snapshot is not re-ordered or rewritten.
 */
export function sampleDetailOf(sample: CaptureSample): VerificationSampleDetail | null {
  let raw: unknown;
  try {
    raw = JSON.parse(sample.stateJson);
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (record === null) return null;
  const author = asRecord(record.author);
  if (author === null) return null;
  const handle = author.handle;
  const name = author.name;
  const text = record.text;
  if (typeof handle !== 'string' || typeof name !== 'string' || typeof text !== 'string') return null;
  if (text.trim() === '') return null;
  const quoted = typeof record.quoted === 'string' && record.quoted !== '' ? record.quoted : null;
  const reply = asRecord(record.replyingTo);
  const replyingTo =
    reply !== null && typeof reply.author === 'string' && typeof reply.text === 'string'
      ? { author: reply.author, text: reply.text }
      : null;
  return {
    sampleId: sample.sampleId,
    postId: sample.postId,
    capturedAt: sample.capturedAt,
    author: { handle, name },
    text,
    quoted,
    replyingTo,
    truncated: sample.truncated,
    excerptMatches: excerptOf(text) === sample.excerpt,
  };
}

export type VerificationDetailFlagKey = 'exact-state' | 'truncated' | 'excerpt-mismatch' | 'third-party';

export interface VerificationDetailFlag {
  readonly key: VerificationDetailFlagKey;
  readonly text: string;
}

/**
 * The warnings the panel must show next to one sample's exact text.
 *
 * Stated by this module rather than typed into the view, so every caller says the
 * same thing and the offline tests can assert the wording without a DOM. The
 * first line states that the preview *is* the text that would be sent; the rest
 * mark the ways it must not be read on its own: a body that was already clipped,
 * an excerpt that no longer matches, and content written by other people.
 */
export function verificationDetailFlags(
  sample: VerificationSampleDetail,
): readonly VerificationDetailFlag[] {
  const flags: VerificationDetailFlag[] = [
    {
      key: 'exact-state',
      text: 'This is the exact stored state one verification would send: the author, the full body and any quoted or parent text. Nothing is re-read from the page, and nothing has been sent yet.',
    },
  ];
  if (sample.truncated) {
    flags.push({
      key: 'truncated',
      text: 'This body was already clipped when it was captured, so the text above may not be the whole post that was read.',
    });
  }
  if (!sample.excerptMatches) {
    flags.push({
      key: 'excerpt-mismatch',
      text: 'The stored excerpt does not match this stored body, so the shorter preview shown before this describes different text. Treat this sample as uncertain.',
    });
  }
  if (sample.quoted !== null || sample.replyingTo !== null) {
    flags.push({
      key: 'third-party',
      text: 'This preview includes quoted or parent content written by other people. Read all of it before you send.',
    });
  }
  return flags;
}

/** One rule the panel may ask about: an enabled semantic rule only. A local rule
 * (`ads`) is decided from page signals and is never a model question, and a
 * disabled rule asks nothing. */
export interface VerificationRuleOption {
  readonly id: string;
  readonly label: string;
  readonly scope: RuleScope;
  /** `rule.threshold ?? settings.threshold` at selection time. */
  readonly threshold: number;
}

export function enabledSemanticRuleOptions(settings: Settings): VerificationRuleOption[] {
  return settings.rules
    .filter((rule) => rule.enabled && rule.kind === 'semantic')
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      scope: rule.scope,
      threshold: rule.threshold ?? settings.threshold,
    }));
}

/** The shared spending picture, derived from the persisted budget and nothing
 * else. Money is in integer micro-units of one currency. */
export interface VerificationBudgetStatus {
  readonly enabled: boolean;
  /** The pinned model the budget was enabled for. */
  readonly model: string;
  readonly currency: string;
  /** `null` when no limit row exists yet, i.e. the budget was never enabled. */
  readonly capMicro: number | null;
  readonly spentMicro: number;
  readonly reservedMicro: number;
  /** `null` when there is no cap at all; never read as "unlimited" money. */
  readonly availableMicro: number | null;
  /** Pending and unknown jobs still holding money. */
  readonly openJobs: number;
  readonly updatedAt: number;
}

export function budgetStatusOf(state: EvaluationJobState, model: string): VerificationBudgetStatus {
  const limit = state.limits.find((candidate) => candidate.model === model) ?? null;
  const price = state.prices.find((candidate) => candidate.model === model) ?? null;
  return {
    enabled: state.enabled,
    model,
    currency: limit?.currency ?? price?.currency ?? 'USD',
    capMicro: limit?.capMicro ?? null,
    spentMicro: state.spentMicro[model] ?? 0,
    reservedMicro: reservedMicroOf(state, model),
    availableMicro: availableMicroOf(state, model),
    openJobs: openJobs(state).length,
    updatedAt: state.updatedAt,
  };
}

/**
 * The disclosure the panel must show before the user can ask for a call. It is
 * stated by the module rather than typed into the view, so every caller says the
 * same thing and the offline tests can assert the wording without a DOM.
 */
export function verificationDisclosure(status: VerificationBudgetStatus): readonly string[] {
  const cap = status.capMicro === null ? 'USD 1' : formatMicro(status.capMicro, status.currency);
  return [
    `Model: TypeSafe Jev 1.13 (${status.model}). It is pinned and verified; no other model, endpoint or key can be chosen here.`,
    `Spending cap: ${cap} for this verification budget. The published worst-case cost is held before anything is sent. This is a local estimate at the documented Jev 1.13 price, not a provider-enforced hard spending cap; provider pricing can change.`,
    'A real request may be charged to the account behind your stored TypeSafe key and cannot be recalled or refunded.',
    'The selected sample may contain third-party content. Confirm that this one post may be sent before you ask for a call.',
    "A returned score is the model's judgement, not an accuracy rate.",
    'If a response reports no usable usage, its reservation stays held as unknown instead of being guessed.',
  ];
}

/** Result of asking to switch the budget on. Refusals are reported with the
 * untouched status, so the panel can only ever show a state that really holds. */
export interface VerificationEnableResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly status: VerificationBudgetStatus;
}

/**
 * Result of asking to switch the budget off.
 *
 * A stop is reported with the exact state left behind: the status carries the
 * bumped epoch, the still-held reservations and the open (now `unknown`) jobs.
 * A request that was already sent may still be charged, so the stop never refunds
 * an unknown reservation; it only refuses new ones.
 */
export interface VerificationStopResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly status: VerificationBudgetStatus;
}

const MAX_ID_LENGTH = 128;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isTrace(value: unknown): value is VerificationTrace {
  const record = asRecord(value);
  if (!record) return false;
  return (
    isBoundedString(record.sampleId) &&
    typeof record.postId === 'string' &&
    typeof record.threadId === 'string' &&
    isBoundedString(record.ruleId) &&
    typeof record.requestedModel === 'string' &&
    typeof record.answeredModel === 'string' &&
    typeof record.rulesFingerprint === 'string' &&
    typeof record.threshold === 'number' &&
    Number.isFinite(record.threshold) &&
    typeof record.inputHash === 'string' &&
    typeof record.truncated === 'boolean' &&
    isNullableCount(record.inputTokens) &&
    isNullableCount(record.outputTokens) &&
    isNullableCount(record.costMicro) &&
    typeof record.jobId === 'string'
  );
}

export function isVerificationRunResult(value: unknown): value is VerificationRunResult {
  const record = asRecord(value);
  if (!record) return false;
  switch (record.kind) {
    case 'skipped':
      return (
        isBoundedString(record.sampleId) &&
        isBoundedString(record.ruleId) &&
        VERIFICATION_SKIP_REASONS.some((reason) => reason === record.reason) &&
        typeof record.detail === 'string'
      );
    case 'match':
    case 'no-match':
      return typeof record.score === 'number' && isTrace(record.trace);
    case 'undecided':
    case 'unknown':
      return typeof record.detail === 'string' && isTrace(record.trace);
    default:
      return false;
  }
}

/**
 * Validates a message that asks the background to run one verification.
 *
 * Only the two identifiers travel. There is intentionally no model, price,
 * endpoint, key or authorization field: a caller cannot widen the call or claim
 * permission it was not given, and the background decides authorization from the
 * sender.
 */
export function isVerificationRunRequest(value: unknown): value is { sampleId: string; ruleId: string } {
  const record = asRecord(value);
  if (!record) return false;
  return isBoundedString(record.sampleId) && isBoundedString(record.ruleId);
}

/**
 * Validates a message that asks for one sample's exact text. Only the one
 * identifier travels; there is no field that could name another sample's body,
 * widen the read, or ask for something other than the preview.
 */
export function isVerificationDetailRequest(value: unknown): value is { sampleId: string } {
  const record = asRecord(value);
  if (!record) return false;
  return isBoundedString(record.sampleId);
}

function isPreviewAuthor(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && typeof record.handle === 'string' && typeof record.name === 'string';
}

/** A context is either absent (`null`) or a complete author/text pair. */
function isPreviewContext(value: unknown): boolean {
  if (value === null) return true;
  const record = asRecord(value);
  return record !== null && typeof record.author === 'string' && typeof record.text === 'string';
}

export function isVerificationDetailResult(value: unknown): value is VerificationDetailResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) {
    const sample = asRecord(record.sample);
    if (sample === null) return false;
    return (
      isBoundedString(sample.sampleId) &&
      typeof sample.postId === 'string' &&
      typeof sample.capturedAt === 'number' &&
      isPreviewAuthor(sample.author) &&
      typeof sample.text === 'string' &&
      (sample.quoted === null || typeof sample.quoted === 'string') &&
      isPreviewContext(sample.replyingTo) &&
      typeof sample.truncated === 'boolean' &&
      typeof sample.excerptMatches === 'boolean'
    );
  }
  return (
    record.ok === false &&
    VERIFICATION_DETAIL_REFUSALS.some((reason) => reason === record.reason) &&
    typeof record.message === 'string'
  );
}

export function isVerificationBudgetStatus(value: unknown): value is VerificationBudgetStatus {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.enabled === 'boolean' &&
    typeof record.model === 'string' &&
    typeof record.currency === 'string' &&
    (record.capMicro === null || isNullableCount(record.capMicro)) &&
    isNullableCount(record.spentMicro) &&
    isNullableCount(record.reservedMicro) &&
    (record.availableMicro === null || isNullableCount(record.availableMicro)) &&
    isNullableCount(record.openJobs) &&
    isNullableCount(record.updatedAt)
  );
}

/** The shared shape of an enable/stop answer: a flag, a human detail and the
 * honest spending picture. One predicate keeps both answers validated the same
 * way, so a stop can never be read as a state the budget did not reach. */
function isBudgetActionResult(
  value: unknown,
): value is { ok: boolean; detail: string; status: VerificationBudgetStatus } {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.ok === 'boolean' &&
    typeof record.detail === 'string' &&
    isVerificationBudgetStatus(record.status)
  );
}

export function isVerificationEnableResult(value: unknown): value is VerificationEnableResult {
  return isBudgetActionResult(value);
}

export function isVerificationStopResult(value: unknown): value is VerificationStopResult {
  return isBudgetActionResult(value);
}

export function isVerificationCandidates(value: unknown): value is VerificationCandidate[] {
  return (
    Array.isArray(value) &&
    value.every((candidate) => {
      const record = asRecord(candidate);
      if (!record) return false;
      return (
        isBoundedString(record.sampleId) &&
        typeof record.postId === 'string' &&
        typeof record.excerpt === 'string' &&
        typeof record.truncated === 'boolean' &&
        (record.page === 'home' || record.page === 'search' || record.page === 'status') &&
        typeof record.pageUrl === 'string' &&
        typeof record.promoted === 'boolean' &&
        typeof record.hasParent === 'boolean' &&
        typeof record.capturedAt === 'number'
      );
    })
  );
}