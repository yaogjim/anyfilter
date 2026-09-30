/**
 * The toolbar icon click is what gives `activeTab` on a tab, but it fires no tab
 * event, so an open side panel would go on believing the tab is unreadable. The
 * background leaves a timestamp in session storage; the panel watches it and asks
 * the browser about the active tab again. Session storage is gone when the
 * browser closes, and nothing about the page is written.
 */
const KEY = 'anyfilter.toolbarClickedAt';

export function recordToolbarClick(): Promise<void> {
  return chrome.storage.session.set({ [KEY]: Date.now() });
}

/** Calls `listener` after each toolbar click. Returns the unsubscribe function. */
export function onToolbarClick(listener: () => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area === 'session' && KEY in changes) listener();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
