/**
 * One web page, as read for a single-article judgement.
 *
 * The values come out of an arbitrary page, so every field is untrusted text:
 * it is validated by shape and capped by length before it is used for anything.
 * Nothing here is stored. A page is read when the person asks for it, sent for
 * one judgement, and forgotten.
 */

/** Only this much of the body is judged. The number was tried in the offline
 * experiments (docs/article-rules.md 5.1); 2000 units covered 10 of 27 pages in
 * full, so a page over the cap is judged from its beginning. */
export const ARTICLE_TEXT_CAP_UNITS = 2000;

/** Below this many units a page is not judged as an article. An initial value
 * from 39 observed pages, not a calibrated one: a 16-unit login page and a
 * 122-unit archive page fall below it, a 298-unit open thread passes. */
export const ARTICLE_MIN_UNITS = 200;

const MAX_SHORT_FIELD = 500;
const MAX_URL = 2000;
const MAX_HEADINGS = 30;
const MAX_HEADING_LENGTH = 300;
/** A hard ceiling on what is accepted from the page at all. The extractor cuts
 * the text long before this; the limit only stops a hostile page from handing
 * an oversized string to the background. */
export const MAX_ARTICLE_TEXT_CHARS = 400_000;

export interface ExtractedArticle {
  /** Address of the page as the page reports it, without query or fragment. */
  url: string;
  title: string;
  author: string;
  site: string;
  published: string;
  description: string;
  language: string;
  headings: string[];
  /** Body text with the extractor's noise removed, at most the whole page. */
  text: string;
  /** Words plus CJK characters in `text`, whole page, not the cut. */
  units: number;
  /** A machine-readable "not free to read" signal, or a paywall element. */
  paywallDetected: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isShort(value: unknown, max: number = MAX_SHORT_FIELD): value is string {
  return typeof value === 'string' && value.length <= max;
}

export function isExtractedArticle(value: unknown): value is ExtractedArticle {
  const record = asRecord(value);
  if (!record) return false;
  return (
    isShort(record.url, MAX_URL) &&
    isShort(record.title) &&
    isShort(record.author) &&
    isShort(record.site) &&
    isShort(record.published) &&
    isShort(record.description, 2000) &&
    isShort(record.language, 40) &&
    Array.isArray(record.headings) &&
    record.headings.length <= MAX_HEADINGS &&
    record.headings.every((heading) => isShort(heading, MAX_HEADING_LENGTH)) &&
    typeof record.text === 'string' &&
    record.text.length <= MAX_ARTICLE_TEXT_CHARS &&
    typeof record.units === 'number' &&
    Number.isInteger(record.units) &&
    record.units >= 0 &&
    typeof record.paywallDetected === 'boolean'
  );
}

const UNIT = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\s\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;

/** Words for spaced scripts, one unit per CJK character. Comparable across
 * languages, which a raw character or word count is not. */
export function countUnits(text: string): number {
  let count = 0;
  for (const _unit of text.matchAll(UNIT)) count += 1;
  return count;
}

/** The first `limit` units of `text`, cut on a unit boundary. A text at or under
 * the limit is returned whole. */
export function headUnits(text: string, limit: number): string {
  if (limit <= 0) return '';
  let count = 0;
  for (const match of text.matchAll(UNIT)) {
    count += 1;
    if (count >= limit) {
      const end = (match.index ?? 0) + match[0].length;
      return end >= text.length ? text : text.slice(0, end);
    }
  }
  return text;
}

/** Drops a trailing site suffix such as ` - Example Blog` or ` | Site`. */
export function stripSiteSuffix(title: string): string {
  return title.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '');
}
