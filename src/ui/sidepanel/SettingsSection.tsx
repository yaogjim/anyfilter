import { useEffect, useState } from 'react';
import type { PostKind } from '../../domain/post';
import type { PreviewInput, PreviewResult, Rule, SaveRulesResult } from '../../domain/rule';
import type { RuleGroup } from '../../domain/rule-group';
import type { Settings } from '../../domain/settings';
import { useLanguage } from '../language';
import { AssistantTabs } from './AssistantTabs';
import { CaptureSection } from './CaptureSection';
import type { PanelGateway } from './PanelGateway';
import { ProviderTabs } from './ProviderTabs';
import { ReviewSwitch } from './ReviewSwitch';
import { RuleGenerator } from './RuleGenerator';
import { RuleManager } from './RuleManager';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const SUBHEADING_CLASS = 'mb-2 text-[15px] font-bold text-ink';
const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';
const DANGER_BUTTON_CLASS =
  'rounded-lg border border-[#f4212e] bg-white px-3 py-1.5 font-bold text-[#f4212e]';
const CARD_CLASS = 'scroll-mt-32 rounded-xl border border-line bg-white p-4';

/** Two-step "clear everything": the first press turns the button into a
 * confirm/cancel pair in place, so nothing is wiped by one stray click and no
 * browser dialog is involved. */
function ClearEverything({ onClear }: { onClear: () => Promise<void> }) {
  const { t } = useLanguage();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className={DANGER_BUTTON_CLASS}
        data-anyfilter-clear="start"
        onClick={() => setConfirming(true)}
      >
        {t('settings.clearEverything')}
      </button>
    );
  }
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t('settings.clearEverythingPrompt')}
    >
      <button
        type="button"
        className="rounded-lg border border-[#f4212e] bg-[#f4212e] px-3 py-1.5 font-bold text-white"
        data-anyfilter-clear="confirm"
        onClick={() => {
          setConfirming(false);
          void onClear();
        }}
      >
        {t('settings.clearEverythingConfirm')}
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        data-anyfilter-clear="cancel"
        onClick={() => setConfirming(false)}
      >
        {t('settings.cancel')}
      </button>
    </span>
  );
}

export function SettingsSection({
  gateway,
  settings,
  onChange,
  onClearData,
  onClearHidden,
  onSaveRules,
  onPreview,
}: {
  gateway: PanelGateway;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClearData: () => Promise<void>;
  onClearHidden: (kind: PostKind) => Promise<void>;
  onSaveRules: (rules: Rule[], expectedRevision: number, groups: RuleGroup[]) => Promise<SaveRulesResult>;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
}) {
  const { t, locale, setLocale, saving: savingLocale, error: localeError } = useLanguage();
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

      <section id="models" className="grid scroll-mt-32 gap-4">
        <div className={CARD_CLASS}>
          <h2 className={SUBHEADING_CLASS}>{t('settings.filterModel')}</h2>
          <ProviderTabs settings={settings} onChange={onChange} />
        </div>
        <div className={CARD_CLASS} data-anyfilter-assistant="section">
          <h2 className={SUBHEADING_CLASS}>{t('settings.assistantModel')}</h2>
          <AssistantTabs gateway={gateway} settings={settings} onChange={onChange} />
        </div>
      </section>

      <section id="behavior" className={CARD_CLASS}>
        <h2 className={SUBHEADING_CLASS}>{t('settings.behavior')}</h2>
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
        <p className="mt-1 text-[11px] text-ink-2">{t('settings.thresholdNote')}</p>
        <hr className="my-3 border-0 border-t border-line" />
        <ReviewSwitch
          scope="settings"
          on={settings.reviewMode}
          onChange={(reviewMode) => onChange({ reviewMode })}
        />
      </section>

      <section id="rules" className={`${CARD_CLASS} @container p-3`}>
        <RuleManager
          rules={settings.rules}
          groups={settings.ruleGroups}
          revision={settings.revision}
          threshold={settings.threshold}
          onSaveRules={onSaveRules}
          onPreview={onPreview}
          onDirtyChange={setRulesDirty}
          renderAboveTabs={({ rule, patch, draft, hooks }) =>
            // Only a rule that has never been saved: a stored rule is edited by hand.
            rule.source === 'custom' && !settings.rules.some((saved) => saved.id === rule.id) ? (
              <RuleGenerator
                gateway={gateway}
                assistant={settings.assistant}
                rule={rule}
                patch={patch}
                draft={draft}
                hooks={hooks}
              />
            ) : null
          }
        />
      </section>

      <div className="flex items-center gap-3 px-1 pt-2" role="separator">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink-2">
          {t('settings.lessUsed')}
        </span>
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
      </div>

      <div className={CARD_CLASS}>
        <CaptureSection gateway={gateway} />
      </div>

      <section id="data" className={CARD_CLASS}>
        <h2 className={SUBHEADING_CLASS}>{t('settings.data')}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
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
          <ClearEverything onClear={onClearData} />
        </div>
        <p className="mt-1 text-[11px] text-ink-2">{t('settings.clearEverythingNote')}</p>
      </section>
    </div>
  );
}