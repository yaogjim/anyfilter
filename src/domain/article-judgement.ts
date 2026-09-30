import type { ClassifyError } from './messages';
import type { ArticleVerdict, RuleOutcome } from './article-rules';

/** What the panel gets back about a page: enough to say what was judged, never
 * the page text. */
export interface JudgedPage {
  url: string;
  title: string;
  units: number;
}

export type JudgePageError =
  /** The browser refused to read the tab: the toolbar icon was not clicked on it,
   * or the page is one an extension cannot read. */
  | 'no-access'
  /** The page was readable but nothing usable came out of it. */
  | 'extract-failed'
  | ClassifyError;

export type JudgePageResult =
  | { ok: true; page: JudgedPage; verdict: ArticleVerdict; tokens: number }
  | { ok: false; error: JudgePageError; detail: string };

const JUDGE_ERRORS: readonly JudgePageError[] = [
  'no-access',
  'extract-failed',
  'no-key',
  'rate-limited',
  'auth',
  'network',
  'bad-response',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isOutcome(value: unknown): value is RuleOutcome {
  const record = asRecord(value);
  if (!record) return false;
  if (record.rule !== 'marketing' && record.rule !== 'clickbait') return false;
  if (record.status === 'match' || record.status === 'no-match') {
    return typeof record.probability === 'number';
  }
  return (
    record.status === 'undetermined' &&
    (record.reason === 'truncated' || record.reason === 'paywall' || record.reason === 'no-answer') &&
    (record.probability === undefined || typeof record.probability === 'number')
  );
}

function isVerdict(value: unknown): value is ArticleVerdict {
  const record = asRecord(value);
  if (!record) return false;
  if (record.kind === 'not-article') {
    return (
      record.reason === 'blocked' ||
      record.reason === 'too-short' ||
      record.reason === 'root-page' ||
      record.reason === 'login-page' ||
      record.reason === 'model'
    );
  }
  return (
    record.kind === 'judged' &&
    typeof record.truncated === 'boolean' &&
    typeof record.paywall === 'boolean' &&
    Array.isArray(record.outcomes) &&
    record.outcomes.every(isOutcome) &&
    (record.top === null || (isOutcome(record.top) && record.top.status === 'match'))
  );
}

export function isJudgePageResult(value: unknown): value is JudgePageResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === false) {
    return (
      typeof record.detail === 'string' &&
      JUDGE_ERRORS.some((error) => error === record.error)
    );
  }
  const page = asRecord(record.page);
  return (
    record.ok === true &&
    page !== null &&
    typeof page.url === 'string' &&
    typeof page.title === 'string' &&
    typeof page.units === 'number' &&
    isVerdict(record.verdict) &&
    typeof record.tokens === 'number'
  );
}
