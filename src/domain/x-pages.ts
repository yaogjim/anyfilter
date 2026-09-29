/**
 * Which X pages the feed filter and review mode work on.
 *
 * Every page listed here renders posts with the same `article` cells as the
 * home timeline, so the reader, the hider and the review decorations need no
 * per-page code. Only the gate differs, and it lives here so it can be tested
 * without a DOM.
 *
 * This is deliberately wider than the verification-sample capture in
 * `capture.ts` (`xPageOf`): filtering and review read what is already on screen
 * and keep nothing, while capture stores post text. Capture keeps its own,
 * narrower list, so browsing a profile or a list never adds samples.
 */

export type XFeedPage = 'home' | 'search' | 'status' | 'profile' | 'list';

const HOME_PATH = /^\/home\/?$/;
const SEARCH_PATH = /^\/search\/?$/;
const STATUS_PATH = /^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:\/|$)/;
const LIST_PATH = /^\/i\/lists\/\d+\/?$/;
const PROFILE_PATH = /^\/([A-Za-z0-9_]{1,15})\/?$/;

/** Top-level routes that look like a handle but are not a profile. */
const RESERVED_ROOTS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'ads',
  'bookmarks',
  'business',
  'communities',
  'compose',
  'download',
  'explore',
  'grok',
  'hashtag',
  'help',
  'home',
  'i',
  'intent',
  'jobs',
  'lists',
  'login',
  'logout',
  'messages',
  'notifications',
  'oauth',
  'premium',
  'privacy',
  'search',
  'settings',
  'share',
  'signup',
  'tos',
  'verified',
]);

/**
 * Classifies a `location.pathname`. A profile is only the Posts tab
 * (`/handle`); Replies, Media, Likes and the follower lists are not filtered,
 * because their cells either carry no parent context or are not posts.
 */
export function xFeedPageOf(pathname: string): XFeedPage | null {
  if (HOME_PATH.test(pathname)) return 'home';
  if (SEARCH_PATH.test(pathname)) return 'search';
  if (STATUS_PATH.test(pathname)) return 'status';
  if (LIST_PATH.test(pathname)) return 'list';
  const handle = pathname.match(PROFILE_PATH)?.[1];
  if (handle !== undefined && !RESERVED_ROOTS.has(handle.toLowerCase())) return 'profile';
  return null;
}

export function isFilteredPage(pathname: string): boolean {
  return xFeedPageOf(pathname) !== null;
}
