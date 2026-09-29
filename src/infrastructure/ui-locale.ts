import { normalizeLocale, UI_LOCALE_KEY, type UiLocale } from '../ui/i18n';

/** The interface language for code that has no React context (the X content
 * script). It is the same stored preference the side panel and options page use. */
export async function loadUiLocale(): Promise<UiLocale> {
  try {
    const stored = await chrome.storage.local.get(UI_LOCALE_KEY);
    return normalizeLocale(stored[UI_LOCALE_KEY]);
  } catch {
    return 'en';
  }
}

export function onUiLocaleChanged(listener: (locale: UiLocale) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes[UI_LOCALE_KEY]) {
      listener(normalizeLocale(changes[UI_LOCALE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
