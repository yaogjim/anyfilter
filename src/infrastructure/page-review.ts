import { ARTICLE_RULES, thresholdOf, type ArticleVerdict } from '../domain/article-rules';
import { translate, type TranslationKey, type UiLocale } from '../ui/i18n';
import { loadSettings } from './settings-store';
import { loadUiLocale } from './ui-locale';

/** What the box on the page says: plain strings, so the page script needs no
 * translation catalogue and nothing but text crosses into the page. */
export interface PageReviewData {
  title: string;
  headline: string;
  /** `flagged` when a rule matched, `kept` when none did. */
  tone: 'flagged' | 'kept';
  lines: string[];
  close: string;
}

const RULE_LABEL: Record<string, TranslationKey> = {
  marketing: 'page.rule.marketing',
  clickbait: 'page.rule.clickbait',
};
const REASON: Record<string, TranslationKey> = {
  truncated: 'page.reason.truncated',
  paywall: 'page.reason.paywall',
  'no-answer': 'page.reason.noAnswer',
};

const percent = (value: number): number => Math.round(value * 100);

/** The box for one judged page, or null for a verdict that is not a judgement (a
 * page that is not an article has nothing to review). */
export function pageReviewData(locale: UiLocale, verdict: ArticleVerdict): PageReviewData | null {
  if (verdict.kind !== 'judged') return null;
  const t = (key: TranslationKey, params?: Record<string, string | number>): string => translate(locale, key, params);
  const thresholdFor = (id: string): number => {
    const rule = ARTICLE_RULES.find((candidate) => candidate.id === id);
    return rule === undefined ? 0.7 : thresholdOf(rule);
  };
  const labelOf = (id: string): string => t(RULE_LABEL[id] ?? 'page.rule.marketing');
  const lines = verdict.outcomes.map((outcome) => {
    if (outcome.status === 'undetermined') {
      return t('page.undetermined', { label: labelOf(outcome.rule), reason: t(REASON[outcome.reason] ?? 'page.reason.noAnswer') });
    }
    return t('page.detail.scored', {
      label: labelOf(outcome.rule),
      probability: percent(outcome.probability),
      threshold: percent(thresholdFor(outcome.rule)),
    });
  });
  const top = verdict.top;
  return {
    title: t('review.toolbar.title'),
    headline:
      top === null
        ? t('page.clean')
        : t('page.match', {
            label: labelOf(top.rule),
            probability: percent(top.probability),
            threshold: percent(thresholdFor(top.rule)),
          }),
    tone: top === null ? 'kept' : 'flagged',
    lines,
    close: t('review.toolbar.exit'),
  };
}

/**
 * Runs inside the page (it is passed to `executeScript` as a function, so it must
 * not use anything from this module). Draws one small box in a shadow root, or
 * replaces the one already there. It reads nothing from the page.
 */
export function drawPageReviewBox(data: PageReviewData): void {
  const HOST_ID = 'anyfilter-page-review';
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-anyfilter-host', 'page-review');
  const root = host.attachShadow({ mode: 'open' });
  const color = data.tone === 'flagged' ? '#b4472f' : '#1a7f45';
  const style = document.createElement('style');
  style.textContent = `
    .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; max-width: 340px;
      background: #fff; color: #0f1419; border: 2px solid ${color}; border-radius: 10px; padding: 10px 12px;
      font: 12px/1.5 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
    .head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .title { font-weight: 700; color: ${color}; }
    .headline { margin-top: 4px; font-weight: 600; }
    .line { margin-top: 2px; color: #444; }
    button { font: inherit; border: 0; background: transparent; cursor: pointer; color: #444; padding: 0 2px; }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'note');
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = data.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = data.close;
  close.setAttribute('aria-label', data.close);
  close.addEventListener('click', () => host.remove());
  head.append(title, close);
  const headline = document.createElement('div');
  headline.className = 'headline';
  headline.textContent = data.headline;
  box.append(head, headline);
  for (const text of data.lines) {
    const line = document.createElement('div');
    line.className = 'line';
    line.textContent = text;
    box.append(line);
  }
  root.append(style, box);
  document.documentElement.append(host);
}

/**
 * Review mode for a judged page: a box on the page saying what the rules found.
 * Shown only while the shared review switch is on. Display only: it reads nothing
 * from the page, stores nothing, and a failure to draw it (a tab that closed, a page
 * the browser will not let us touch) changes nothing else.
 */
export async function showPageReview(tabId: number, verdict: ArticleVerdict): Promise<void> {
  try {
    if (!(await loadSettings()).reviewMode) return;
    const data = pageReviewData(await loadUiLocale(), verdict);
    if (data === null) return;
    await chrome.scripting.executeScript({ target: { tabId }, func: drawPageReviewBox, args: [data] });
  } catch {
    // Nothing to do: the judgement itself already succeeded.
  }
}
