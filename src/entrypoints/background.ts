import { isRuntimeMessage, type RuntimeMessage } from '../domain/messages';
import {
  MAX_OBSERVATIONS_PER_MESSAGE,
  senderKind,
  xPageOf,
  xPageUrlOf,
  type CaptureState,
  type CaptureSubmitResult,
} from '../domain/capture';
import {
  EMPTY_PANEL_STATE,
  withClassifyResult,
  withOverride,
  withoutHiddenOfKind,
  withReport,
} from '../domain/panel-state';
import {
  clearCaptureSamples,
  loadCaptureState,
  pruneExpiredCaptureSamples,
  recordCaptureOutcomes,
  recordObservations,
  setCaptureRunState,
} from '../infrastructure/capture-store';
import { judgePage } from '../infrastructure/article-judge';
import { recordToolbarClick } from '../infrastructure/toolbar-click';
import { classifyPost } from '../infrastructure/classifier';
import {
  disableVerificationBudget,
  enableVerificationBudget,
  loadVerificationSampleDetail,
  runVerificationSample,
} from '../infrastructure/evaluation-verification';
import { recoverUnsettledEvaluationJobs } from '../infrastructure/evaluation-jobs';
import { loadKeyPresence } from '../infrastructure/evaluation-keys';
import {
  currentRunStatus,
  loadEvaluationExport,
  loadEvaluationOverview,
  setEvaluationKey,
  setEvaluationConnection,
  readEvaluationConnections,
  startEvaluationBatch,
  stopEvaluationBatch,
} from '../infrastructure/evaluation-runner';
import {
  clearReviewRecords,
  loadReviewLoadResult,
  removeReviewRecord,
  saveReviewRecord,
} from '../infrastructure/review-store';
import { updatePanelState } from '../infrastructure/panel-state-store';
import { previewRules } from '../infrastructure/rule-preview';
import { forgetScores } from '../infrastructure/score-cache';
import { saveRules } from '../infrastructure/settings-store';
import type { JudgePageResult } from '../domain/article-judgement';
import type { ReviewSaveResult } from '../domain/review-record';
import { assertNever } from '../lib/assert-never';

const X_ORIGIN = 'https://x.com/';

/** Bumped by `clear-data`. A classification that started before a clear must not
 * write its failure notice into the freshly emptied panel afterwards. */
let dataEpoch = 0;

/** Refused control request. The untouched state is returned, so the caller can
 * only ever observe "nothing happened" — never a state it did not earn. */
function refuseControl(what: string, kind: string): Promise<CaptureState> {
  console.warn(`[AnyFilter] refused ${what} from a ${kind} sender`);
  return loadCaptureState();
}

async function broadcastToX(message: RuntimeMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `${X_ORIGIN}*` });
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, message).catch(() => undefined),
    ),
  );
}

async function handle(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'classify': {
      const epoch = dataEpoch;
      const result = await classifyPost(message.post, message.questions, message.questionsKey);
      if (!result.ok) console.warn('[AnyFilter] classify failed:', result.error, result.detail);
      // A clear that lands mid-flight must not be repopulated by this response.
      if (epoch === dataEpoch) {
        await updatePanelState((state) => withClassifyResult(state, result, Date.now()));
      }
      return result;
    }
    case 'report':
      await updatePanelState((state) =>
        withReport(state, message.post, message.reasons, message.tokens, Date.now()),
      );
      return undefined;
    case 'override':
      await updatePanelState((state) => withOverride(state, message.postId, message.shown));
      await broadcastToX(message);
      return undefined;
    case 'clear-hidden':
      await updatePanelState((state) => withoutHiddenOfKind(state, message.kind));
      return undefined;
    case 'clear-data':
      dataEpoch += 1;
      await forgetScores();
      await updatePanelState(() => EMPTY_PANEL_STATE);
      await clearReviewRecords();
      // Tells every content script to drop its local state, so an in-flight
      // judgement on the page cannot write records back after the clear.
      await broadcastToX(message);
      return undefined;
    case 'save-rules':
      return saveRules(message.rules, message.expectedRevision);
    case 'preview-rule':
      return previewRules(message.input);
    case 'capture-submit': {
      // Only our own content script, running in an X tab, may submit. The page
      // URL is read from the sender and never from the message, so a compromised
      // or confused caller cannot claim a surface it is not on.
      const senderUrl = sender.tab?.url ?? sender.url ?? '';
      if (senderKind(sender, chrome.runtime.id) !== 'x-content') {
        return {
          ok: false,
          error: 'wrong-sender',
          detail: 'capture submissions must come from the X content script',
        } satisfies CaptureSubmitResult;
      }
      const page = xPageOf(senderUrl);
      if (page === null) {
        return {
          ok: false,
          error: 'no-page',
          detail: 'capture is limited to home, search and status pages',
        } satisfies CaptureSubmitResult;
      }
      if (message.posts.length > MAX_OBSERVATIONS_PER_MESSAGE) {
        return {
          ok: false,
          error: 'too-many',
          detail: `at most ${MAX_OBSERVATIONS_PER_MESSAGE} posts per message`,
        } satisfies CaptureSubmitResult;
      }
      return recordObservations({
        epoch: message.epoch,
        page,
        pageUrl: xPageUrlOf(senderUrl),
        capturedAt: Date.now(),
        posts: message.posts,
      });
    }
    case 'capture-outcome': {
      // Only our own content script, running in an X tab, may report what the
      // feed did. The sender is re-checked here; the store then re-checks the run
      // state and the epoch, so a paused or cleared workflow refuses the batch.
      if (senderKind(sender, chrome.runtime.id) !== 'x-content') {
        return {
          ok: false,
          error: 'wrong-sender',
          detail: 'capture outcomes must come from the X content script',
        } satisfies CaptureSubmitResult;
      }
      if (message.outcomes.length > MAX_OBSERVATIONS_PER_MESSAGE) {
        return {
          ok: false,
          error: 'too-many',
          detail: `at most ${MAX_OBSERVATIONS_PER_MESSAGE} outcomes per message`,
        } satisfies CaptureSubmitResult;
      }
      return recordCaptureOutcomes({ epoch: message.epoch, outcomes: message.outcomes });
    }
    case 'capture-set-state': {
      // Only our own pages (side panel, options) may move the run state, so no
      // web page and no content script can start observation.
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') return refuseControl('capture-set-state', kind);
      return setCaptureRunState(message.runState);
    }
    case 'capture-clear': {
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') return refuseControl('capture-clear', kind);
      return clearCaptureSamples();
    }
    case 'jev-sample-detail': {
      // A read-only local preview, served only to our own pages. Its refusals are
      // returned rather than logged: the body must never reach a log line, and the
      // handler writes no store.
      return loadVerificationSampleDetail(sender, chrome.runtime.id, message.sampleId);
    }
    case 'jev-enable-budget': {
      // Switching the budget on is a user action on one of our own pages. A
      // content script or a web page can never move it.
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') {
        console.warn(`[AnyFilter] refused jev-enable-budget from a ${kind} sender`);
      }
      return enableVerificationBudget(sender, chrome.runtime.id);
    }
    case 'jev-disable-budget': {
      // Switching the budget off is a user action on one of our own pages. A
      // content script or a web page can never stop it, and a stop never refunds
      // an unknown reservation.
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') {
        console.warn(`[AnyFilter] refused jev-disable-budget from a ${kind} sender`);
      }
      return disableVerificationBudget(sender, chrome.runtime.id);
    }
    case 'jev-run-sample': {
      // The single paid path out of the extension. The sender check, the rule
      // check and the derived `authorized: true` all live in the verification
      // module so they cannot be bypassed by any other caller.
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') {
        console.warn(`[AnyFilter] refused jev-run-sample from a ${kind} sender`);
      }
      return runVerificationSample(sender, chrome.runtime.id, message.sampleId, message.ruleId);
    }
    case 'eval-overview':
      return senderKind(sender, chrome.runtime.id) === 'extension-page' ? loadEvaluationOverview() : null;
    case 'eval-key-status':
      return senderKind(sender, chrome.runtime.id) === 'extension-page' ? loadKeyPresence() : null;
    case 'eval-set-key':
      return setEvaluationKey(sender, chrome.runtime.id, message.labeller, message.key);
    case 'eval-connection-status':
      return readEvaluationConnections(sender, chrome.runtime.id);
    case 'eval-set-connection':
      return setEvaluationConnection(sender, chrome.runtime.id, message.labeller, {
        baseUrl: message.baseUrl,
        model: message.model,
      });
    case 'eval-batch-start': {
      // The only place a batch of paid calls starts. The sender check and the
      // derived authorization live in the runner; the progress `done` promise is
      // not part of the reply.
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') {
        console.warn(`[AnyFilter] refused eval-batch-start from a ${kind} sender`);
      }
      const { done: _done, ...reply } = await startEvaluationBatch(sender, chrome.runtime.id, message.labeller);
      return reply;
    }
    case 'eval-batch-stop':
      return stopEvaluationBatch(sender, chrome.runtime.id);
    case 'eval-batch-status':
      return senderKind(sender, chrome.runtime.id) === 'extension-page' ? currentRunStatus() : null;
    case 'eval-export':
      return loadEvaluationExport(sender, chrome.runtime.id);
    case 'review-save':
    case 'review-remove':
    case 'review-load': {
      // Annotations come only from our own content script in an X tab. The
      // sender is re-checked here, never trusted from the message.
      if (senderKind(sender, chrome.runtime.id) !== 'x-content') {
        return {
          ok: false,
          error: 'wrong-sender',
          detail: 'annotations must come from the X content script',
        } satisfies ReviewSaveResult;
      }
      if (message.type === 'review-load') return loadReviewLoadResult();
      if (message.type === 'review-save') {
        return saveReviewRecord(message.epoch, message.input, Date.now());
      }
      return removeReviewRecord(message.epoch, message.sampleId, message.inputHash, message.rulesFingerprint);
    }
    case 'review-clear': {
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') {
        console.warn(`[AnyFilter] refused review-clear from a ${kind} sender`);
        return undefined;
      }
      await clearReviewRecords();
      await broadcastToX({ type: 'review-reload' });
      return undefined;
    }
    case 'review-reload':
      // Addressed to a tab's content script, never to the background.
      return undefined;
    case 'judge-page': {
      // The one path that reads an arbitrary page and sends its text out. Only one
      // of our own pages may ask, and the browser only lets the read through on a
      // tab the person opened AnyFilter on (`activeTab`).
      const kind = senderKind(sender, chrome.runtime.id);
      if (kind !== 'extension-page') {
        console.warn(`[AnyFilter] refused judge-page from a ${kind} sender`);
        return { ok: false, error: 'no-access', detail: 'refused' } satisfies JudgePageResult;
      }
      return judgePage(message.tabId);
    }
    default:
      return assertNever(message);
  }
}

/**
 * The panel is available on every tab. It used to be enabled only on X because
 * it only had X features; the "this page" view works anywhere, and its read of a
 * page is decided by the browser (`activeTab`), not by where the panel is on.
 */
async function enablePanel(): Promise<void> {
  await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
}

export default defineBackground(() => {
  // The icon opens the panel from `action.onClicked`, not through the browser's
  // built-in `openPanelOnActionClick`. Only the first grants `activeTab` on the
  // tab that was clicked, and `activeTab` is what lets "judge this page" read a
  // page without asking for access to every site. The behavior flag is stored by
  // the browser, so an install that ran an older version still has it on: turn it
  // off on every start, not only at install.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  chrome.action.onClicked.addListener((tab) => {
    // `sidePanel.open` needs the click's user gesture, so nothing may be awaited
    // before it.
    if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id });
    // An open panel gets no tab event for this click, but its idea of what the
    // tab allows has just changed.
    void recordToolbarClick().catch(() => undefined);
  });

  void enablePanel();
  void pruneExpiredCaptureSamples();
  // Mark requests interrupted by a worker restart as unknown without releasing
  // their reservations or sending them again. The budget store serializes this
  // recovery before any new request can reserve money in this worker.
  void recoverUnsettledEvaluationJobs();

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(message)) return false;
    handle(message, sender).then(sendResponse, (error: unknown) => {
      sendResponse({
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  });
});
