import { isRuntimeMessage, type RuntimeMessage } from '../domain/messages';
import {
  EMPTY_PANEL_STATE,
  withClassifyResult,
  withOverride,
  withoutHiddenOfKind,
  withReport,
} from '../domain/panel-state';
import { classifyPost } from '../infrastructure/classifier';
import { updatePanelState } from '../infrastructure/panel-state-store';
import { previewRules } from '../infrastructure/rule-preview';
import { forgetScores } from '../infrastructure/score-cache';
import { saveRules } from '../infrastructure/settings-store';
import { assertNever } from '../lib/assert-never';

const X_ORIGIN = 'https://x.com/';

/** Bumped by `clear-data`. A classification that started before a clear must not
 * write its failure notice into the freshly emptied panel afterwards. */
let dataEpoch = 0;

async function broadcastToX(message: RuntimeMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `${X_ORIGIN}*` });
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, message).catch(() => undefined),
    ),
  );
}

async function handle(message: RuntimeMessage): Promise<unknown> {
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
      // Tells every content script to drop its local state, so an in-flight
      // judgement on the page cannot write records back after the clear.
      await broadcastToX(message);
      return undefined;
    case 'save-rules':
      return saveRules(message.rules, message.expectedRevision);
    case 'preview-rule':
      return previewRules(message.input);
    default:
      return assertNever(message);
  }
}

function enablePanelForTab(tabId: number, url: string | undefined): Promise<void> {
  return chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: url?.startsWith(X_ORIGIN) ?? false,
  });
}

async function restrictPanelToX(): Promise<void> {
  await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: false });
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? undefined : enablePanelForTab(tab.id, tab.url))),
  );
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  void restrictPanelToX();

  chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    void enablePanelForTab(tabId, tab.url);
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(message)) return false;
    handle(message).then(sendResponse, (error: unknown) => {
      sendResponse({
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  });
});
