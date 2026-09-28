const OVERRIDES_KEY = 'anyfilter.overrides';
const MAX_OVERRIDES = 500;

/** Manual "put back in feed" choices, persisted so they survive a page refresh. */
export async function loadOverrides(): Promise<Map<string, boolean>> {
  const stored = await chrome.storage.local.get(OVERRIDES_KEY);
  const raw: unknown = stored[OVERRIDES_KEY];
  const overrides = new Map<string, boolean>();
  if (typeof raw === 'object' && raw !== null) {
    for (const [postId, shown] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof shown === 'boolean') overrides.set(postId, shown);
    }
  }
  return overrides;
}

export async function saveOverrides(overrides: ReadonlyMap<string, boolean>): Promise<void> {
  const entries = [...overrides.entries()].slice(-MAX_OVERRIDES);
  await chrome.storage.local.set({ [OVERRIDES_KEY]: Object.fromEntries(entries) });
}