import { postContentKey, type Post } from './post';
import { hashString } from './rule';

/**
 * Phase 2 contract for the voluntary, read-only capture workflow.
 *
 * Nothing here touches the network, a provider key, the DOM or a model. This
 * module only decides *which* already-loaded public post may become a local
 * verification sample, how that sample is shaped, and how a submit is routed
 * safely. Persistence lives in `infrastructure/capture-store.ts`; the DOM read
 * lives in `features/evaluation-capture.ts`; the background is the only writer.
 *
 * The verification library is deliberately separate from the production panel
 * state and the score cache: a capture can never write a "hidden" record, bump a
 * counter, or seed a cached model answer.
 */

/** `off` is the default and never changes on its own. `paused` keeps the stored
 * samples and stays resumable; only `active` observes the page. */
export type CaptureRunState = 'off' | 'active' | 'paused';

/** Which X surface a sample came from. Kept coarse on purpose: it is a sampling
 * stratum, not a browsing history. */
export type CapturePage = 'home' | 'search' | 'status';

export const CAPTURE_RUN_STATES: readonly CaptureRunState[] = ['off', 'active', 'paused'];

/** Hard cap on stored samples. When it is reached the oldest sample is shed, so
 * the library can never grow without bound in `storage.local`. */
export const MAX_SAMPLES = 300;
/** Per-sample cap on recorded filtering outcomes, so a post that is re-judged
 * many times can only keep its most recent observations. */
export const MAX_OUTCOMES_PER_SAMPLE = 20;
/** Local samples expire after seven days, independent of filtering history. */
export const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest body kept in one sample. A longer body is dropped instead of being
 * silently stored half-read: a partial body would poison a later rate. */
export const MAX_TEXT_LENGTH = 2000;
/** Longest quoted or parent context kept. */
export const MAX_CONTEXT_LENGTH = 1000;
/** Metadata is part of the provider input too, not an unbounded escape hatch. */
export const MAX_NAME_LENGTH = 120;
export const MAX_POST_ID_LENGTH = 32;
/** Short, human-readable preview shown in the UI; the full body stays in the
 * snapshot JSON so a later request can send the exact same text. */
export const MAX_EXCERPT_LENGTH = 140;
/** Most posts carried in one submit, so one content-script message stays small. */
export const MAX_OBSERVATIONS_PER_MESSAGE = 20;
export const MAX_HANDLE_LENGTH = 15;
/** X renders a relative label such as `13h`; it is a display hint, not a clock. */
export const MAX_TIME_LENGTH = 40;
export const MAX_THREAD_ID_LENGTH = 32;

/** The whole user-visible and persisted state of the workflow. `stored` and
 * `skipped` are written by the store from the real sample list, so the UI never
 * has to load every sample to show a count. */
export interface CaptureState {
  /** Default `off`; only an explicit user action moves it. */
  readonly runState: CaptureRunState;
  /** Bumped on every control change. A submit carrying an older value is refused,
   * so a request that started before a pause or a delete cannot write afterwards. */
  readonly epoch: number;
  /** Samples currently stored. Never exceeds {@link MAX_SAMPLES}. */
  readonly stored: number;
  /** Observations refused locally, for transparency. Never a sample count. */
  readonly skipped: number;
  readonly updatedAt: number;
}

export function emptyCaptureState(): CaptureState {
  return { runState: 'off', epoch: 0, stored: 0, skipped: 0, updatedAt: 0 };
}

export function isCaptureRunState(value: unknown): value is CaptureRunState {
  return value === 'off' || value === 'active' || value === 'paused';
}

/** Lenient read of a stored state record. Anything unrecognized falls back to
 * `off`, so a corrupted record can never switch observation on. */
export function normalizeCaptureState(raw: unknown): CaptureState {
  if (typeof raw !== 'object' || raw === null) return emptyCaptureState();
  const record = raw as Record<string, unknown>;
  const epoch = record.epoch;
  const stored = record.stored;
  const skipped = record.skipped;
  const updatedAt = record.updatedAt;
  return {
    runState: isCaptureRunState(record.runState) ? record.runState : 'off',
    epoch: typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0 ? epoch : 0,
    stored: typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0,
    skipped: typeof skipped === 'number' && Number.isInteger(skipped) && skipped >= 0 ? skipped : 0,
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

export function isCaptureState(value: unknown): value is CaptureState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isCaptureRunState(record.runState) &&
    typeof record.epoch === 'number' &&
    Number.isInteger(record.epoch) &&
    record.epoch >= 0 &&
    typeof record.stored === 'number' &&
    Number.isInteger(record.stored) &&
    record.stored >= 0 &&
    typeof record.skipped === 'number' &&
    Number.isInteger(record.skipped) &&
    record.skipped >= 0 &&
    typeof record.updatedAt === 'number'
  );
}

/** One stored verification sample. It carries the exact serialized state a later
 * phase would send, so no rule can be judged against re-read DOM text. */
export interface CaptureSample {
  /** `postId` plus a fingerprint of the body, so editing a post creates a new
   * sample instead of overwriting a record that may already be reviewed. */
  readonly sampleId: string;
  readonly postId: string;
  readonly threadId: string;
  readonly handle: string;
  readonly page: CapturePage;
  /** Origin plus path only: query and fragment are dropped so a tracking token
   * can never be stored. */
  readonly pageUrl: string;
  /** The exact JSON state, matching what the feed would send for the same text. */
  readonly stateJson: string;
  /** Fingerprint of {@link stateJson}; a changed input is detectable. */
  readonly inputHash: string;
  /** `postContentKey` of the same post, reusing the feed's own definition. */
  readonly contentKey: string;
  /** Short preview for the UI only. */
  readonly excerpt: string;
  readonly truncated: boolean;
  /** A platform-promoted post; kept but flagged so it can be excluded from a
   * population rate later. */
  readonly promoted: boolean;
  /** The relative label X rendered, e.g. `13h`. Not a timestamp. */
  readonly publishedAt: string;
  /** Wall clock when the background stored it. */
  readonly capturedAt: number;
  /** Filtering outcomes observed for this exact sample after it was stored.
   * Absent until the production feed has judged the same post. Optional so the
   * persisted shape stays backward compatible. */
  readonly outcomes?: readonly CaptureOutcome[];
}

/** Why an observed post was not stored. Every reason is local-only. */
export type CaptureSkipReason =
  | 'own'
  | 'no-text'
  | 'possibly-protected'
  | 'too-long'
  | 'no-id'
  | 'cap-reached';

/**
 * Best-effort tripwire for content that must not be treated as a public,
 * outbound-safe candidate. The primary signal is structural (X renders no
 * `tweetText` element at all, which reads as empty text and is skipped); these
 * strings only cover the placeholder copy X shows instead of a body. This is a
 * conservative heuristic, not a guarantee: a false match under-collects, which is
 * the safe direction, and a miss is caught by the empty-text rule.
 */
const PROTECTED_TEXT_MARKERS: readonly string[] = [
  'these posts are protected',
  'follow to see',
  'may contain sensitive content',
];

export function looksPossiblyProtected(text: string): boolean {
  const probe = text.toLowerCase();
  return PROTECTED_TEXT_MARKERS.some((marker) => probe.includes(marker));
}

/**
 * The local admissibility rule for one already-loaded article. Returns `null`
 * when the post may become a sample, otherwise the reason it must not. Own posts,
 * bodies with no text, long bodies and protected placeholders are refused; a
 * promoted post is admitted and flagged.
 */
export function captureSkipReason(post: Post): CaptureSkipReason | null {
  if (post.id === '' || post.id.length > MAX_POST_ID_LENGTH || !/^\d+$/.test(post.id)) return 'no-id';
  if (post.own) return 'own';
  if (!/^[A-Za-z0-9_]{1,64}$/.test(post.handle)) return 'possibly-protected';
  if (post.name.length > MAX_NAME_LENGTH || post.thread.length > MAX_THREAD_ID_LENGTH) return 'too-long';
  if (post.parent && (post.parent.id.length > MAX_POST_ID_LENGTH ||
    post.parent.handle.length > 64 ||
    post.parent.text.length > MAX_CONTEXT_LENGTH)) return 'too-long';
  const text = post.text.trim();
  if (text === '') return 'no-text';
  if (looksPossiblyProtected(text)) return 'possibly-protected';
  if (text.length > MAX_TEXT_LENGTH) return 'too-long';
  if (post.quotedText.length > MAX_CONTEXT_LENGTH) return 'too-long';
  if ((post.parent?.text.length ?? 0) > MAX_CONTEXT_LENGTH) return 'too-long';
  return null;
}

/**
 * The exact state object the feed would send for this post, built with the same
 * field order and the same `@handle` shape as `classifier.stateOf`, so a captured
 * sample and a live request are byte-identical for the same DOM read.
 */
export function observedStateJson(post: Post): string {
  const state: Record<string, unknown> = {
    author: { handle: `@${post.handle}`, name: post.name },
    text: post.text,
  };
  if (post.quotedText) state.quoted = post.quotedText;
  if (post.parent) {
    state.replyingTo = { author: `@${post.parent.handle}`, text: post.parent.text };
  }
  return JSON.stringify(state);
}

/** Fingerprint of one captured input. `stateJson` is already the exact text, so
 * the question is empty here; phase 3 fills it once a rule set is bound. */
export function captureInputHash(stateJson: string, question = ''): string {
  return hashString(JSON.stringify([stateJson, question]));
}

/** The short preview of one body, flattened and clipped to
 * {@link MAX_EXCERPT_LENGTH}. Exported so the verification preview can re-derive
 * it from the stored body and check that the two still agree. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_EXCERPT_LENGTH ? flat : `${flat.slice(0, MAX_EXCERPT_LENGTH)}…`;
}

/** Stable identity of one sample: the post plus a fingerprint of what was read. */
export function sampleIdFor(post: Post): string {
  return `${post.id}.${hashString(postContentKey(post))}`;
}

export function sampleOf(
  post: Post,
  { page, pageUrl, capturedAt }: { page: CapturePage; pageUrl: string; capturedAt: number },
): CaptureSample {
  const stateJson = observedStateJson(post);
  const contentKey = postContentKey(post);
  return {
    sampleId: sampleIdFor(post),
    postId: post.id,
    threadId: post.thread.slice(0, MAX_THREAD_ID_LENGTH),
    handle: post.handle.slice(0, MAX_HANDLE_LENGTH),
    page,
    pageUrl,
    stateJson,
    inputHash: captureInputHash(stateJson),
    contentKey,
    excerpt: excerptOf(post.text),
    truncated: post.truncated,
    promoted: post.promoted,
    publishedAt: post.time.slice(0, MAX_TIME_LENGTH),
    capturedAt,
  };
}

export function isCaptureSample(value: unknown): value is CaptureSample {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sampleId === 'string' &&
    record.sampleId !== '' &&
    typeof record.postId === 'string' &&
    record.postId !== '' &&
    typeof record.threadId === 'string' &&
    typeof record.handle === 'string' &&
    (record.page === 'home' || record.page === 'search' || record.page === 'status') &&
    typeof record.pageUrl === 'string' &&
    typeof record.stateJson === 'string' &&
    typeof record.inputHash === 'string' &&
    typeof record.contentKey === 'string' &&
    typeof record.excerpt === 'string' &&
    typeof record.truncated === 'boolean' &&
    typeof record.promoted === 'boolean' &&
    typeof record.publishedAt === 'string' &&
    typeof record.capturedAt === 'number' &&
    (record.outcomes === undefined ||
      (Array.isArray(record.outcomes) && record.outcomes.every(isCaptureOutcome)))
  );
}

/**
 * One observed filtering outcome for an already-captured sample.
 *
 * This is the *only* bridge between the production feed and the verification
 * library, and it is deliberately data, not a decision: the feed reports what it
 * actually did with the exact same post, and nothing here can hide, un-hide or
 * re-score anything. It carries the sample identity plus a fingerprint of the
 * input and the rule set, so a sample whose text, quote or parent changed can
 * never be paired with a judgement of a different input.
 *
 * A reported `no-match` is *not* automatically a negative example. Only
 * {@link isNegativeCandidate} may be used as a real negative; everything else is
 * an uncertain outcome that must never be counted as one.
 */

/** Which point of the feed's own pipeline produced the observation. */
export type CaptureOutcomeStage = 'rule-only' | 'scored' | 'pending' | 'failed';

/** The verdict states a sample can carry, plus a failed call. `undecided` means
 * no decision was reached; it is never a silent negative. */
export type CaptureOutcomeStatus = 'match' | 'no-match' | 'undecided' | 'error';

/** The thread action the feed took for the reported post: `none` when the feed
 * did not touch the page for this observation. */
export type CaptureThreadAction = 'none' | 'hidden' | 'shown';

/** Why the feed reached this outcome, kept local and rule-label independent, so
 * a later rate never has to re-derive intent from a reason label. */
export type CaptureOutcomeDetail =
  | 'own'
  | 'empty-or-promoted'
  | 'no-semantic-rules'
  | 'pending'
  | 'scored'
  | 'failed-retryable'
  | 'failed-terminal';

export interface CaptureOutcome {
  /** Must equal {@link CaptureSample.sampleId} of the post it describes, so an
   * outcome can only ever attach to the sample with the same input. */
  readonly sampleId: string;
  readonly postId: string;
  readonly threadId: string;
  /** Same definition as {@link CaptureSample.inputHash}; a mismatch means the
   * outcome describes a different input and must be refused. */
  readonly inputHash: string;
  readonly contentKey: string;
  /** `questionsFingerprint` of the exact questions the feed used, so an outcome
   * judged under a different rule set is never read as the current one. */
  readonly rulesFingerprint: string;
  readonly compilerVersion: number;
  /** The threshold the feed applied to this post's questions (`settings.threshold`;
   * a per-rule override travels on the rule itself). The rule fingerprint covers
   * only the compiled question text, so changing the threshold leaves it
   * identical; recording the threshold is what stops two judgements made at
   * different thresholds from looking like the same configuration. */
  readonly threshold: number;
  readonly stage: CaptureOutcomeStage;
  readonly status: CaptureOutcomeStatus;
  /** Local reason for this outcome; stable across rule renames. */
  readonly detail: CaptureOutcomeDetail;
  /** Rule ids that matched and produced this observation, in score order. */
  readonly matchedRuleIds: readonly string[];
  /** Rule ids that matched but the user explicitly put the post back in the
   * feed. A subset of {@link matchedRuleIds}; never a separate hit. */
  readonly keepReasons: readonly string[];
  /** Whether the post actually had parent context, so a `replies`-scoped rule
   * was asked and can be judged. */
  readonly hasParent: boolean;
  /** At least one enabled text-decided rule applied to this post's context, so a
   * keep is a real negative for that rule rather than a skipped question. */
  readonly textDecidable: boolean;
  readonly threadAction: CaptureThreadAction;
  /** How many posts of the same thread were acted on together. */
  readonly threadSize: number;
  readonly scoreTruncated: boolean;
  readonly at: number;
}

const OUTCOME_STAGES: readonly CaptureOutcomeStage[] = ['rule-only', 'scored', 'pending', 'failed'];
const OUTCOME_STATUSES: readonly CaptureOutcomeStatus[] = ['match', 'no-match', 'undecided', 'error'];
const THREAD_ACTIONS: readonly CaptureThreadAction[] = ['none', 'hidden', 'shown'];
const OUTCOME_DETAILS: readonly CaptureOutcomeDetail[] = [
  'own',
  'empty-or-promoted',
  'no-semantic-rules',
  'pending',
  'scored',
  'failed-retryable',
  'failed-terminal',
];

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isCaptureOutcome(value: unknown): value is CaptureOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sampleId === 'string' &&
    record.sampleId !== '' &&
    typeof record.postId === 'string' &&
    typeof record.threadId === 'string' &&
    typeof record.inputHash === 'string' &&
    typeof record.contentKey === 'string' &&
    typeof record.rulesFingerprint === 'string' &&
    typeof record.compilerVersion === 'number' &&
    typeof record.threshold === 'number' &&
    Number.isFinite(record.threshold) &&
    record.threshold >= 0 &&
    record.threshold <= 1 &&
    OUTCOME_STAGES.some((stage) => stage === record.stage) &&
    OUTCOME_STATUSES.some((status) => status === record.status) &&
    OUTCOME_DETAILS.some((detail) => detail === record.detail) &&
    isStringArray(record.matchedRuleIds) &&
    isStringArray(record.keepReasons) &&
    typeof record.hasParent === 'boolean' &&
    typeof record.textDecidable === 'boolean' &&
    THREAD_ACTIONS.some((action) => action === record.threadAction) &&
    typeof record.threadSize === 'number' &&
    typeof record.scoreTruncated === 'boolean' &&
    typeof record.at === 'number'
  );
}

/**
 * Identity of one observed outcome: the exact sample plus every field that
 * describes what the feed decided.
 *
 * `at` and `threadSize` are deliberately excluded as metadata, so re-reporting
 * the *same* result (a re-scan, a retry) is idempotent and never inflates a
 * count. Any genuinely different result — a changed stage, status, reason, or
 * thread action, e.g. after a settings change or because a thread member later
 * matched — has a different fingerprint and is kept as a new observation.
 */
export function outcomeFingerprint(outcome: CaptureOutcome): string {
  return hashString(
    JSON.stringify([
      outcome.sampleId,
      outcome.inputHash,
      outcome.contentKey,
      outcome.rulesFingerprint,
      outcome.compilerVersion,
      outcome.threshold,
      outcome.stage,
      outcome.status,
      outcome.detail,
      outcome.matchedRuleIds,
      outcome.keepReasons,
      outcome.hasParent,
      outcome.textDecidable,
      outcome.threadAction,
      outcome.scoreTruncated,
    ]),
  );
}

/** Outcomes already attached to a stored sample, filtered to the valid shape. */
export function outcomesOfSample(sample: CaptureSample): readonly CaptureOutcome[] {
  const raw = (sample as { outcomes?: unknown }).outcomes;
  return Array.isArray(raw) ? raw.filter(isCaptureOutcome) : [];
}

/**
 * Attaches one outcome to its sample. A repeat of the same snapshot is ignored,
 * so a re-scan or a retry can never inflate a count; a genuinely new observation
 * is appended and the oldest ones are shed at {@link MAX_OUTCOMES_PER_SAMPLE}.
 */
export function withOutcome(sample: CaptureSample, outcome: CaptureOutcome): CaptureSample {
  const existing = outcomesOfSample(sample);
  const key = outcomeFingerprint(outcome);
  if (existing.some((candidate) => outcomeFingerprint(candidate) === key)) return sample;
  const next = [...existing, outcome];
  const bounded = next.length > MAX_OUTCOMES_PER_SAMPLE
    ? next.slice(next.length - MAX_OUTCOMES_PER_SAMPLE)
    : next;
  return { ...sample, outcomes: bounded };
}

/**
 * True only for the one outcome shape that may stand in as a real current
 * negative: the post was kept, the feed acted on the page, no rule matched, and
 * at least one text-decided rule actually applied to this post's context.
 *
 * A `no-match` that came from an own post, from a post with no applicable
 * text-decided rule, from a `replies` rule that was never asked, or from a
 * question the provider left unanswered is *not* a negative and must be counted
 * as uncertain. An unanswered question is reported as `undecided` instead, so it
 * can never be read as a kept negative.
 */
export function isNegativeCandidate(outcome: CaptureOutcome): boolean {
  return (
    outcome.status === 'no-match' &&
    outcome.threadAction === 'shown' &&
    outcome.detail !== 'own' &&
    outcome.textDecidable
  );
}

/** Everything that is not a {@link isNegativeCandidate}: kept for accounting but
 * never usable as a negative example. */
export function isUncertainOutcome(outcome: CaptureOutcome): boolean {
  return !isNegativeCandidate(outcome);
}

/** Reports a filtering observation for an already-captured sample, so the feed
 * never has to know how (or whether) the library stores it. */
export interface CaptureOutcomeReporter {
  /** The epoch the feed should stamp onto an outcome, or `0` when capture is not
   * active. `0` means the outcome must not be reported at all. */
  captureEpoch(): number;
  /** Fire-and-forget. A refusal or a dropped batch is the reporter's problem and
   * can never change what the feed hides or shows. */
  reportOutcome(epoch: number, outcome: CaptureOutcome): void;
}

/**
 * Appends `sample` while keeping the library bounded and idempotent.
 *
 * A repeated observation of the same post with the same body is ignored, so a
 * re-scan or a retry never inflates the count. A repeat whose body changed gets a
 * fresh suffixed id instead of overwriting the earlier record, so an edited post
 * cannot replace a sample that may already be reviewed. The oldest samples are
 * shed first once the cap is reached.
 */
export function mergeSample(
  samples: readonly CaptureSample[],
  sample: CaptureSample,
  max: number = MAX_SAMPLES,
): { samples: readonly CaptureSample[]; added: boolean } {
  const existing = samples.find((candidate) => candidate.sampleId === sample.sampleId);
  if (existing) {
    if (existing.contentKey === sample.contentKey) return { samples, added: false };
    sample = { ...sample, sampleId: suffixedId(samples, sample.sampleId) };
  }
  const next = [...samples, sample];
  return { samples: next.length > max ? next.slice(next.length - max) : next, added: true };
}

function suffixedId(samples: readonly CaptureSample[], base: string): string {
  const taken = new Set(samples.map((sample) => sample.sampleId));
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}#${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}#${Date.now()}`;
}

/** Capture keeps its own, deliberately narrower list than the filter's page
 * gate in `x-pages`: profiles and lists are filtered and reviewed but never
 * add verification samples. Widening this list widens what is stored, so it
 * needs a matching change to PRIVACY.md. */
const HOME_PATH = /^\/home(?:[/?#]|$)/;
const SEARCH_PATH = /^\/search(?:[/?#]|$)/;
const STATUS_PATH = /^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:[/?#]|$)/;

export function xPageOf(url: string): CapturePage | null {
  // The origin is checked as well as the path: `/home` on any other host is not
  // an X surface, and the background uses this to decide whether a sender's URL
  // may be read at all.
  if (!isXPageUrl(url)) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (HOME_PATH.test(pathname)) return 'home';
  if (SEARCH_PATH.test(pathname)) return 'search';
  if (STATUS_PATH.test(pathname)) return 'status';
  return null;
}

export function isXPageUrl(url: string): boolean {
  return url.startsWith('https://x.com/');
}

/** Origin plus path, no query and no fragment. */
export function xPageUrlOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

export type SenderKind = 'extension-page' | 'x-content' | 'other';

/** A structural view of `chrome.runtime.MessageSender`, so the routing rule can
 * be exercised offline without a live browser. */
export interface SenderLike {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly tab?: { readonly url?: string | undefined } | undefined;
}

/**
 * Who sent a runtime message, from the background's point of view.
 *
 * `extension-page` is one of our own pages (the side panel or the options tab):
 * the only sender allowed to start, pause or clear a capture. `x-content` is our
 * content script running in an X tab: the only sender allowed to submit
 * observations. Everything else is `other` and is refused. A web page cannot
 * reach this listener at all, because the extension declares no
 * `externally_connectable`, and this check refuses a request whose sender id or
 * URL does not prove it is ours.
 *
 * The sending frame's own URL decides, not the presence of a tab: our options
 * page is normally opened as a real tab, so `tab` is set for it too. Only a frame
 * that is itself an X page, inside a tab, counts as page content.
 */
export function senderKind(sender: SenderLike, ownExtensionId: string): SenderKind {
  if (ownExtensionId === '' || sender.id !== ownExtensionId) return 'other';
  const frameUrl = sender.url ?? '';
  if (frameUrl.startsWith(`chrome-extension://${ownExtensionId}/`)) return 'extension-page';
  // Require both the sending frame and its tab to be on X. Trusting only the
  // tab URL would admit an unrelated iframe embedded in an X page.
  return sender.tab !== undefined && isXPageUrl(frameUrl) && isXPageUrl(sender.tab.url ?? '')
    ? 'x-content'
    : 'other';
}

export type CaptureSubmitError =
  | 'not-active'
  | 'stale-epoch'
  | 'invalid'
  | 'wrong-sender'
  | 'no-page'
  | 'too-many'
  | 'storage';

/** Result of one submit batch. `ok` never means "all stored": a batch may be
 * partially admissible, and the counts say exactly what happened. */
export type CaptureSubmitResult =
  | { ok: true; stored: number; skipped: number }
  | { ok: false; error: CaptureSubmitError; detail: string };

export function isCaptureSubmitResult(value: unknown): value is CaptureSubmitResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    return (
      typeof record.stored === 'number' &&
      Number.isInteger(record.stored) &&
      record.stored >= 0 &&
      typeof record.skipped === 'number' &&
      Number.isInteger(record.skipped) &&
      record.skipped >= 0
    );
  }
  return record.ok === false && typeof record.error === 'string' && typeof record.detail === 'string';
}