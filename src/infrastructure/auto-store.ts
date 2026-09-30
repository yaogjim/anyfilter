import { normalizeAutoState, pageKeyOf, type AutoState } from '../domain/auto-mode';
import { isJudgePageResult, type JudgePageResult } from '../domain/article-judgement';
import type { ArticleVerdict } from '../domain/article-rules';

/**
 * What auto mode keeps.
 *
 * `local`: the switch and the counters. No address, no page content.
 * `session` (emptied when the browser closes): the latest result per tab, with the
 * page address, and a cache of verdicts by content hash. Never page text.
 */
const STATE_KEY = 'anyfilter.auto';
const RESULTS_KEY = 'anyfilter.auto.results';

export const MAX_TAB_RESULTS = 50;
export const MAX_CACHE_ENTRIES = 200;

export interface AutoTabResult {
  /** The page the result is for, without query or fragment. */
  url: string;
  at: number;
  result: JudgePageResult;
}

export interface AutoCacheEntry {
  at: number;
  verdict: ArticleVerdict;
}

export interface AutoResults {
  tabs: Record<string, AutoTabResult>;
  cache: Record<string, AutoCacheEntry>;
}

export const EMPTY_AUTO_RESULTS: AutoResults = { tabs: {}, cache: {} };

export async function loadAutoState(): Promise<AutoState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeAutoState(stored[STATE_KEY]);
}

export async function saveAutoState(state: AutoState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export function onAutoStateChanged(listener: (state: AutoState) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes[STATE_KEY]) listener(normalizeAutoState(changes[STATE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function normalizeAutoResults(raw: unknown): AutoResults {
  const record = asRecord(raw);
  const tabs: Record<string, AutoTabResult> = {};
  for (const [id, entry] of Object.entries(asRecord(record.tabs))) {
    const item = asRecord(entry);
    if (typeof item.url === 'string' && typeof item.at === 'number' && isJudgePageResult(item.result)) {
      tabs[id] = { url: item.url, at: item.at, result: item.result };
    }
  }
  const cache: Record<string, AutoCacheEntry> = {};
  for (const [key, entry] of Object.entries(asRecord(record.cache))) {
    const item = asRecord(entry);
    if (typeof item.at !== 'number') continue;
    // Reuse the result validator by wrapping the verdict the way a result carries it.
    const probe = { ok: true, page: { url: '', title: '', units: 0 }, verdict: item.verdict, tokens: 0 };
    if (isJudgePageResult(probe)) cache[key] = { at: item.at, verdict: probe.verdict };
  }
  return { tabs, cache };
}

export async function loadAutoResults(): Promise<AutoResults> {
  const stored = await chrome.storage.session.get(RESULTS_KEY);
  return normalizeAutoResults(stored[RESULTS_KEY]);
}

export async function saveAutoResults(results: AutoResults): Promise<void> {
  await chrome.storage.session.set({ [RESULTS_KEY]: trimmed(results) });
}

export async function clearAutoResults(): Promise<void> {
  await chrome.storage.session.remove(RESULTS_KEY);
}

function newestFirst<T extends { at: number }>(entries: Array<[string, T]>): Array<[string, T]> {
  return [...entries].sort((a, b) => b[1].at - a[1].at);
}

export function trimmed(results: AutoResults): AutoResults {
  return {
    tabs: Object.fromEntries(newestFirst(Object.entries(results.tabs)).slice(0, MAX_TAB_RESULTS)),
    cache: Object.fromEntries(newestFirst(Object.entries(results.cache)).slice(0, MAX_CACHE_ENTRIES)),
  };
}

export function onAutoResultsChanged(listener: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'session' && RESULTS_KEY in changes) listener();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** The automatic result for this tab, when it was made for the page now showing. */
export async function loadAutoResultFor(tabId: number, address: string): Promise<JudgePageResult | null> {
  const results = await loadAutoResults();
  const entry = results.tabs[String(tabId)];
  return entry !== undefined && entry.url === pageKeyOf(address) ? entry.result : null;
}
