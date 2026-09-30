import { isJudgePageResult, type JudgePageResult } from '../domain/article-judgement';
import { normalizeAutoState, type AutoState } from '../domain/auto-mode';
import type { ClassifierPort } from '../domain/classifier-port';
import {
  isCaptureState,
  isCaptureSubmitResult,
  type CaptureOutcome,
  type CaptureRunState,
  type CaptureState,
  type CaptureSubmitResult,
} from '../domain/capture';
import { isClassifyResult, type ClassifyResult, type RuntimeMessage } from '../domain/messages';
import type { Post, PostKind } from '../domain/post';
import {
  isPreviewResult,
  isSaveRulesResult,
  type PreviewInput,
  type PreviewResult,
  type Rule,
  type SaveRulesResult,
} from '../domain/rule';
import { isGenerateRuleResult, type GenerateRuleInput, type GenerateRuleResult } from '../domain/rule-draft';
import type { RuleGroup } from '../domain/rule-group';
import {
  isVerificationDetailResult,
  isVerificationEnableResult,
  isVerificationRunResult,
  isVerificationStopResult,
  type VerificationDetailResult,
  type VerificationEnableResult,
  type VerificationRunResult,
  type VerificationStopResult,
} from '../domain/evaluation-verification';
import {
  isReviewLoadResult,
  isReviewSaveResult,
  type ReviewLoadResult,
  type ReviewSaveInput,
  type ReviewSaveResult,
} from '../domain/review-record';
import type { LabellerId } from '../domain/evaluation-pricing';
import {
  isEvaluationOverview,
  isEvaluationRunStartResult,
  isEvaluationRunStatus,
  idleRunStatus,
  type EvaluationExport,
  type EvaluationOverview,
  type EvaluationRunStartResult,
  type EvaluationRunStatus,
} from '../domain/evaluation-run';
import type { MachineLabellerId } from '../domain/machine-label';
import type { Reason } from '../domain/verdict';
import type { VerdictSink } from '../domain/verdict-sink';
import { loadCaptureState } from './capture-store';
import { isEvaluationConnections, type EvaluationConnections } from '../domain/evaluation-pricing';
import { isKeyPresence, type KeyPresence } from './evaluation-keys';
import { loadVerificationStatus } from './evaluation-verification';

async function send(message: RuntimeMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

export class BackgroundClient implements ClassifierPort, VerdictSink {
  async classify(
    post: Post,
    questions: Record<string, string>,
    questionsKey: string,
  ): Promise<ClassifyResult> {
    try {
      const response = await send({ type: 'classify', post, questions, questionsKey });
      return isClassifyResult(response)
        ? response
        : { ok: false, error: 'bad-response', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  report(post: Post, reasons: Reason[], tokens: number): void {
    void send({ type: 'report', post, reasons, tokens }).catch(() => undefined);
  }

  async override(postId: string, shown: boolean): Promise<void> {
    await send({ type: 'override', postId, shown });
  }

  /** Asks the background to read the page in one tab and judge it. */
  async judgePage(tabId: number): Promise<JudgePageResult> {
    try {
      const response = await send({ type: 'judge-page', tabId });
      return isJudgePageResult(response)
        ? response
        : { ok: false, error: 'bad-response', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The auto mode switch and its two restarts. The reply is the new state. */
  async setAutoEnabled(enabled: boolean): Promise<AutoState | null> {
    return this.autoCall({ type: 'auto-set-enabled', enabled });
  }

  async resumeAuto(): Promise<AutoState | null> {
    return this.autoCall({ type: 'auto-resume' });
  }

  async resetAutoSpend(): Promise<AutoState | null> {
    return this.autoCall({ type: 'auto-reset-spend' });
  }

  private async autoCall(message: RuntimeMessage): Promise<AutoState | null> {
    try {
      const response = await send(message);
      return response === null || response === undefined ? null : normalizeAutoState(response);
    } catch {
      return null;
    }
  }

  async clearData(): Promise<void> {
    await send({ type: 'clear-data' });
  }

  async clearHidden(kind: PostKind): Promise<void> {
    await send({ type: 'clear-hidden', kind });
  }

  async saveRules(rules: Rule[], expectedRevision: number, groups: RuleGroup[]): Promise<SaveRulesResult> {
    try {
      const response = await send({ type: 'save-rules', rules, expectedRevision, groups });
      return isSaveRulesResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'invalid',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async generateRule(input: GenerateRuleInput): Promise<GenerateRuleResult> {
    try {
      const response = await send({ type: 'generate-rule', input });
      return isGenerateRuleResult(response)
        ? response
        : { ok: false, error: 'bad-response', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async previewRule(input: PreviewInput): Promise<PreviewResult> {
    try {
      const response = await send({ type: 'preview-rule', input });
      return isPreviewResult(response)
        ? response
        : { ok: false, error: 'bad-response', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Hands already-read posts to the background. Never called for own, text-less
   * or protected posts, and the background re-checks the run state and the epoch
   * before storing anything. */
  async submitCapture(epoch: number, posts: Post[]): Promise<CaptureSubmitResult> {
    try {
      const response = await send({ type: 'capture-submit', epoch, posts });
      return isCaptureSubmitResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'storage',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Hands one batch of filtering outcomes to the background, which re-checks the
   * sender, the run state and the epoch before attaching anything. */
  async recordOutcomes(
    epoch: number,
    outcomes: readonly CaptureOutcome[],
  ): Promise<CaptureSubmitResult> {
    try {
      const response = await send({ type: 'capture-outcome', epoch, outcomes: [...outcomes] });
      return isCaptureSubmitResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'storage',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Asks the background to move the capture run state. A refused request (wrong
   * sender) resolves to the unchanged state, which is read from storage. */
  async setCaptureRunState(runState: CaptureRunState): Promise<CaptureState> {
    try {
      const response = await send({ type: 'capture-set-state', runState });
      return isCaptureState(response) ? response : await loadCaptureState();
    } catch {
      return loadCaptureState();
    }
  }

  /** Asks the background to delete every verification sample. */
  async clearCapture(): Promise<CaptureState> {
    try {
      const response = await send({ type: 'capture-clear' });
      return isCaptureState(response) ? response : await loadCaptureState();
    } catch {
      return loadCaptureState();
    }
  }

  /**
   * Asks the background to switch the verification budget on with the pinned
   * price and cap. It sends no price, endpoint or key, and a refusal comes back
   * with the unchanged status.
   */
  async enableVerificationBudget(): Promise<VerificationEnableResult> {
    try {
      const response = await send({ type: 'jev-enable-budget' });
      if (isVerificationEnableResult(response)) return response;
      return {
        ok: false,
        detail: 'malformed response from background',
        status: await loadVerificationStatus(),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        status: await loadVerificationStatus(),
      };
    }
  }

  /**
   * Asks the background to switch the verification budget off. The stop keeps
   * every unknown reservation held: a request that was already sent may already
   * have been charged, so it is never refunded here. A refusal comes back with
   * the unchanged status.
   */
  async disableVerificationBudget(): Promise<VerificationStopResult> {
    try {
      const response = await send({ type: 'jev-disable-budget' });
      if (isVerificationStopResult(response)) return response;
      return {
        ok: false,
        detail: 'malformed response from background',
        status: await loadVerificationStatus(),
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        status: await loadVerificationStatus(),
      };
    }
  }

  /**
   * Asks the background for the exact stored text of one sample, so the user can
   * read the whole post before confirming it may be sent. The message names only
   * the one sample id; the background re-checks the sender and refuses anything
   * else. A malformed or refused answer is reported as unreadable, which keeps
   * the send button disabled.
   */
  async loadVerificationSampleDetail(sampleId: string): Promise<VerificationDetailResult> {
    try {
      const response = await send({ type: 'jev-sample-detail', sampleId });
      return isVerificationDetailResult(response)
        ? response
        : { ok: false, reason: 'unreadable', message: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        reason: 'unreadable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Asks the background to run one stored sample against one enabled semantic
   * rule. The message names only those two ids; the background re-checks the
   * sender and derives the authorization itself.
   */
  async runVerificationSample(sampleId: string, ruleId: string): Promise<VerificationRunResult> {
    try {
      const response = await send({ type: 'jev-run-sample', sampleId, ruleId });
      return isVerificationRunResult(response)
        ? response
        : { kind: 'skipped', sampleId, ruleId, reason: 'storage', detail: 'malformed response from background' };
    } catch (error) {
      return {
        kind: 'skipped',
        sampleId,
        ruleId,
        reason: 'storage',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Reads every stored review annotation. */
  async loadReviewRecords(): Promise<ReviewLoadResult> {
    try {
      const response = await send({ type: 'review-load' });
      return isReviewLoadResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return { ok: false, error: 'storage', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Stores or corrects one annotation. Success is reported only when the
   * background wrote it. */
  async saveReview(epoch: number, input: ReviewSaveInput): Promise<ReviewSaveResult> {
    try {
      const response = await send({ type: 'review-save', epoch, input });
      return isReviewSaveResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return { ok: false, error: 'storage', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async removeReview(
    epoch: number,
    key: { sampleId: string; inputHash: string; rulesFingerprint: string },
  ): Promise<ReviewSaveResult> {
    try {
      const response = await send({ type: 'review-remove', epoch, ...key });
      return isReviewSaveResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return { ok: false, error: 'storage', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Deletes every review annotation (extension pages only). */
  async clearReviewRecords(): Promise<void> {
    await send({ type: 'review-clear' });
  }
  async loadEvaluationOverview(): Promise<EvaluationOverview | null> {
    try {
      const response = await send({ type: 'eval-overview' });
      return isEvaluationOverview(response) ? response : null;
    } catch {
      return null;
    }
  }

  async loadKeyPresence(): Promise<KeyPresence | null> {
    try {
      const response = await send({ type: 'eval-key-status' });
      return isKeyPresence(response) ? response : null;
    } catch {
      return null;
    }
  }

  async setEvaluationKey(labeller: MachineLabellerId, key: string): Promise<{ ok: boolean; keys: KeyPresence } | null> {
    try {
      const response = (await send({ type: 'eval-set-key', labeller, key })) as { ok?: unknown; keys?: unknown } | null;
      return response !== null && typeof response.ok === 'boolean' && isKeyPresence(response.keys)
        ? { ok: response.ok, keys: response.keys }
        : null;
    } catch {
      return null;
    }
  }

  async loadEvaluationConnections(): Promise<EvaluationConnections | null> {
    try {
      const response = await send({ type: 'eval-connection-status' });
      return isEvaluationConnections(response) ? response : null;
    } catch {
      return null;
    }
  }

  async setEvaluationConnection(
    labeller: MachineLabellerId,
    baseUrl: string,
    model: string,
  ): Promise<{ ok: boolean; connections: EvaluationConnections } | null> {
    try {
      const response = (await send({ type: 'eval-set-connection', labeller, baseUrl, model })) as {
        ok?: unknown;
        connections?: unknown;
      } | null;
      return response !== null && typeof response.ok === 'boolean' && isEvaluationConnections(response.connections)
        ? { ok: response.ok, connections: response.connections }
        : null;
    } catch {
      return null;
    }
  }

  async startEvaluationBatch(labeller: LabellerId): Promise<EvaluationRunStartResult> {
    try {
      const response = await send({ type: 'eval-batch-start', labeller });
      if (isEvaluationRunStartResult(response)) return response;
      return { ok: false, detail: 'malformed response from background', status: idleRunStatus() };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        status: idleRunStatus(),
      };
    }
  }

  async stopEvaluationBatch(): Promise<EvaluationRunStatus | null> {
    try {
      const response = await send({ type: 'eval-batch-stop' });
      return isEvaluationRunStatus(response) ? response : null;
    } catch {
      return null;
    }
  }

  async loadEvaluationRunStatus(): Promise<EvaluationRunStatus | null> {
    try {
      const response = await send({ type: 'eval-batch-status' });
      return isEvaluationRunStatus(response) ? response : null;
    } catch {
      return null;
    }
  }

  async exportEvaluation(): Promise<EvaluationExport | null> {
    try {
      const response = (await send({ type: 'eval-export' })) as { version?: unknown; samples?: unknown } | null;
      return response !== null && response.version === 1 && Array.isArray(response.samples)
        ? (response as EvaluationExport)
        : null;
    } catch {
      return null;
    }
  }
}
