import type { Post } from './post';
import type { Rule } from './rule';
import type { Settings } from './settings';

/** Hacker News, the first site after X. See docs/hacker-news.md. */
export const HN_HOST = 'news.ycombinator.com';
export const HN_PATTERN = `https://${HN_HOST}/*`;

/**
 * The list pages. Only these are read. An item page (`/item`) is one the person
 * opened on purpose, so it is never hidden; comments, profiles and `jobs` are not
 * handled at all.
 */
const LISTING_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/news',
  '/newest',
  '/front',
  '/ask',
  '/show',
  '/shownew',
  '/best',
  '/active',
  '/classic',
  '/from',
  '/submitted',
  '/over',
]);

export function isHnListingPath(pathname: string): boolean {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return LISTING_PATHS.has(trimmed === '' ? '/' : trimmed);
}

/**
 * The built-in rules that mean something for a headline. The other built-ins are
 * about X replies and bots (`bait`, `hate`, `porn`, `spam`) or are a platform
 * marker (`ads`). `promo` is left out on purpose: in a 350-title trial everything
 * it caught was a Show HN or Launch HN, which is a section of the site, not spam
 * (docs/hacker-news.md section 2).
 */
export const HN_RULE_IDS: readonly string[] = ['politics', 'crypto', 'nsfw', 'platitude'];

/**
 * The person's rules that apply to a Hacker News title: the named built-ins, and
 * any custom rule whose scope is everything (a replies-only rule has no parent to
 * judge against here). On/off and thresholds stay exactly as they set them.
 */
export function hnRulesOf(rules: readonly Rule[]): Rule[] {
  return rules.filter((rule) => {
    if (rule.kind !== 'semantic') return false;
    if (rule.source === 'builtin') return HN_RULE_IDS.includes(rule.id);
    return rule.scope === 'all';
  });
}

/** The settings the Hacker News feed filters with: the same ones, narrowed rules. */
export function hnSettings(settings: Settings): Settings {
  return { ...settings, rules: hnRulesOf(settings.rules) };
}

/** What is read off one row of the list. */
export interface HnItem {
  /** Numeric item id, the `id` of the `tr.athing` row. */
  id: string;
  title: string;
  /** Host of the link, without `www.`. Empty for a post that only links to itself. */
  site: string;
  /** Who submitted it. Empty when the row has none (job posts). */
  user: string;
}

const HN_ID_PATTERN = /^\d{1,12}$/;
const HN_PREFIX = 'hn:';

export function isHnItemId(value: string): boolean {
  return HN_ID_PATTERN.test(value);
}

export function hnItemUrl(id: string): string {
  return `https://${HN_HOST}/item?id=${id}`;
}

export function hnPostId(id: string): string {
  return `${HN_PREFIX}${id}`;
}

export function isHnPostId(postId: string): boolean {
  return postId.startsWith(HN_PREFIX) && isHnItemId(postId.slice(HN_PREFIX.length));
}

export function hnItemIdOf(postId: string): string {
  return postId.slice(HN_PREFIX.length);
}

/**
 * The host shown next to the title, or empty when the link stays on the site
 * (Ask HN and text posts link to their own `item?id=` page).
 */
export function hnSiteOf(href: string): string {
  let url: URL;
  try {
    url = new URL(href, `https://${HN_HOST}/`);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.hostname === HN_HOST) return '';
  return url.hostname.replace(/^www\./, '');
}

/** The text sent to the model and shown in the panel: the title, then where it links. */
export function hnTextOf(item: HnItem): string {
  const title = item.title.replace(/\s+/g, ' ').trim();
  return item.site === '' ? title : `${title} (${item.site})`;
}

/** One list row as the `Post` the rest of the extension already understands. */
export function hnPost(item: HnItem): Post {
  const id = hnPostId(item.id);
  return {
    id,
    kind: 'post',
    parent: null,
    thread: id,
    own: false,
    name: item.user,
    handle: item.user,
    time: '',
    text: hnTextOf(item),
    promoted: false,
    avatarUrl: '',
    imageUrls: [],
    hasVideo: false,
    quotedName: '',
    quotedText: '',
    truncated: false,
    source: 'hn',
    url: hnItemUrl(item.id),
  };
}
