import { isMachineLabellerId } from '../domain/machine-label';
import { isProviderId } from '../domain/provider';
import { groupIdSet, validateGroups, type RuleGroup } from '../domain/rule-group';
import { validateRules, type Rule, type SaveRulesResult } from '../domain/rule';
import { normalizeSettings, withRules, type Settings } from '../domain/settings';

const SETTINGS_KEY = 'anyfilter.settings';

/** Every write to the settings record goes through this one queue, so a panel
 * field save can never interleave with the read-modify-write of a rule save. */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task);
  writeChain = next.catch(() => undefined);
  return next;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

function normalizedThreshold(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 && value <= 1 ? value : fallback;
}

function normalizedRevision(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizedKeys(value: unknown, fallback: Settings['keys']): Settings['keys'] {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    vercel: typeof record.vercel === 'string' ? record.vercel : fallback.vercel,
    typesafe: typeof record.typesafe === 'string' ? record.typesafe : fallback.typesafe,
  };
}

/**
 * Panel-owned fields only. Rules are deliberately not read from here: they change
 * through {@link saveRules}, so a stale panel snapshot cannot overwrite a newer
 * rule set. The revision never moves backwards, so a snapshot taken before a
 * rule save cannot invalidate that save's compare-and-set.
 */
export function saveSettings(settings: Settings): Promise<void> {
  return enqueue(async () => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const current = normalizeSettings(stored[SETTINGS_KEY]);
    const next: Settings = {
      ...current,
      filterOn: typeof settings.filterOn === 'boolean' ? settings.filterOn : current.filterOn,
      reviewMode:
        typeof settings.reviewMode === 'boolean' ? settings.reviewMode : current.reviewMode,
      threshold: normalizedThreshold(settings.threshold, current.threshold),
      provider: isProviderId(settings.provider) ? settings.provider : current.provider,
      keys: normalizedKeys(settings.keys, current.keys),
      assistant: isMachineLabellerId(settings.assistant) ? settings.assistant : current.assistant,
      revision: Math.max(current.revision, normalizedRevision(settings.revision, current.revision)),
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  });
}

/** Turns review mode on or off for every X page. Touches only that field, so the
 * review toolbar can call it from a page without carrying a copy of the keys. */
export function saveReviewMode(on: boolean): Promise<void> {
  return enqueue(async () => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const current = normalizeSettings(stored[SETTINGS_KEY]);
    if (current.reviewMode === on) return;
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, reviewMode: on } });
  });
}

/** Serialized compare-and-set for rule edits. Validates first, then only writes
 * when the caller edited the revision that is still current, so two panels never
 * silently overwrite each other. Rules and categories are one write: a new rule
 * may point at a category created in the same draft, and a deleted category
 * never outlives the rules that used it. `groups` left out keeps the stored
 * categories. */
export function saveRules(
  rules: Rule[],
  expectedRevision: number,
  groups?: RuleGroup[],
): Promise<SaveRulesResult> {
  return enqueue(async (): Promise<SaveRulesResult> => {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return { ok: false, error: 'invalid', detail: 'expectedRevision must be a non-negative integer' };
    }
    let nextGroups: RuleGroup[] | undefined;
    if (groups !== undefined) {
      const checked = validateGroups(groups);
      if (!checked.ok) return { ok: false, error: 'invalid', detail: checked.detail };
      nextGroups = checked.groups;
    }
    const validation = validateRules(rules, nextGroups && groupIdSet(nextGroups));
    if (!validation.ok) return { ok: false, error: 'invalid', detail: validation.detail };
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const current = normalizeSettings(stored[SETTINGS_KEY]);
    if (current.revision !== expectedRevision) {
      return {
        ok: false,
        error: 'conflict',
        detail: `expected revision ${expectedRevision} but the current revision is ${current.revision}`,
      };
    }
    if (nextGroups === undefined) {
      const kept = validateRules(validation.rules, groupIdSet(current.ruleGroups));
      if (!kept.ok) return { ok: false, error: 'invalid', detail: kept.detail };
    }
    const next = withRules(current, validation.rules, current.revision + 1, nextGroups);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return { ok: true, settings: next };
  });
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ): void => {
    if (area === 'local' && SETTINGS_KEY in changes) {
      listener(normalizeSettings(changes[SETTINGS_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}