import { hostOfPattern, neverAuto } from '../domain/auto-mode';

/**
 * Site authorisations for auto mode are the browser's own optional host
 * permissions. The extension keeps no list of its own: what the browser says is
 * granted is what is granted, so revoking in the browser's settings also works.
 */

/** Hosts the person has authorised, in name order. Never includes X or the
 * provider hosts, which are built in and not offered. */
export async function listAuthorisedSites(): Promise<string[]> {
  const granted = await chrome.permissions.getAll();
  const hosts = new Set<string>();
  for (const pattern of granted.origins ?? []) {
    const host = hostOfPattern(pattern);
    if (host !== null && !neverAuto(host)) hosts.add(host);
  }
  return [...hosts].sort();
}

export function onAuthorisedSitesChanged(listener: () => void): () => void {
  chrome.permissions.onAdded.addListener(listener);
  chrome.permissions.onRemoved.addListener(listener);
  return () => {
    chrome.permissions.onAdded.removeListener(listener);
    chrome.permissions.onRemoved.removeListener(listener);
  };
}

/** Must be called from a click: the browser shows its own permission prompt. */
export async function requestSite(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function removeSite(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    return false;
  }
}
