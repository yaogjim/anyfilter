import type { AutoState } from '../../domain/auto-mode';
import type { JudgePageResult } from '../../domain/article-judgement';
import type { ReviewRecord } from '../../domain/review-record';
import type { CaptureRunState, CaptureState } from '../../domain/capture';
import type { EvaluationConnections, LabellerId } from '../../domain/evaluation-pricing';
import type {
  EvaluationExport,
  EvaluationOverview,
  EvaluationRunStartResult,
  EvaluationRunStatus,
} from '../../domain/evaluation-run';
import type { MachineLabellerId } from '../../domain/machine-label';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import type {
  VerificationBudgetStatus,
  VerificationCandidate,
  VerificationDetailResult,
  VerificationEnableResult,
  VerificationRunResult,
  VerificationStopResult,
} from '../../domain/evaluation-verification';
import type { PanelState } from '../../domain/panel-state';
import type { PostKind } from '../../domain/post';
import type { PreviewInput, PreviewResult, Rule, SaveRulesResult } from '../../domain/rule';
import type { Settings } from '../../domain/settings';

/** The tab the person is looking at. `url` is only known when the browser lets an
 * extension see it (an X tab, or a tab the icon was clicked on). */
export interface ActiveTab {
  id: number | null;
  url: string | null;
}

/** "This page": which tab is active, and the one background call that reads and
 * judges it. Side panel only; the options page has no active page to judge. */
export interface PageGateway {
  loadActiveTab(): Promise<ActiveTab>;
  onActiveTabChanged(listener: (tab: ActiveTab) => void): () => void;
  judgePage(tabId: number): Promise<JudgePageResult>;
  /** Auto mode. The state and the results are read where they are stored; the
   * switch and its restarts go through the background, which is the only writer. */
  loadAutoState(): Promise<AutoState>;
  onAutoStateChanged(listener: (state: AutoState) => void): () => void;
  setAutoEnabled(enabled: boolean): Promise<AutoState | null>;
  resumeAuto(): Promise<AutoState | null>;
  resetAutoSpend(): Promise<AutoState | null>;
  /** The automatic result for this tab, only if it was made for the page now showing. */
  loadAutoResult(tabId: number, address: string): Promise<JudgePageResult | null>;
  onAutoResultsChanged(listener: () => void): () => void;
  /** Site authorisations are the browser's optional host permissions. */
  listAuthorisedSites(): Promise<string[]>;
  onAuthorisedSitesChanged(listener: () => void): () => void;
  requestSite(pattern: string): Promise<boolean>;
  removeSite(pattern: string): Promise<boolean>;
}

export interface PanelGateway {
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
  loadPanelState(): Promise<PanelState>;
  onPanelStateChanged(listener: (state: PanelState) => void): () => void;
  saveRules(rules: Rule[], expectedRevision: number): Promise<SaveRulesResult>;
  previewRule(input: PreviewInput): Promise<PreviewResult>;
  override(postId: string, shown: boolean): Promise<void>;
  clearData(): Promise<void>;
  clearHidden(kind: PostKind): Promise<void>;
  /** Verification library: read locally, mutate only through the background, which
   * validates the sender and is the only writer. */
  loadCaptureState(): Promise<CaptureState>;
  onCaptureStateChanged(listener: (state: CaptureState) => void): () => void;
  setCaptureRunState(runState: CaptureRunState): Promise<CaptureState>;
  clearCapture(): Promise<CaptureState>;
  /** Manual single-sample verification: the candidate list and the spending
   * picture are read locally, and the only two mutations go through the
   * background, which refuses a request that is not from one of our own pages. */
  loadVerificationCandidates(): Promise<VerificationCandidate[]>;
  loadVerificationStatus(): Promise<VerificationBudgetStatus>;
  /** Read-only local preview of one selected sample's exact stored text. It is
   * served only to our own pages, writes nothing and reaches no network. */
  loadVerificationSampleDetail(sampleId: string): Promise<VerificationDetailResult>;
  enableVerificationBudget(): Promise<VerificationEnableResult>;
  /** Stops the budget through the background. New requests are refused while it
   * is off; a request that was already sent may still be charged, so an unknown
   * reservation is never refunded. */
  disableVerificationBudget(): Promise<VerificationStopResult>;
  runVerificationSample(sampleId: string, ruleId: string): Promise<VerificationRunResult>;
  /** Review annotations: counted locally, deleted only through the background. */
  loadReviewCount(): Promise<number>;
  onReviewCountChanged(listener: () => void): () => void;
  clearReviewRecords(): Promise<void>;
  /** Every stored review label with the post text, for a file the person saves. */
  exportReviewRecords(): Promise<ReviewRecord[]>;
  /** Real evaluation: every mutation goes through the background, which refuses a
   * sender that is not one of our own pages. Keys can be set but never read. */
  loadEvaluationOverview(): Promise<EvaluationOverview | null>;
  loadKeyPresence(): Promise<KeyPresence | null>;
  setEvaluationKey(labeller: MachineLabellerId, key: string): Promise<{ ok: boolean; keys: KeyPresence } | null>;
  loadEvaluationConnections(): Promise<EvaluationConnections | null>;
  setEvaluationConnection(
    labeller: MachineLabellerId,
    baseUrl: string,
    model: string,
  ): Promise<{ ok: boolean; connections: EvaluationConnections } | null>;
  startEvaluationBatch(labeller: LabellerId): Promise<EvaluationRunStartResult>;
  stopEvaluationBatch(): Promise<EvaluationRunStatus | null>;
  loadEvaluationRunStatus(): Promise<EvaluationRunStatus | null>;
  exportEvaluation(): Promise<EvaluationExport | null>;
}