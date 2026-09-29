import type { ReviewSnapshot } from './review';
import type { ReviewRecord } from './review-record';

/**
 * What the review toolbar shows and hides. It only decides which decorated posts
 * stay on screen. It never changes what the feed judged, asks the provider for
 * anything, or touches a setting: the values live in page memory.
 */
export type ReviewScope = 'all' | 'flagged' | 'kept' | 'undecided' | 'valuable' | 'labeled';

export interface ReviewViewFilter {
  scope: ReviewScope;
  /** Narrow to posts that carry a score (or, for a local rule, a hit) for this rule. */
  ruleId: string | null;
  /** "Score at least": 0..1. Only applies together with a scored rule. */
  minScore: number;
}

export const DEFAULT_VIEW_FILTER: ReviewViewFilter = { scope: 'all', ruleId: null, minScore: 0 };

export const REVIEW_SCOPES: readonly ReviewScope[] = [
  'all',
  'flagged',
  'kept',
  'undecided',
  'valuable',
  'labeled',
];

export interface ReviewViewItem {
  snapshot: ReviewSnapshot;
  record?: ReviewRecord | undefined;
}

export function isDefaultFilter(filter: ReviewViewFilter): boolean {
  return filter.scope === 'all' && filter.ruleId === null && filter.minScore === 0;
}

/** True when the score slider can do anything for `ruleId`: only a rule that a
 * model answers has scores. A local rule (the promoted marker) has none. */
export function sliderApplies(items: readonly ReviewViewItem[], ruleId: string | null): boolean {
  if (ruleId === null) return false;
  return items.some((item) => item.snapshot.rules.some((rule) => rule.ruleId === ruleId && !rule.local));
}

/** Whether one decorated post stays on screen under `filter`. */
export function matchesFilter(item: ReviewViewItem, filter: ReviewViewFilter): boolean {
  const { snapshot, record } = item;
  switch (filter.scope) {
    case 'all':
      break;
    case 'flagged':
    case 'kept':
    case 'undecided':
      if (snapshot.state !== filter.scope) return false;
      break;
    case 'valuable':
      if (record?.valuable !== true) return false;
      break;
    case 'labeled':
      if (!record || record.overall === null) return false;
      break;
  }
  if (filter.ruleId === null) return true;
  const rule = snapshot.rules.find((candidate) => candidate.ruleId === filter.ruleId);
  if (!rule) return false;
  // A local rule has no score: it passes when it fired, and the slider never
  // applies to it. A scored rule passes when its score reaches the slider.
  if (rule.local) return rule.hit;
  return rule.score !== null && rule.score >= filter.minScore;
}

export interface ReviewViewSummary {
  /** Decorated posts currently loaded on the page. */
  loaded: number;
  /** Loaded posts the filter is keeping off screen. */
  filteredOut: number;
  /** Loaded posts that carry a verdict label. The page replaces this with the
   * stored total, so it does not fall when labelled posts scroll out of the page. */
  labeled: number;
}

export function summarizeView(
  items: readonly ReviewViewItem[],
  filter: ReviewViewFilter,
): ReviewViewSummary {
  let filteredOut = 0;
  let labeled = 0;
  for (const item of items) {
    if (!matchesFilter(item, filter)) filteredOut += 1;
    if (item.record && item.record.overall !== null) labeled += 1;
  }
  return { loaded: items.length, filteredOut, labeled };
}

/** The distinct rules present on the loaded posts, in first-seen order. */
export function rulesOf(
  items: readonly ReviewViewItem[],
): Array<{ ruleId: string; label: string; local: boolean }> {
  const seen = new Map<string, { ruleId: string; label: string; local: boolean }>();
  for (const item of items) {
    for (const rule of item.snapshot.rules) {
      if (!seen.has(rule.ruleId)) seen.set(rule.ruleId, { ruleId: rule.ruleId, label: rule.label, local: rule.local });
    }
  }
  return [...seen.values()];
}
