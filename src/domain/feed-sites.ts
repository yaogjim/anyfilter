import { HN_PATTERN } from './hn';

/**
 * A site, other than X, whose list pages the extension filters. Each one is off
 * until the person turns it on in the panel: turning it on asks the browser for the
 * site (an optional host permission) and only then is its script registered. X is
 * not here; it is in the manifest.
 */
export interface FeedSite {
  id: 'hn';
  /** A proper name, shown as it is in every language. */
  name: string;
  /** The match pattern the browser is asked for. */
  pattern: string;
  /** The built script, relative to the extension root. */
  file: string;
  /** Id of the registered content script. */
  scriptId: string;
}

export const FEED_SITES: readonly FeedSite[] = [
  {
    id: 'hn',
    name: 'Hacker News',
    pattern: HN_PATTERN,
    file: 'hn-feed.js',
    scriptId: 'anyfilter-feed-hn',
  },
];

export function feedSiteOfPattern(pattern: string): FeedSite | undefined {
  return FEED_SITES.find((site) => site.pattern === pattern);
}
