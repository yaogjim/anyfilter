import type { Rule } from '../../domain/rule';
import type { RuleGroup } from '../../domain/rule-group';

/**
 * What the rule list shows for a search, a source filter, a category filter and
 * a sort. Pure, so the ordering and the counts can be tested without a browser.
 */

export type SourceFilter = 'all' | 'builtin' | 'custom';
export type SortMode = 'group' | 'name' | 'enabled';

/** The section key (and category filter value) for rules with no category. */
export const UNCATEGORISED = '';
/** The category filter value that lets every category through. */
export const ANY_GROUP = '*';

export interface ListQuery {
  search: string;
  source: SourceFilter;
  /** {@link ANY_GROUP}, {@link UNCATEGORISED} or a category id. */
  group: string;
  sort: SortMode;
}

export const DEFAULT_QUERY: ListQuery = { search: '', source: 'all', group: ANY_GROUP, sort: 'group' };

export interface RuleSection {
  /** A category id, {@link UNCATEGORISED}, or `null` for the single flat list. */
  key: string | null;
  group: RuleGroup | null;
  /** The rules that pass the current filters, in display order. */
  rules: Rule[];
  /** Enabled and total over every rule in the category, filters aside. */
  enabled: number;
  total: number;
}

export interface RuleList {
  mode: 'grouped' | 'flat';
  sections: RuleSection[];
}

/** The section a rule is listed under: its category, or none when it has no
 * category or names one that no longer exists. */
export function sectionKeyOf(rule: Rule, groupIds: ReadonlySet<string>): string {
  return rule.group !== undefined && groupIds.has(rule.group) ? rule.group : UNCATEGORISED;
}

function matches(rule: Rule, query: ListQuery, groupIds: ReadonlySet<string>): boolean {
  if (query.source !== 'all' && rule.source !== query.source) return false;
  if (query.group !== ANY_GROUP && sectionKeyOf(rule, groupIds) !== query.group) return false;
  const needle = query.search.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return `${rule.label} ${rule.include} ${rule.exclude}`.toLocaleLowerCase().includes(needle);
}

function byName(a: Rule, b: Rule): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

function isFiltering(query: ListQuery): boolean {
  return query.search.trim() !== '' || query.source !== 'all' || query.group !== ANY_GROUP;
}

export function buildRuleList(
  rules: readonly Rule[],
  groups: readonly RuleGroup[],
  query: ListQuery,
): RuleList {
  const groupIds = new Set(groups.map((group) => group.id));
  const shown = rules.filter((rule) => matches(rule, query, groupIds));

  if (query.sort !== 'group') {
    const sorted = [...shown].sort((a, b) =>
      query.sort === 'enabled' && a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : byName(a, b),
    );
    return {
      mode: 'flat',
      sections: [
        {
          key: null,
          group: null,
          rules: sorted,
          enabled: rules.filter((rule) => rule.enabled).length,
          total: rules.length,
        },
      ],
    };
  }

  const sections: RuleSection[] = [];
  const keys: Array<{ key: string; group: RuleGroup | null }> = [
    ...groups.map((group) => ({ key: group.id, group })),
    { key: UNCATEGORISED, group: null },
  ];
  for (const { key, group } of keys) {
    const members = rules.filter((rule) => sectionKeyOf(rule, groupIds) === key);
    const visible = shown.filter((rule) => sectionKeyOf(rule, groupIds) === key);
    // An empty category stays listed while nothing is filtered, so it can be
    // seen and filled; a filter hides every section it leaves empty.
    if (visible.length === 0 && (isFiltering(query) || (group === null && members.length === 0))) continue;
    sections.push({
      key,
      group,
      rules: visible,
      enabled: members.filter((rule) => rule.enabled).length,
      total: members.length,
    });
  }
  return { mode: 'grouped', sections };
}

/** Every rule the list currently shows, in the order shown. */
export function visibleRuleIds(list: RuleList): string[] {
  return list.sections.flatMap((section) => section.rules.map((rule) => rule.id));
}
