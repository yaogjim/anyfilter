import { BUILT_IN_CATEGORIES } from './category';
import { isMachineLabellerId, type MachineLabellerId } from './machine-label';
import { isProviderId, type ProviderId } from './provider';
import {
  builtInRules,
  coerceRules,
  isBuiltInId,
  legacyCustomRule,
  refreshUneditedBuiltIns,
  type Rule,
} from './rule';
import { BUILT_IN_GROUP, coerceGroups, defaultGroups, groupIdSet, type RuleGroup } from './rule-group';

export interface Settings {
  filterOn: boolean;
  /** In-timeline review mode, for every X page: posts stay visible and carry the
   * judgement instead of being hidden. One stored switch, not per-page memory. */
  reviewMode: boolean;
  /** Legacy mirror of enabled built-in rules. Always derived from `rules`. */
  disabled: string[];
  threshold: number;
  /** Legacy mirror of custom rule labels. Always derived from `rules`. */
  custom: string[];
  rules: Rule[];
  /** The categories rules are listed under, in display order. Saved together
   * with `rules` so a rule never points at a category that was not stored. */
  ruleGroups: RuleGroup[];
  revision: number;
  provider: ProviderId;
  keys: Record<ProviderId, string>;
  /** Which OpenAI/DeepSeek connection drafts rules from a description. Not a
   * secret: the key itself lives in the evaluation key record, never here. */
  assistant: MachineLabellerId;
}

export const DEFAULT_SETTINGS: Settings = {
  filterOn: true,
  reviewMode: true,
  disabled: [],
  threshold: 0.7,
  custom: [],
  rules: builtInRules(),
  ruleGroups: defaultGroups(),
  revision: 0,
  provider: 'vercel',
  keys: { vercel: '', typesafe: '' },
  assistant: 'openai',
};

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizedThreshold(value: unknown): number {
  return typeof value === 'number' && value > 0 && value <= 1 ? value : DEFAULT_SETTINGS.threshold;
}

function normalizedRevision(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Keeps every built-in rule present while preserving stored edits by id. An
 * un-edited built-in still on the previous defaults is refreshed to the current
 * defaults; edited and disabled rules are left exactly as stored. */
function withBuiltIns(stored: readonly Rule[]): Rule[] {
  const refreshed = refreshUneditedBuiltIns(stored);
  const byId = new Map(refreshed.map((rule) => [rule.id, rule]));
  const builtins = builtInRules().map((builtin) => byId.get(builtin.id) ?? builtin);
  const custom = refreshed.filter((rule) => rule.source === 'custom' && !isBuiltInId(rule.id));
  return [...builtins, ...custom];
}

/** One-time migration of legacy `disabled`/`enabled` flags into built-in rules. */
function builtInsFromLegacy(record: Record<string, unknown>): Rule[] {
  const disabled = new Set(stringArray(record.disabled) ?? []);
  const legacyEnabled = stringArray(record.enabled);
  return builtInRules().map((rule) => ({
    ...rule,
    enabled: legacyEnabled ? legacyEnabled.includes(rule.id) : !disabled.has(rule.id),
  }));
}

/** The legacy `disabled` array stays authoritative so the existing settings UI
 * keeps working until it moves to `saveRules`. */
function applyLegacyDisabled(rules: Rule[], record: Record<string, unknown>): Rule[] {
  const disabled = stringArray(record.disabled);
  if (!disabled) return rules;
  const set = new Set(disabled);
  return rules.map((rule) => (rule.source === 'builtin' ? { ...rule, enabled: !set.has(rule.id) } : rule));
}

/** The legacy `custom` label list stays authoritative, reusing stored custom
 * rules by label so edits and ids survive a round trip. */
function applyLegacyCustom(rules: Rule[], record: Record<string, unknown>): Rule[] {
  const labels = stringArray(record.custom);
  if (!labels) return rules;
  const existing = rules.filter((rule) => rule.source === 'custom');
  const custom: Rule[] = [];
  for (const label of labels) {
    const reuse = existing.find((rule) => rule.label === label) ?? custom.find((rule) => rule.label === label);
    custom.push(reuse ?? legacyCustomRule(label, [...existing, ...custom]));
  }
  return rules.filter((rule) => rule.source !== 'custom').concat(custom);
}

function reconcileRules(record: Record<string, unknown>): Rule[] {
  const stored = coerceRules(record.rules);
  const base = stored ? withBuiltIns(stored) : builtInsFromLegacy(record);
  return applyLegacyCustom(applyLegacyDisabled(base, record), record);
}

/** Gives each built-in rule that has no category its default one. Only done for
 * a record from before categories existed: once categories are stored, a rule
 * without one is uncategorised because the person put it there. */
function withDefaultGroups(rules: Rule[]): Rule[] {
  return rules.map((rule) => {
    const group = BUILT_IN_GROUP[rule.id];
    return rule.source === 'builtin' && rule.group === undefined && group !== undefined
      ? { ...rule, group }
      : rule;
  });
}

/** A rule pointing at a category that is not stored falls back to uncategorised. */
function withKnownGroups(rules: Rule[], groups: readonly RuleGroup[]): Rule[] {
  const known = groupIdSet(groups);
  return rules.map((rule) => {
    if (rule.group === undefined || known.has(rule.group)) return rule;
    const { group: _dropped, ...rest } = rule;
    return rest;
  });
}

export function normalizeSettings(raw: unknown): Settings {
  const record = asRecord(raw);
  const keys = asRecord(record.keys);
  const storedGroups = coerceGroups(record.ruleGroups);
  const ruleGroups = storedGroups ?? defaultGroups();
  const reconciled = reconcileRules(record);
  const rules = withKnownGroups(storedGroups === null ? withDefaultGroups(reconciled) : reconciled, ruleGroups);
  return {
    filterOn: typeof record.filterOn === 'boolean' ? record.filterOn : DEFAULT_SETTINGS.filterOn,
    reviewMode:
      typeof record.reviewMode === 'boolean' ? record.reviewMode : DEFAULT_SETTINGS.reviewMode,
    disabled: rules.filter((rule) => rule.source === 'builtin' && !rule.enabled).map((rule) => rule.id),
    threshold: normalizedThreshold(record.threshold),
    custom: rules.filter((rule) => rule.source === 'custom').map((rule) => rule.label),
    rules,
    ruleGroups,
    revision: normalizedRevision(record.revision),
    provider: isProviderId(record.provider) ? record.provider : DEFAULT_SETTINGS.provider,
    keys: {
      vercel: typeof keys.vercel === 'string' ? keys.vercel : '',
      typesafe: typeof keys.typesafe === 'string' ? keys.typesafe : '',
    },
    assistant: isMachineLabellerId(record.assistant) ? record.assistant : DEFAULT_SETTINGS.assistant,
  };
}

/** Builds the settings to persist for a rule edit: rules are authoritative and
 * the legacy mirrors plus revision follow. */
export function withRules(
  base: Settings,
  rules: Rule[],
  revision: number,
  ruleGroups: RuleGroup[] = base.ruleGroups,
): Settings {
  return {
    ...base,
    rules,
    ruleGroups,
    disabled: rules.filter((rule) => rule.source === 'builtin' && !rule.enabled).map((rule) => rule.id),
    custom: rules.filter((rule) => rule.source === 'custom').map((rule) => rule.label),
    revision,
  };
}

export function enabledCategories(settings: Settings): ReadonlySet<string> {
  const builtins = settings.rules.filter((rule) => rule.source === 'builtin');
  if (builtins.length > 0) {
    return new Set(builtins.filter((rule) => rule.enabled).map((rule) => rule.id));
  }
  const disabled = new Set(settings.disabled);
  return new Set(
    BUILT_IN_CATEGORIES.map((category) => category.id).filter((id) => !disabled.has(id)),
  );
}

export function activeKey(settings: Settings): string {
  return settings.keys[settings.provider].trim();
}