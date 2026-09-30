import type { Rule } from '../../domain/rule';
import { MAX_GROUP_NAME_LENGTH, MAX_GROUPS, groupNameKey, isDefaultGroupId, type RuleGroup } from '../../domain/rule-group';
import { UNCATEGORISED } from './rule-list-model';

/**
 * Edits to the category list while it is still a draft. Pure: the names shown
 * for default categories depend on the interface language, so callers pass
 * `labelOf` instead of this module knowing any language.
 */

export function groupsEqual(a: readonly RuleGroup[], b: readonly RuleGroup[]): boolean {
  return a.length === b.length && a.every((group, i) => group.id === b[i].id && group.name === b[i].name);
}

export function newGroupId(groups: readonly RuleGroup[]): string {
  const taken = new Set(groups.map((group) => group.id));
  let id = `group:${crypto.randomUUID()}`;
  while (taken.has(id)) id = `group:${crypto.randomUUID()}`;
  return id;
}

export type GroupNameProblem = 'empty' | 'too-long' | 'taken' | 'limit';

/** Why `name` cannot be used, or `null`. `ignoreId` is the category being
 * renamed, which may keep its own name. Names are compared as shown, so a custom
 * category cannot shadow a default one in the current language. */
export function checkGroupName(
  name: string,
  groups: readonly RuleGroup[],
  labelOf: (group: RuleGroup) => string,
  ignoreId?: string,
): GroupNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) return 'too-long';
  if (ignoreId === undefined && groups.length >= MAX_GROUPS) return 'limit';
  const key = groupNameKey(trimmed);
  if (groups.some((group) => group.id !== ignoreId && groupNameKey(labelOf(group)) === key)) return 'taken';
  return null;
}

export function addGroup(groups: readonly RuleGroup[], name: string): { groups: RuleGroup[]; id: string } {
  const id = newGroupId(groups);
  return { groups: [...groups, { id, name: name.trim() }], id };
}

export function renameGroup(groups: readonly RuleGroup[], id: string, name: string): RuleGroup[] {
  return groups.map((group) => (group.id === id ? { ...group, name: name.trim() } : group));
}

/** Drops a category; the rules that were in it become uncategorised. */
export function removeGroup(
  groups: readonly RuleGroup[],
  rules: readonly Rule[],
  id: string,
): { groups: RuleGroup[]; rules: Rule[] } {
  return {
    groups: groups.filter((group) => group.id !== id),
    rules: rules.map((rule) => {
      if (rule.group !== id) return rule;
      const { group: _dropped, ...rest } = rule;
      return rest;
    }),
  };
}

export function moveGroup(groups: readonly RuleGroup[], id: string, delta: -1 | 1): RuleGroup[] {
  const from = groups.findIndex((group) => group.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= groups.length) return [...groups];
  const next = [...groups];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Sets one category for every rule in `ids`; `null` means uncategorised. */
export function assignGroup(rules: readonly Rule[], ids: ReadonlySet<string>, group: string | null): Rule[] {
  return rules.map((rule) => {
    if (!ids.has(rule.id)) return rule;
    if (group === null || group === UNCATEGORISED) {
      const { group: _dropped, ...rest } = rule;
      return rest;
    }
    return { ...rule, group };
  });
}

/** The category whose shown name is `name`, ignoring case, if there is one. */
export function findGroupByLabel(
  groups: readonly RuleGroup[],
  name: string,
  labelOf: (group: RuleGroup) => string,
): RuleGroup | undefined {
  const key = groupNameKey(name);
  return groups.find((group) => groupNameKey(labelOf(group)) === key);
}

/** A default category renamed back to an empty name shows its built-in name again. */
export function canResetName(group: RuleGroup): boolean {
  return isDefaultGroupId(group.id) && group.name !== '';
}
