import { BUILT_IN_CATEGORIES } from './category';
import { isProviderId, type ProviderId } from './provider';
import {
  builtInRules,
  coerceRules,
  isBuiltInId,
  legacyCustomRule,
  refreshUneditedBuiltIns,
  type Rule,
} from './rule';

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
  revision: number;
  provider: ProviderId;
  keys: Record<ProviderId, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  filterOn: true,
  reviewMode: true,
  disabled: [],
  threshold: 0.7,
  custom: [],
  rules: builtInRules(),
  revision: 0,
  provider: 'vercel',
  keys: { vercel: '', typesafe: '' },
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

export function normalizeSettings(raw: unknown): Settings {
  const record = asRecord(raw);
  const keys = asRecord(record.keys);
  const rules = reconcileRules(record);
  return {
    filterOn: typeof record.filterOn === 'boolean' ? record.filterOn : DEFAULT_SETTINGS.filterOn,
    reviewMode:
      typeof record.reviewMode === 'boolean' ? record.reviewMode : DEFAULT_SETTINGS.reviewMode,
    disabled: rules.filter((rule) => rule.source === 'builtin' && !rule.enabled).map((rule) => rule.id),
    threshold: normalizedThreshold(record.threshold),
    custom: rules.filter((rule) => rule.source === 'custom').map((rule) => rule.label),
    rules,
    revision: normalizedRevision(record.revision),
    provider: isProviderId(record.provider) ? record.provider : DEFAULT_SETTINGS.provider,
    keys: {
      vercel: typeof keys.vercel === 'string' ? keys.vercel : '',
      typesafe: typeof keys.typesafe === 'string' ? keys.typesafe : '',
    },
  };
}

/** Builds the settings to persist for a rule edit: rules are authoritative and
 * the legacy mirrors plus revision follow. */
export function withRules(base: Settings, rules: Rule[], revision: number): Settings {
  return {
    ...base,
    rules,
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