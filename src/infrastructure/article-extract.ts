import Defuddle from 'defuddle';
import {
  ARTICLE_TEXT_CAP_UNITS,
  countUnits,
  headUnits,
  type ExtractedArticle,
} from '../domain/article';

/**
 * Reads the current page into an {@link ExtractedArticle}. Runs inside the page,
 * only when the person clicks "judge this page" on a tab they opened the panel
 * on. It reads; it does not change the page, store anything, or call out.
 */
export type ExtractResult = { ok: true; article: ExtractedArticle } | { ok: false; error: string };

function withoutQuery(address: string): string {
  try {
    const parsed = new URL(address);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return address;
  }
}

/** Flattens a schema.org value, which may be an object, an array or a `@graph`. */
function flatten(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return Array.isArray(record['@graph']) ? flatten(record['@graph']) : [record];
}

function declaresPaywall(schema: unknown): boolean {
  return flatten(schema).some((item) => {
    const free = item.isAccessibleForFree;
    return free === false || free === 'false' || free === 'False';
  });
}

/** Block-level tags end a line, so paragraphs and list items do not run together. */
function htmlToText(html: string): { text: string; headings: string[] } {
  const spaced = html
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|ul|ol|table)>/gi, '</$1>\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const parsed = new DOMParser().parseFromString(spaced, 'text/html');
  const text = (parsed.body.textContent ?? '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  const headings = [...parsed.querySelectorAll('h1,h2,h3,h4')]
    .map((heading) => (heading.textContent ?? '').trim())
    .filter((heading) => heading !== '')
    .map((heading) => heading.slice(0, 300))
    .slice(0, 30);
  return { text, headings };
}

const short = (value: string | undefined, max: number): string => (value ?? '').slice(0, max);

export function extractArticle(doc: Document, pageUrl: string): ExtractResult {
  try {
    // `useAsync: false` keeps the extractor from fetching third-party APIs for a
    // page whose own HTML holds no content: the page is read where it is, nothing
    // is requested on its behalf.
    const parsed = new Defuddle(doc, { url: pageUrl, useAsync: false }).parse();
    const { text, headings } = htmlToText(String(parsed.content ?? ''));
    const paywallElement = doc.querySelector('[class*="paywall" i],[id*="paywall" i]') !== null;
    return {
      ok: true,
      article: {
        url: short(withoutQuery(pageUrl), 2000),
        title: short(parsed.title, 500),
        author: short(parsed.author, 500),
        site: short(parsed.site, 500),
        published: short(parsed.published, 500),
        description: short(parsed.description, 2000),
        language: short(parsed.language || doc.documentElement.lang, 40),
        headings,
        // Only the part that is judged leaves the page. `units` still counts all.
        text: headUnits(text, ARTICLE_TEXT_CAP_UNITS),
        units: countUnits(text),
        paywallDetected: declaresPaywall(parsed.schemaOrgData) || paywallElement,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'extract failed' };
  }
}
