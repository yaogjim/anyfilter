import {
  DEFAULT_CONNECTIONS,
  type EvaluationConnections,
  normalizeConnection,
  specWith,
  type LabellerSpec,
  type MachineConnectionId,
} from '../domain/evaluation-pricing';

/**
 * Where each machine labeller is reached and which model it is asked for.
 *
 * Stored apart from the keys because it is not a secret: the side panel may read
 * it back to show it. A stored value that is not a usable `https` base URL with a
 * priced model is ignored and the default is used, so a corrupted record can
 * never send a request to an odd place or at an unknown price.
 */

export const EVALUATION_CONNECTION_KEY = 'anyfilter.evaluation.connection';

export async function loadEvaluationConnections(): Promise<EvaluationConnections> {
  try {
    const stored = (await chrome.storage.local.get(EVALUATION_CONNECTION_KEY))[EVALUATION_CONNECTION_KEY];
    const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    return {
      openai: normalizeConnection('openai', record.openai) ?? DEFAULT_CONNECTIONS.openai,
      deepseek: normalizeConnection('deepseek', record.deepseek) ?? DEFAULT_CONNECTIONS.deepseek,
    };
  } catch {
    return DEFAULT_CONNECTIONS;
  }
}

/** Saves one labeller's connection. Returns `false` when it is not acceptable. */
export async function saveEvaluationConnection(id: MachineConnectionId, value: unknown): Promise<boolean> {
  const connection = normalizeConnection(id, value);
  if (connection === null) return false;
  try {
    const current = await loadEvaluationConnections();
    await chrome.storage.local.set({ [EVALUATION_CONNECTION_KEY]: { ...current, [id]: connection } });
    return true;
  } catch {
    return false;
  }
}

export async function machineSpecOf(id: MachineConnectionId): Promise<LabellerSpec> {
  return specWith(id, (await loadEvaluationConnections())[id]);
}
