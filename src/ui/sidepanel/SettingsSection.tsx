import { useEffect, useState } from 'react';
import { PROVIDERS } from '../../domain/provider';
import type { PostKind } from '../../domain/post';
import type { PreviewInput, PreviewResult, Rule, SaveRulesResult } from '../../domain/rule';
import type { Settings } from '../../domain/settings';
import { useLanguage } from '../language';
import { ReviewSwitch } from './ReviewSwitch';
import { RuleManager } from './RuleManager';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const SUBHEADING_CLASS = 'mb-2 text-[15px] font-bold text-ink';
const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';
const CARD_CLASS = 'scroll-mt-24 rounded-xl border border-line bg-white p-4';

export function SettingsSection({
  settings,
  onChange,
  onClearData,
  onClearHidden,
  onSaveRules,
  onPreview,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClearData: () => Promise<void>;
  onClearHidden: (kind: PostKind) => Promise<void>;
  onSaveRules: (rules: Rule[], expectedRevision: number) => Promise<SaveRulesResult>;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
}) {
  const { t, locale, setLocale, saving: savingLocale, error: localeError } = useLanguage();
  const provider = PROVIDERS.find((candidate) => candidate.id === settings.provider) ?? PROVIDERS[0];
  const [rulesDirty, setRulesDirty] = useState(false);

  // Closing or reloading the options tab would drop an unsaved rule draft.
  useEffect(() => {
    if (!rulesDirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [rulesDirty]);

  return (
    <div className="grid gap-4">
      <section id="appearance" className={CARD_CLASS}>
        <h2 className={SUBHEADING_CLASS}>{t('settings.appearance')}</h2>
        <label className="block" htmlFor="anyfilter-language">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-2">
            {t('settings.interfaceLanguage')}
          </span>
          <select
            id="anyfilter-language"
            data-anyfilter-language="select"
            aria-label={t('settings.interfaceLanguage')}
            className={`${INPUT_CLASS} max-w-xs cursor-pointer disabled:opacity-50`}
            value={locale}
            disabled={savingLocale}
            onChange={(event) => void setLocale(event.target.value === 'zh-CN' ? 'zh-CN' : 'en')}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        <p className="mt-1 text-[11px] text-ink-2">
          {t('settings.languageSwitchNote')}
        </p>
        {localeError !== '' && (
          <p className="mt-1 text-[11px] text-hide">
            {localeError === 'load'
              ? t('settings.localeLoadError')
              : t('settings.localeSaveError')}
          </p>
        )}
      </section>

      <ReviewSwitch
        scope="settings"
        on={settings.reviewMode}
        onChange={(reviewMode) => onChange({ reviewMode })}
      />

      <section id="provider" className={CARD_CLASS}>
        <h2 className={SUBHEADING_CLASS}>{t('settings.provider')}</h2>
        <div
          className="flex flex-wrap rounded-lg bg-surface p-0.5"
          role="radiogroup"
          aria-label={t('settings.provider')}
        >
          {PROVIDERS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={candidate.id === settings.provider}
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                candidate.id === settings.provider
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-ink-2 hover:text-ink'
              }`}
              onClick={() => onChange({ provider: candidate.id })}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="anyfilter-key">
          {t('settings.apiKey')}
        </label>
        <input
          id="anyfilter-key"
          type="password"
          className={`${INPUT_CLASS} mt-1.5`}
          placeholder={t('settings.apiKeyPlaceholder', { hint: provider.keyHint })}
          value={settings.keys[settings.provider]}
          onChange={(event) =>
            onChange({ keys: { ...settings.keys, [settings.provider]: event.target.value } })
          }
        />
        <p className="mt-1 text-[11px] text-ink-2">
          {t('settings.apiKeyPrivacyNote')}
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section id="threshold" className={CARD_CLASS}>
          <h2 className={SUBHEADING_CLASS}>{t('settings.threshold')}</h2>
          <label className="block">
            <span className="text-ink-2">
              {t('settings.thresholdProbabilityAtLeast')}{' '}
              <b className="text-ink tabular-nums">{Math.round(settings.threshold * 100)}%</b>
            </span>
            <input
              type="range"
              className="anyfilter-range mt-1 w-full"
              min={50}
              max={95}
              step={5}
              value={Math.round(settings.threshold * 100)}
              onChange={(event) => onChange({ threshold: Number(event.target.value) / 100 })}
            />
            <span className="flex justify-between text-[11px] text-ink-2">
              <span>{t('settings.hideMore')}</span>
              <span>{t('settings.hideLess')}</span>
            </span>
          </label>
          <p className="mt-1 text-[11px] text-ink-2">
            {t('settings.thresholdNote')}
          </p>
        </section>

        <section id="data" className={CARD_CLASS}>
          <h2 className={SUBHEADING_CLASS}>{t('settings.data')}</h2>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => void onClearHidden('post')}
            >
              {t('settings.clearHiddenPosts')}
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => void onClearHidden('reply')}
            >
              {t('settings.clearHiddenReplies')}
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void onClearData()}>
              {t('settings.clearEverything')}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-ink-2">
            {t('settings.clearEverythingNote')}
          </p>
        </section>
      </div>

      <section id="rules" className={`${CARD_CLASS} @container p-3`}>
        <RuleManager
          rules={settings.rules}
          revision={settings.revision}
          threshold={settings.threshold}
          onSaveRules={onSaveRules}
          onPreview={onPreview}
          onDirtyChange={setRulesDirty}
        />
      </section>
    </div>
  );
}