/**
 * Framework-free translation core, shared by the React pages (side panel,
 * options) and the DOM code that runs inside the X content script. Keeping it
 * free of React means the content script never bundles React just to look up a
 * string.
 *
 * Copy always goes through a key. Components and DOM code never carry a
 * bilingual pair; the catalogs are checked for identical keys and placeholders
 * by `scripts/test/language.test.mjs`.
 */
import { evaluationEn } from './locales/evaluation.en';
import { evaluationZh } from './locales/evaluation.zh-CN';
import { pageEn } from './locales/page.en';
import { pageZh } from './locales/page.zh-CN';
import { reviewEn } from './locales/review.en';
import { reviewZh } from './locales/review.zh-CN';
import { settingsEn } from './locales/settings.en';
import { settingsZh } from './locales/settings.zh-CN';
import { shellEn } from './locales/shell.en';
import { sitesEn } from './locales/sites.en';
import { sitesZh } from './locales/sites.zh-CN';
import { shellZh } from './locales/shell.zh-CN';
import { verificationEn } from './locales/verification.en';
import { verificationZh } from './locales/verification.zh-CN';

const en = { ...settingsEn, ...verificationEn, ...shellEn, ...reviewEn, ...evaluationEn, ...pageEn, ...sitesEn };
export type TranslationKey = keyof typeof en;
const zh: Record<TranslationKey, string> = {
  ...settingsZh,
  ...verificationZh,
  ...shellZh,
  ...reviewZh,
  ...evaluationZh,
  ...pageZh,
  ...sitesZh,
};

export type UiLocale = 'en' | 'zh-CN';
export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate = (key: TranslationKey, params?: TranslateParams) => string;
export const UI_LOCALE_KEY = 'anyfilter.ui.locale';

export function translate(locale: UiLocale, key: TranslationKey, params?: TranslateParams): string {
  const template: string = locale === 'zh-CN' ? zh[key] : en[key];
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name: string) =>
    params?.[name] === undefined ? match : String(params[name]),
  );
}

export function normalizeLocale(value: unknown): UiLocale {
  return value === 'zh-CN' ? 'zh-CN' : 'en';
}
