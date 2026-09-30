import { isExtractedArticle, type ExtractedArticle } from '../domain/article';
import type { JudgedPage, JudgePageResult } from '../domain/article-judgement';
import {
  articleQuestions,
  articleState,
  gateBeforeModel,
  judgeArticle,
} from '../domain/article-rules';
import { classifyText, type TextOutcome } from './classifier';

/** What the judgement needs from the outside, so the flow can be tested without
 * a browser or a network. */
export interface ArticleJudgeDeps {
  /** Reads the tab. Rejects when the browser refuses to. */
  extract(tabId: number): Promise<unknown>;
  classify(state: unknown, questions: Record<string, string>): Promise<TextOutcome>;
}

/** The unlisted script `article-extractor` is built to this path in the bundle. */
const EXTRACTOR_FILE = '/article-extractor.js';

export async function extractFromTab(tabId: number): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: [EXTRACTOR_FILE],
  });
  return results[0]?.result;
}

const DEFAULT_DEPS: ArticleJudgeDeps = { extract: extractFromTab, classify: classifyText };

function extractedFrom(value: unknown): ExtractedArticle | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.ok === true && isExtractedArticle(record.article) ? record.article : null;
}

export type ReadResult =
  | { ok: true; article: ExtractedArticle }
  | { ok: false; error: 'no-access' | 'extract-failed'; detail: string };

/** Reads the page in one tab. The browser decides whether it may (`activeTab` for
 * a manual judgement, a site authorisation for auto mode). */
export async function readArticle(
  tabId: number,
  extract: ArticleJudgeDeps['extract'] = extractFromTab,
): Promise<ReadResult> {
  let raw: unknown;
  try {
    raw = await extract(tabId);
  } catch (error) {
    return {
      ok: false,
      error: 'no-access',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const article = extractedFrom(raw);
  if (article === null) {
    return { ok: false, error: 'extract-failed', detail: 'no readable page content came back' };
  }
  return { ok: true, article };
}

export function pageOf(article: ExtractedArticle): JudgedPage {
  return { url: article.url, title: article.title, units: article.units };
}

/**
 * Judges the page in one tab, once, on request.
 *
 * Order matters and is fixed: read the page, run the code gate, and only if the
 * gate passes send anything to the model. A page the gate refuses costs nothing
 * and its text goes nowhere. Nothing is stored: the page text lives in this
 * function and is gone when it returns.
 */
export async function judgePage(
  tabId: number,
  deps: ArticleJudgeDeps = DEFAULT_DEPS,
): Promise<JudgePageResult> {
  const read = await readArticle(tabId, deps.extract);
  if (!read.ok) return read;
  const { article } = read;

  const page = pageOf(article);
  const refused = gateBeforeModel(article);
  if (refused !== null) {
    return { ok: true, page, verdict: { kind: 'not-article', reason: refused }, tokens: 0 };
  }

  const outcome = await deps.classify(articleState(article), articleQuestions());
  if (!outcome.ok) return { ok: false, error: outcome.error, detail: outcome.detail };
  return { ok: true, page, verdict: judgeArticle(article, outcome.scores), tokens: outcome.tokens };
}
