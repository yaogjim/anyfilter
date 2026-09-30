import { hasUnsafeChars, isSafeId } from './safe-text';

/**
 * A rule category, shown in the interface as "分类" / "category". The code calls
 * it a group so it is never confused with `category.ts`, where "category" means
 * a built-in rule itself.
 *
 * A category only organises the rule list. It is never part of a compiled
 * question or its fingerprint, so moving a rule between categories can never
 * change a score or invalidate a cached one.
 */
export interface RuleGroup {
  id: string;
  /** The display name. Empty only for a default category that still carries its
   * built-in name, which the interface shows in its own language by id. */
  name: string;
}

export const MAX_GROUPS = 20;
export const MAX_GROUP_NAME_LENGTH = 40;

export const DEFAULT_GROUP_IDS = ['marketing', 'engagement', 'harmful', 'politics'] as const;

/** Which default category each built-in rule starts in. */
export const BUILT_IN_GROUP: Readonly<Record<string, string>> = {
  ads: 'marketing',
  promo: 'marketing',
  crypto: 'marketing',
  bait: 'engagement',
  platitude: 'engagement',
  spam: 'engagement',
  hate: 'harmful',
  nsfw: 'harmful',
  porn: 'harmful',
  politics: 'politics',
};

export function defaultGroups(): RuleGroup[] {
  return DEFAULT_GROUP_IDS.map((id) => ({ id, name: '' }));
}

export function isDefaultGroupId(id: string): boolean {
  return (DEFAULT_GROUP_IDS as readonly string[]).includes(id);
}

/** A category id has the same shape as a rule id. */
export function isGroupId(value: unknown): value is string {
  return isSafeId(value);
}

export function groupIdSet(groups: readonly RuleGroup[]): Set<string> {
  return new Set(groups.map((group) => group.id));
}

/** Names compare without regard to case or surrounding space. */
export function groupNameKey(name: string): string {
  return name.trim().toLowerCase();
}

type ParsedGroup = { ok: true; group: RuleGroup } | { ok: false; detail: string };

function parseGroup(value: unknown): ParsedGroup {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, detail: 'each category must be an object' };
  }
  const record = value as Record<string, unknown>;
  if (!isGroupId(record.id)) {
    return { ok: false, detail: `category id ${JSON.stringify(record.id)} is not a safe identifier` };
  }
  const id = record.id;
  if (typeof record.name !== 'string') return { ok: false, detail: `category ${id} needs a name` };
  const name = record.name.trim();
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    return { ok: false, detail: `category name must be at most ${MAX_GROUP_NAME_LENGTH} characters` };
  }
  if (hasUnsafeChars(name)) {
    return { ok: false, detail: `category ${id} name must not contain control characters` };
  }
  if (name === '' && !isDefaultGroupId(id)) {
    return { ok: false, detail: `category ${id} needs a name` };
  }
  return { ok: true, group: { id, name } };
}

export type GroupsValidation = { ok: true; groups: RuleGroup[] } | { ok: false; detail: string };

/** Strict check for a save: too many, a duplicate id, a duplicate name (ignoring
 * case) or an unusable name rejects the whole list. */
export function validateGroups(value: unknown): GroupsValidation {
  if (!Array.isArray(value)) return { ok: false, detail: 'categories must be an array' };
  if (value.length > MAX_GROUPS) return { ok: false, detail: `at most ${MAX_GROUPS} categories are allowed` };
  const groups: RuleGroup[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    const parsed = parseGroup(item);
    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    const { group } = parsed;
    if (ids.has(group.id)) return { ok: false, detail: `duplicate category id: ${group.id}` };
    ids.add(group.id);
    if (group.name !== '') {
      const key = groupNameKey(group.name);
      if (names.has(key)) return { ok: false, detail: `duplicate category name: ${group.name}` };
      names.add(key);
    }
    groups.push(group);
  }
  return { ok: true, groups };
}

export function isRuleGroups(value: unknown): value is RuleGroup[] {
  return validateGroups(value).ok;
}

/** Lenient read of stored categories: unusable entries are dropped, never the
 * whole list. `null` means nothing was stored (not an array), which is how a
 * settings record from before categories existed is recognised. */
export function coerceGroups(value: unknown): RuleGroup[] | null {
  if (!Array.isArray(value)) return null;
  const groups: RuleGroup[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    if (groups.length >= MAX_GROUPS) break;
    const parsed = parseGroup(item);
    if (!parsed.ok || ids.has(parsed.group.id)) continue;
    const key = groupNameKey(parsed.group.name);
    if (parsed.group.name !== '' && names.has(key)) continue;
    ids.add(parsed.group.id);
    if (parsed.group.name !== '') names.add(key);
    groups.push(parsed.group);
  }
  return groups;
}
