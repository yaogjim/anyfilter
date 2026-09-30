import {
  isCaptureOutcome,
  isCaptureRunState,
  MAX_OBSERVATIONS_PER_MESSAGE,
  type CaptureOutcome,
  type CaptureRunState,
} from './capture';
import { isLabellerId, type LabellerId } from './evaluation-pricing';
import { isMachineLabellerId, MAX_KEY_LENGTH, type MachineLabellerId } from './machine-label';
import { isVerificationDetailRequest, isVerificationRunRequest } from './evaluation-verification';
import { isPost, type Post, type PostKind } from './post';
import { isReviewSaveInput, type ReviewSaveInput } from './review-record';
import { isPreviewInput, isRule, type PreviewInput, type Rule } from './rule';
import { isReason, isScores, type Reason, type Scores } from './verdict';

export type RuntimeMessage =
  | { type: 'classify'; post: Post; questions: Record<string, string>; questionsKey: string }
  | { type: 'report'; post: Post; reasons: Reason[]; tokens: number }
  | { type: 'override'; postId: string; shown: boolean }
  | { type: 'clear-hidden'; kind: PostKind }
  | { type: 'clear-data' }
  | { type: 'save-rules'; rules: Rule[]; expectedRevision: number }
  | { type: 'preview-rule'; input: PreviewInput }
  /** Content script to background: already-loaded posts it read from the page.
   * `epoch` is the run state version the content script observed, so a batch that
   * started before a pause or a delete is refused rather than written. */
  | { type: 'capture-submit'; epoch: number; posts: Post[] }
  /** Content script to background: what the production feed did with
   * already-captured samples. Carries the same epoch guard as a submit. */
  | { type: 'capture-outcome'; epoch: number; outcomes: CaptureOutcome[] }
  /** Extension page to background: the only way to move the run state. */
  | { type: 'capture-set-state'; runState: CaptureRunState }
  /** Extension page to background: delete every stored sample. */
  | { type: 'capture-clear' }
  /** Extension page to background: switch the verification budget on with the
   * pinned price and cap. Carries nothing: no price, endpoint or key. */
  | { type: 'jev-enable-budget' }
  /** Extension page to background: read the exact stored text of one sample, so
   * a person can inspect the whole post before confirming that it may be sent.
   * Read-only, local and never logged. */
  | { type: 'jev-sample-detail'; sampleId: string }
  /** Extension page to background: run exactly one stored sample against exactly
   * one enabled semantic rule. Authorization is decided from the sender, never
   * claimed by the message. */
  | { type: 'jev-run-sample'; sampleId: string; ruleId: string }
  /** Extension page to background: switch the verification budget off. Every
   * still-open job becomes `unknown` and keeps its reservation, because a request
   * that was already sent may already have been charged, and the epoch is bumped
   * so a late answer is refused. Carries nothing: no price, endpoint or key. */
  | { type: 'jev-disable-budget' }
  /** Extension page to background: the spending picture per labeller and the
   * size of the run. Read-only. */
  | { type: 'eval-overview' }
  /** Extension page to background: whether each labeller has a key. Never a key. */
  | { type: 'eval-key-status' }
  /** Extension page to background: store or clear (empty string) one machine
   * labeller's key. Only the two machine labellers have a key here; Jev's key
   * stays in the normal settings. */
  | { type: 'eval-set-key'; labeller: MachineLabellerId; key: string }
  /** Extension page to background: where each machine labeller is reached and
   * which model it is asked for. Not a secret. */
  | { type: 'eval-connection-status' }
  | { type: 'eval-set-connection'; labeller: MachineLabellerId; baseUrl: string; model: string }
  /** Extension page to background: run one labeller over every stored sample and
   * enabled semantic rule. Authorization is derived from the sender. */
  | { type: 'eval-batch-start'; labeller: LabellerId }
  /** Extension page to background: stop before the next task. */
  | { type: 'eval-batch-stop' }
  | { type: 'eval-batch-status' }
  /** Extension page to background: everything a report needs, to be saved by hand. */
  | { type: 'eval-export' }
  /** X content script to background: store or correct one annotation. `epoch` is
   * the store version the page read, so a save from before a delete is refused. */
  | { type: 'review-save'; epoch: number; input: ReviewSaveInput }
  /** X content script to background: undo one annotation. */
  | { type: 'review-remove'; epoch: number; sampleId: string; inputHash: string; rulesFingerprint: string }
  /** X content script to background: read every stored annotation. */
  | { type: 'review-load' }
  /** Extension page to background: delete every annotation. */
  | { type: 'review-clear' }
  /** Background to X content scripts: annotations were deleted, read them again. */
  | { type: 'review-reload' }
  /** Extension page to background: read the page in this tab and judge it once.
   * Only our own pages may ask; the tab is named by the person's click. */
  | { type: 'judge-page'; tabId: number };

export type ClassifyError = 'no-key' | 'rate-limited' | 'auth' | 'network' | 'bad-response';

export type ClassifyResult =
  | { ok: true; scores: Scores; tokens: number }
  | { ok: false; error: ClassifyError; detail: string };

const CLASSIFY_ERRORS: readonly ClassifyError[] = [
  'no-key',
  'rate-limited',
  'auth',
  'network',
  'bad-response',
];

export function isClassifyError(value: unknown): value is ClassifyError {
  return CLASSIFY_ERRORS.some((error) => error === value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return record !== null && Object.values(record).every((item) => typeof item === 'string');
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  const record = asRecord(value);
  if (!record) return false;
  switch (record.type) {
    case 'classify':
      return (
        isPost(record.post) &&
        isStringRecord(record.questions) &&
        typeof record.questionsKey === 'string'
      );
    case 'report':
      return (
        isPost(record.post) &&
        Array.isArray(record.reasons) &&
        record.reasons.every(isReason) &&
        typeof record.tokens === 'number'
      );
    case 'override':
      return typeof record.postId === 'string' && typeof record.shown === 'boolean';
    case 'clear-hidden':
      return record.kind === 'post' || record.kind === 'reply';
    case 'clear-data':
      return true;
    case 'save-rules':
      return (
        Array.isArray(record.rules) &&
        record.rules.every(isRule) &&
        typeof record.expectedRevision === 'number'
      );
    case 'preview-rule':
      return isPreviewInput(record.input);
    case 'capture-submit':
      return (
        typeof record.epoch === 'number' &&
        Number.isInteger(record.epoch) &&
        record.epoch >= 0 &&
        Array.isArray(record.posts) &&
        record.posts.length <= MAX_OBSERVATIONS_PER_MESSAGE &&
        record.posts.every(isPost)
      );
    case 'capture-outcome':
      return (
        typeof record.epoch === 'number' &&
        Number.isInteger(record.epoch) &&
        record.epoch >= 0 &&
        Array.isArray(record.outcomes) &&
        record.outcomes.length <= MAX_OBSERVATIONS_PER_MESSAGE &&
        record.outcomes.every(isCaptureOutcome)
      );
    case 'capture-set-state':
      return isCaptureRunState(record.runState);
    case 'capture-clear':
      return true;
    case 'jev-enable-budget':
      return true;
    case 'jev-disable-budget':
      return true;
    case 'jev-sample-detail':
      return isVerificationDetailRequest(record);
    case 'jev-run-sample':
      return isVerificationRunRequest(record);
    case 'eval-overview':
    case 'eval-key-status':
    case 'eval-connection-status':
    case 'eval-batch-stop':
    case 'eval-batch-status':
    case 'eval-export':
      return true;
    case 'eval-set-key':
      return (
        isMachineLabellerId(record.labeller) &&
        typeof record.key === 'string' &&
        record.key.length <= MAX_KEY_LENGTH
      );
    case 'eval-set-connection':
      return (
        isMachineLabellerId(record.labeller) &&
        typeof record.baseUrl === 'string' &&
        record.baseUrl.length <= 200 &&
        typeof record.model === 'string' &&
        record.model.length <= 80
      );
    case 'eval-batch-start':
      return isLabellerId(record.labeller);
    case 'review-save':
      return (
        typeof record.epoch === 'number' &&
        Number.isInteger(record.epoch) &&
        record.epoch >= 0 &&
        isReviewSaveInput(record.input)
      );
    case 'review-remove':
      return (
        typeof record.epoch === 'number' &&
        Number.isInteger(record.epoch) &&
        record.epoch >= 0 &&
        typeof record.sampleId === 'string' && record.sampleId.length <= 64 &&
        typeof record.inputHash === 'string' && record.inputHash.length <= 32 &&
        typeof record.rulesFingerprint === 'string' && record.rulesFingerprint.length <= 64
      );
    case 'review-load':
    case 'review-clear':
    case 'review-reload':
      return true;
    case 'judge-page':
      return typeof record.tabId === 'number' && Number.isInteger(record.tabId) && record.tabId >= 0;
    default:
      return false;
  }
}

export function isClassifyResult(value: unknown): value is ClassifyResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) return isScores(record.scores) && typeof record.tokens === 'number';
  return record.ok === false && isClassifyError(record.error) && typeof record.detail === 'string';
}
