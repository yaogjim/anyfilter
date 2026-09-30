import { ARTICLE_MIN_UNITS, type ExtractedArticle } from './article';

/**
 * The entry gate: is this page something a rule may be asked about at all.
 *
 * It is code, not a model question, on purpose. In the offline trials the models
 * kept scoring pages that were not articles (a sign-in page, a list page, a bot
 * wall) and a model has no "insufficient" answer of its own to fall back on
 * (docs/article-rules.md 2.2). The hard rules run first and are final; the model
 * question "is this readable as one article" only runs after them.
 */
export type GateReason = 'blocked' | 'too-short' | 'root-page' | 'login-page' | 'x-page';

export type GateResult = { ok: true } | { ok: false; reason: GateReason };

/** Titles that bot walls and error pages serve. Seen in the trials: "Just a
 * moment..." and "Attention Required!" (Cloudflare), "Access Denied". */
const BLOCK_TITLES: readonly RegExp[] = [
  /^just a moment/i,
  /^attention required/i,
  /^access denied/i,
  /^403 forbidden/i,
  /^404\b.*not found/i,
  /^page not found/i,
  /^checking your browser/i,
  /^verify(ing)? you are (a )?human/i,
  /^are you a robot/i,
  /^robot check/i,
];

/** Only the last path segment counts: `/account/login` is a sign-in page, while
 * `/docs/auth/oauth` is documentation about signing in. */
const LOGIN_SEGMENT = /^(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register)$/i;

/** X is read by the feed filter, post by post. Its pages are never one article,
 * and reading one would send a whole timeline of other people's posts. */
function isXPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname.split('/').filter((segment) => segment !== '');
  } catch {
    return null;
  }
}

export function checkArticleGate(article: ExtractedArticle): GateResult {
  const title = article.title.trim();
  if (isXPage(article.url)) return { ok: false, reason: 'x-page' };
  if (BLOCK_TITLES.some((pattern) => pattern.test(title))) return { ok: false, reason: 'blocked' };
  const segments = pathSegments(article.url);
  // An address that cannot be read is not something to judge as an article.
  if (segments === null) return { ok: false, reason: 'root-page' };
  if (segments.length === 0) return { ok: false, reason: 'root-page' };
  if (LOGIN_SEGMENT.test(segments[segments.length - 1] ?? '')) {
    return { ok: false, reason: 'login-page' };
  }
  if (article.units < ARTICLE_MIN_UNITS) return { ok: false, reason: 'too-short' };
  return { ok: true };
}
