import { useId, useState } from 'react';
import { PROVIDERS, type ProviderId } from '../../domain/provider';
import type { Settings } from '../../domain/settings';
import { useLanguage } from '../language';
import { panelId, tabId, TabStrip } from './TabStrip';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 text-[12px] font-bold hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** The filtering model's provider, one tab per provider in `PROVIDERS`. The tab
 * opens on the provider in use; moving to another tab only lets you look at and
 * fill in its key. Only "Use this provider" changes what filtering uses. The key
 * field keeps the id `anyfilter-key` and is bound to the tab being looked at. */
export function ProviderTabs({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const { t } = useLanguage();
  const idBase = useId();
  const [viewed, setViewed] = useState<ProviderId>(settings.provider);
  const provider = PROVIDERS.find((candidate) => candidate.id === viewed) ?? PROVIDERS[0];
  const inUse = provider.id === settings.provider;

  return (
    <div>
      <TabStrip
        idBase={idBase}
        label={t('settings.provider')}
        selected={provider.id}
        onSelect={(id) => setViewed(id as ProviderId)}
        items={PROVIDERS.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          inUse: candidate.id === settings.provider,
          keySet: settings.keys[candidate.id].trim() !== '',
        }))}
      />
      <div
        role="tabpanel"
        id={panelId(idBase)}
        aria-labelledby={tabId(idBase, provider.id)}
        className="mt-2"
      >
        <label className="sr-only" htmlFor="anyfilter-key">
          {t('settings.apiKey')}
        </label>
        <input
          id="anyfilter-key"
          type="password"
          className={INPUT_CLASS}
          placeholder={t('settings.apiKeyPlaceholder', { hint: provider.keyHint })}
          value={settings.keys[provider.id]}
          onChange={(event) =>
            onChange({ keys: { ...settings.keys, [provider.id]: event.target.value } })
          }
        />
        <p className="mt-1 text-[11px] text-ink-2">{t('settings.apiKeyPrivacyNote')}</p>
        <div className="mt-2 flex items-center gap-2">
          {inUse ? (
            <span className="text-[12px] font-semibold text-ink-2" data-anyfilter-provider="in-use">
              {t('settings.providerInUse')}
            </span>
          ) : (
            <button
              type="button"
              className={BUTTON_CLASS}
              data-anyfilter-provider="use"
              onClick={() => onChange({ provider: provider.id })}
            >
              {t('settings.useProvider')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
