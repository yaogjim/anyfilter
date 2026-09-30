import type { HiddenEntry, ReasonEntry, ReasonGroup } from '../../domain/panel-state';
import type { Rule } from '../../domain/rule';
import type { RuleGroup } from '../../domain/rule-group';
import type { Reason } from '../../domain/verdict';

/** How the hidden list is grouped: by the rule that hid a post, or by that rule's
 * category. The category only organises the display; it never changes a score. */
export type GroupBy = 'rule' | 'category';

export interface CategoryOfReason {
  /** Empty for a rule that has no category. */
  id: string;
  label: string;
  /** Position in the person's category list; uncategorised sorts last. */
  rank: number;
}

export type CategoryResolver = (reason: Reason) => CategoryOfReason;

/** Maps a reason to its rule's category. The rule is found by id first (a reason
 * carries the rule id), then by label for a rule that was renamed or removed after
 * the post was hidden. A rule that is gone, or has no category, is uncategorised. */
export function makeCategoryResolver(
  rules: readonly Rule[],
  groups: readonly RuleGroup[],
  names: { groupLabel: (group: RuleGroup) => string; uncategorised: string },
): CategoryResolver {
  return (reason) => {
    const rule = rules.find((r) => r.id === reason.categoryId) ?? rules.find((r) => r.label === reason.label);
    const index = groups.findIndex((group) => group.id === rule?.group);
    if (index === -1) return { id: '', label: names.uncategorised, rank: groups.length };
    return { id: groups[index].id, label: names.groupLabel(groups[index]), rank: index };
  };
}

/** Groups hidden posts by category. A post that matched several rules of one
 * category is listed once there, under its most probable reason, so the group's
 * count is the number of posts and not the number of matches. A post that matched
 * rules in two categories appears under each, as it does under each rule. */
export function groupByCategory(entries: readonly HiddenEntry[], resolve: CategoryResolver): ReasonGroup[] {
  const groups = new Map<string, { rank: number; group: ReasonGroup; byPost: Map<string, ReasonEntry> }>();
  for (const entry of entries) {
    for (const reason of entry.reasons) {
      const category = resolve(reason);
      let bucket = groups.get(category.id);
      if (bucket === undefined) {
        bucket = { rank: category.rank, group: { label: category.label, entries: [] }, byPost: new Map() };
        groups.set(category.id, bucket);
      }
      const known = bucket.byPost.get(entry.post.id);
      if (known === undefined) {
        const item: ReasonEntry = { entry, reason };
        bucket.byPost.set(entry.post.id, item);
        bucket.group.entries.push(item);
      } else if (reason.probability > known.reason.probability) {
        // Replace in place so the order of the list does not jump.
        known.reason = reason;
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank).map((bucket) => bucket.group);
}
