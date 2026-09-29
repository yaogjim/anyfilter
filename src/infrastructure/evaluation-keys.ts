import { MAX_KEY_LENGTH, type MachineLabellerId } from '../domain/machine-label';
import { loadSettings } from './settings-store';

/**
 * Keys for the two independent machine labellers.
 *
 * They live in their own `storage.local` record, never in `Settings`: the feed
 * classifier, the preview path and every content script only know the two feed
 * providers, and nothing that reads `Settings` can ever see or send these keys.
 * Only the background reads a value, and only to build one authorized request.
 * The side panel can set or clear a key and learn whether one exists; it can
 * never read one back.
 */

export const EVALUATION_KEYS_KEY = 'anyfilter.evaluation.keys';

export interface EvaluationKeys {
  readonly openai: string;
  readonly deepseek: string;
}

export async function loadEvaluationKeys(): Promise<EvaluationKeys> {
  try {
    const stored = (await chrome.storage.local.get(EVALUATION_KEYS_KEY))[EVALUATION_KEYS_KEY];
    const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    const read = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    return { openai: read(record.openai), deepseek: read(record.deepseek) };
  } catch {
    return { openai: '', deepseek: '' };
  }
}

/** Sets (or, with an empty string, clears) one key. Returns `false` when the
 * value is not a plausible key or storage refused it. */
export async function saveEvaluationKey(id: MachineLabellerId, value: string): Promise<boolean> {
  const key = value.trim();
  // A key is one printable-ASCII token; anything else is a paste mistake.
  if (key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]*$/.test(key)) return false;
  try {
    const current = await loadEvaluationKeys();
    await chrome.storage.local.set({ [EVALUATION_KEYS_KEY]: { ...current, [id]: key } });
    return true;
  } catch {
    return false;
  }
}

export async function clearEvaluationKeys(): Promise<void> {
  try {
    await chrome.storage.local.remove(EVALUATION_KEYS_KEY);
  } catch {
    // Nothing to do: a key that could not be removed is still never sent anywhere else.
  }
}

/** Whether each labeller has a key, without exposing any value. */
export interface KeyPresence {
  readonly jev: boolean;
  readonly openai: boolean;
  readonly deepseek: boolean;
}

export async function loadKeyPresence(): Promise<KeyPresence> {
  const [keys, settings] = await Promise.all([loadEvaluationKeys(), loadSettings()]);
  return {
    jev: settings.keys.typesafe.trim() !== '',
    openai: keys.openai !== '',
    deepseek: keys.deepseek !== '',
  };
}

export function isKeyPresence(value: unknown): value is KeyPresence {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jev === 'boolean' && typeof record.openai === 'boolean' && typeof record.deepseek === 'boolean'
  );
}
