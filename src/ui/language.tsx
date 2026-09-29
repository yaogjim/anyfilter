import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  translate,
  UI_LOCALE_KEY,
  type Translate,
  type TranslationKey,
  type UiLocale,
} from './i18n';

export { translate, UI_LOCALE_KEY };
export type { Translate, TranslationKey, UiLocale };

const LanguageContext = createContext<{
  locale: UiLocale;
  t: Translate;
  setLocale: (locale: UiLocale) => Promise<void>;
  saving: boolean;
  error: string;
}>({ locale: 'en', t: (key, params) => translate('en', key, params), setLocale: async () => {}, saving: false, error: '' });

/** UI-only preference: never changes filtering settings, questions or scores. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<UiLocale>('en');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local' || !changes[UI_LOCALE_KEY]) return;
      revision += 1;
      updateLocale(changes[UI_LOCALE_KEY].newValue === 'zh-CN' ? 'zh-CN' : 'en');
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.local.get(UI_LOCALE_KEY).then((stored) => {
      if (active && revision === 0) updateLocale(stored[UI_LOCALE_KEY] === 'zh-CN' ? 'zh-CN' : 'en');
    }).catch(() => {
      if (active && revision === 0) setError('load');
    });
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const setLocale = async (next: UiLocale): Promise<void> => {
    if (writing.current) return;
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      await chrome.storage.local.set({ [UI_LOCALE_KEY]: next });
      updateLocale(next);
    } catch {
      setError('save');
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  return (
    <LanguageContext.Provider value={{ locale, t: (key, params) => translate(locale, key, params), setLocale, saving, error }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() { return useContext(LanguageContext); }