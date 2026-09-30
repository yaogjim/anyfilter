import type { ExtractedArticle } from '../domain/article';
import type { JudgePageResult } from '../domain/article-judgement';
import {
  articleQuestions,
  articleState,
  gateBeforeModel,
  judgeArticle,
  thresholdOf,
  ARTICLE_RULES,
  type ArticleVerdict,
} from '../domain/article-rules';
import {
  AUTO_MAX_QUEUE,
  AUTO_MIN_GAP_MS,
  AUTO_RESULT_TTL_MS,
  beginRequest,
  hostOfPattern,
  neverAuto,
  originPatternOf,
  pageKeyOf,
  resumed,
  settleRequest,
  withEnabled,
  withSpendReset,
  type AutoState,
} from '../domain/auto-mode';
import { translate } from '../ui/i18n';
import { extractFromTab, pageOf, readArticle } from './article-judge';
import {
  clearAutoResults,
  loadAutoResults,
  loadAutoState,
  saveAutoResults,
  saveAutoState,
  type AutoResults,
} from './auto-store';
import { classifyText, type TextOutcome } from './classifier';
import { loadUiLocale } from './ui-locale';

/**
 * Auto mode: reads and judges a page without a click, on sites the person has
 * authorised. The rules that bound it are in `domain/auto-mode.ts`; the flow is
 * in docs/auto-mode.md. Everything outside the process is passed in, so the whole
 * flow can be tested without a browser.
 */
export interface TabInfo {
  url: string | undefined;
  active: boolean;
  status: string | undefined;
}

export interface AutoDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  loadState(): Promise<AutoState>;
  saveState(state: AutoState): Promise<void>;
  loadResults(): Promise<AutoResults>;
  saveResults(results: AutoResults): Promise<void>;
  getTab(tabId: number): Promise<TabInfo | undefined>;
  hasPermission(pattern: string): Promise<boolean>;
  extract(tabId: number): Promise<unknown>;
  classify(state: unknown, questions: Record<string, string>): Promise<TextOutcome>;
  hash(text: string): Promise<string>;
  showBadge(tabId: number, verdict: ArticleVerdict): void;
  clearBadge(tabId: number): void;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const BADGE_TEXT = { marketing: 'MKT', clickbait: 'BAIT' } as const;
const BADGE_COLOR = '#b3261e';

async function showBadge(tabId: number, verdict: ArticleVerdict): Promise<void> {
  const top = verdict.kind === 'judged' ? verdict.top : null;
  try {
    if (top === null) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'AnyFilter' });
      return;
    }
    const locale = await loadUiLocale();
    const rule = ARTICLE_RULES.find((candidate) => candidate.id === top.rule);
    const label = translate(locale, top.rule === 'marketing' ? 'page.rule.marketing' : 'page.rule.clickbait');
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT[top.rule] });
    await chrome.action.setTitle({
      tabId,
      title: `AnyFilter — ${translate(locale, 'page.match', {
        label,
        probability: Math.round(top.probability * 100),
        threshold: Math.round((rule === undefined ? 0.7 : thresholdOf(rule)) * 100),
      })}`,
    });
  } catch {
    // The tab may have closed between the answer and the badge.
  }
}

async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'AnyFilter' });
  } catch {
    // The tab is gone.
  }
}

export function chromeAutoDeps(): AutoDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState: loadAutoState,
    saveState: saveAutoState,
    loadResults: loadAutoResults,
    saveResults: saveAutoResults,
    async getTab(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        return { url: tab.url, active: tab.active, status: tab.status };
      } catch {
        return undefined;
      }
    },
    async hasPermission(pattern) {
      try {
        return await chrome.permissions.contains({ origins: [pattern] });
      } catch {
        return false;
      }
    },
    extract: extractFromTab,
    classify: classifyText,
    hash: sha256,
    showBadge: (tabId, verdict) => void showBadge(tabId, verdict),
    clearBadge: (tabId) => void clearBadge(tabId),
  };
}

export interface AutoRunner {
  /** Looks at a tab and, if every condition holds, queues one judgement. */
  consider(tabId: number): Promise<void>;
  forgetTab(tabId: number): Promise<void>;
  setEnabled(enabled: boolean): Promise<AutoState>;
  resume(): Promise<AutoState>;
  resetSpend(): Promise<AutoState>;
  clearResults(): Promise<void>;
  /** Resolves when nothing is queued or running. Used by tests. */
  idle(): Promise<void>;
}

export function createAutoRunner(deps: AutoDeps): AutoRunner {
  /** The page each tab was last considered for, so a reload does not repeat work. */
  const attempted = new Map<number, string>();
  const queue: number[] = [];
  let working: Promise<void> | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let chain: Promise<unknown> = Promise.resolve();

  /** Storage is read-modify-written from one place at a time. */
  function locked<T>(run: () => Promise<T>): Promise<T> {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  }

  function mutateState<T>(change: (state: AutoState) => { state: AutoState; value: T }): Promise<T> {
    return locked(async () => {
      const { state, value } = change(await deps.loadState());
      await deps.saveState(state);
      return value;
    });
  }

  function mutateResults(change: (results: AutoResults) => AutoResults): Promise<void> {
    return locked(async () => {
      await deps.saveResults(change(await deps.loadResults()));
    });
  }

  async function usable(tabId: number): Promise<{ url: string; pattern: string } | null> {
    const tab = await deps.getTab(tabId);
    if (tab === undefined || !tab.active || tab.status !== 'complete' || tab.url === undefined) return null;
    const pattern = originPatternOf(tab.url);
    if (pattern === null) return null;
    const host = hostOfPattern(pattern);
    if (host === null || neverAuto(host)) return null;
    if (!(await deps.hasPermission(pattern))) return null;
    return { url: tab.url, pattern };
  }

  async function processTab(tabId: number): Promise<void> {
    const ready = await usable(tabId);
    if (ready === null) {
      attempted.delete(tabId);
      return;
    }
    const pageKey = pageKeyOf(ready.url);
    const before = await deps.loadResults();
    const known = before.tabs[String(tabId)];
    if (known?.url === pageKey) {
      // Already judged (the worker may have restarted): show it again, ask nobody.
      if (known.result.ok) deps.showBadge(tabId, known.result.verdict);
      return;
    }

    const read = await readArticle(tabId, deps.extract);
    if (!read.ok) return;
    const article = read.article;
    const page = pageOf(article);

    let verdict: ArticleVerdict;
    let tokens = 0;
    const refused = gateBeforeModel(article);
    if (refused !== null) {
      verdict = { kind: 'not-article', reason: refused };
    } else {
      const cacheKey = await deps.hash(`${article.url}\n${article.text}`);
      const hit = before.cache[cacheKey];
      if (hit !== undefined && deps.now() - hit.at < AUTO_RESULT_TTL_MS) {
        verdict = hit.verdict;
      } else {
        const outcome = await modelJudgement(article, tabId);
        if (outcome === null) return;
        verdict = outcome.verdict;
        tokens = outcome.tokens;
        if (outcome.complete) {
          await mutateResults((results) => ({
            ...results,
            cache: { ...results.cache, [cacheKey]: { at: deps.now(), verdict } },
          }));
        }
      }
    }

    const result: JudgePageResult = { ok: true, page, verdict, tokens };
    await mutateResults((results) => ({
      ...results,
      tabs: { ...results.tabs, [String(tabId)]: { url: pageKey, at: deps.now(), result } },
    }));
    deps.showBadge(tabId, verdict);
  }

  /** One paid request, inside the budget. `null` means nothing was sent or nothing
   * usable came back; the reason is already in the counters. */
  async function modelJudgement(
    article: ExtractedArticle,
    tabId: number,
  ): Promise<{ verdict: ArticleVerdict; tokens: number; complete: boolean } | null> {
    const wait = lastRequestAt + AUTO_MIN_GAP_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);

    const begun = await mutateState((state) => {
      const result = beginRequest(state, deps.now());
      return { state: result.state, value: result };
    });
    if (!begun.ok) {
      // Off, paused, cap and daily all mean: not now. The page is tried again
      // when the person comes back to it after lifting the reason.
      attempted.delete(tabId);
      return null;
    }
    lastRequestAt = deps.now();

    let outcome: TextOutcome;
    try {
      outcome = await deps.classify(articleState(article), articleQuestions());
    } catch {
      outcome = { ok: false, error: 'network', detail: 'request failed' };
    }
    await mutateState((state) => ({
      state: settleRequest(
        state,
        begun.reservedMicro,
        outcome.ok ? { ok: true, inputTokens: outcome.tokens } : { ok: false, error: outcome.error },
      ),
      value: undefined,
    }));
    if (!outcome.ok) return null;
    return {
      verdict: judgeArticle(article, outcome.scores),
      tokens: outcome.tokens,
      complete: outcome.complete,
    };
  }

  function drain(): Promise<void> {
    if (working !== null) return working;
    working = (async () => {
      try {
        while (queue.length > 0) {
          const tabId = queue.shift();
          if (tabId === undefined) break;
          try {
            await processTab(tabId);
          } catch {
            // One page must not stop the queue.
          }
        }
      } finally {
        working = null;
      }
    })();
    return working;
  }

  function enqueue(tabId: number): void {
    if (queue.includes(tabId)) return;
    queue.push(tabId);
    while (queue.length > AUTO_MAX_QUEUE) {
      const dropped = queue.shift();
      if (dropped !== undefined) attempted.delete(dropped);
    }
    void drain();
  }

  return {
    async consider(tabId) {
      // Cheap checks first: with the switch off nothing else is even looked at.
      const state = await deps.loadState();
      if (!state.enabled || state.paused) return;
      const ready = await usable(tabId);
      if (ready === null) return;
      const pageKey = pageKeyOf(ready.url);
      if (attempted.get(tabId) === pageKey) {
        // Already handled in this worker's life. The browser drops a tab's badge when it
        // navigates (a reload too), so put the stored answer back; ask nobody.
        const known = (await deps.loadResults()).tabs[String(tabId)];
        if (known?.url === pageKey && known.result.ok) deps.showBadge(tabId, known.result.verdict);
        return;
      }
      attempted.set(tabId, pageKey);
      deps.clearBadge(tabId);
      enqueue(tabId);
    },
    async forgetTab(tabId) {
      attempted.delete(tabId);
      await mutateResults((results) => {
        const { [String(tabId)]: _gone, ...tabs } = results.tabs;
        return { ...results, tabs };
      });
    },
    setEnabled: (enabled) => {
      if (!enabled) queue.length = 0;
      return mutateState((state) => ({ state: withEnabled(state, enabled), value: withEnabled(state, enabled) }));
    },
    resume: () => mutateState((state) => ({ state: resumed(state), value: resumed(state) })),
    resetSpend: () => mutateState((state) => ({ state: withSpendReset(state), value: withSpendReset(state) })),
    async clearResults() {
      attempted.clear();
      await locked(() => clearAutoResults());
    },
    async idle() {
      while (working !== null) await working;
    },
  };
}
