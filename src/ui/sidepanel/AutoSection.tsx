import { useEffect, useState } from 'react';
import {
  AUTO_CAP_MICRO,
  AUTO_DAILY_REQUESTS,
  AUTO_MAX_FAILURES,
  canAuthorise,
  formatDollars,
  hostOfPattern,
  originPatternOf,
  refusalOf,
  type AutoState,
} from '../../domain/auto-mode';
import { useLanguage } from '../language';
import type { PageGateway } from './PanelGateway';
import { useSubscribedValue } from './use-subscribed-value';

/**
 * The auto mode switch, the sites it may run on, and what it has spent. Sits under
 * "this page": everything here is about pages the person did not click on.
 */
export function AutoSection({ gateway }: { gateway: PageGateway }) {
  const { t } = useLanguage();
  const auto = useSubscribedValue(gateway.loadAutoState, gateway.onAutoStateChanged);
  const activeTab = useSubscribedValue(gateway.loadActiveTab, gateway.onActiveTabChanged);
  const [sites, setSites] = useState<string[]>([]);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void gateway.listAuthorisedSites().then((list) => {
        if (live) setSites(list);
      });
    };
    refresh();
    const stop = gateway.onAuthorisedSitesChanged(refresh);
    return () => {
      live = false;
      stop();
    };
  }, [gateway]);

  if (auto.status !== 'ready') return null;
  const state: AutoState = auto.value;
  const address = activeTab.status === 'ready' ? activeTab.value.url : null;
  const pattern = address === null ? null : originPatternOf(address);
  const host = pattern === null ? null : hostOfPattern(pattern);
  const offered = address !== null && canAuthorise(address);
  const allowed = host !== null && sites.includes(host);
  const refusal = refusalOf({ ...state, enabled: true, paused: false }, Date.now());

  const allow = (): void => {
    if (pattern === null || host === null) return;
    setDenied(null);
    void gateway.requestSite(pattern).then((granted) => {
      if (!granted) setDenied(host);
    });
  };

  return (
    <section className="mt-3 rounded-xl border border-line bg-white p-3.5" aria-label={t('auto.heading')} data-anyfilter-auto="section">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[13px] font-bold">{t('auto.heading')}</h2>
        <button
          type="button"
          aria-pressed={state.enabled}
          data-anyfilter-auto="toggle"
          onClick={() => void gateway.setAutoEnabled(!state.enabled)}
          className={`min-h-9 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${state.enabled ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:bg-surface hover:text-ink'}`}
        >
          {state.enabled ? t('auto.turnOff') : t('auto.turnOn')}
        </button>
      </div>
      <p className="mb-0 mt-2 text-xs text-ink-2">{t('auto.intro')}</p>

      <h3 className="mb-1 mt-3 text-xs font-bold">{t('auto.site.heading')}</h3>
      {address === null ? (
        <p data-anyfilter-auto="site-hint" className="m-0 text-xs text-ink-2">
          {t('auto.site.needsIcon')}
        </p>
      ) : !offered || host === null ? (
        <p data-anyfilter-auto="site-hint" className="m-0 text-xs text-ink-2">
          {t('auto.site.notOffered')}
        </p>
      ) : allowed ? (
        <p data-anyfilter-auto="site-allowed" className="m-0 text-xs text-ink">
          {t('auto.site.allowed', { host })}
        </p>
      ) : (
        <button
          type="button"
          data-anyfilter-auto="site-allow"
          onClick={allow}
          className="min-h-9 rounded-lg border border-ink px-2.5 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {t('auto.site.allowThis', { host })}
        </button>
      )}
      {denied !== null && (
        <p role="alert" data-anyfilter-auto="site-denied" className="mb-0 mt-1 text-xs text-hide">
          {t('auto.site.denied', { host: denied })}
        </p>
      )}
      {sites.length === 0 ? (
        <p className="mb-0 mt-2 text-xs text-ink-2">{t('auto.site.none')}</p>
      ) : (
        <ul className="mb-0 mt-2 list-none space-y-1 p-0" data-anyfilter-auto="sites">
          {sites.map((site) => (
            <li key={site} className="flex items-center justify-between gap-2 text-xs" data-anyfilter-auto-site={site}>
              <span className="truncate">{site}</span>
              <button
                type="button"
                aria-label={t('auto.site.revokeLabel', { host: site })}
                data-anyfilter-auto="site-remove"
                onClick={() => void gateway.removeSite(`https://${site}/*`).then(() => gateway.removeSite(`http://${site}/*`))}
                className="rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {t('auto.site.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p data-anyfilter-auto="usage" className="mb-0 mt-3 text-xs text-ink-2">
        {t('auto.usage', {
          spent: formatDollars(state.spentMicro),
          cap: formatDollars(AUTO_CAP_MICRO),
          count: state.dayCount,
          limit: AUTO_DAILY_REQUESTS,
        })}
      </p>
      <p className="mb-0 mt-1 text-[11px] text-ink-2">{t('auto.badgeNote')}</p>
      {state.paused && (
        <div role="alert" data-anyfilter-auto="paused" className="mt-2 text-xs text-hide">
          <p className="m-0">{t('auto.paused', { count: AUTO_MAX_FAILURES })}</p>
          <button
            type="button"
            data-anyfilter-auto="resume"
            onClick={() => void gateway.resumeAuto()}
            className="mt-1 min-h-9 rounded-lg border border-ink bg-ink px-2.5 py-1.5 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {t('auto.resume')}
          </button>
        </div>
      )}
      {refusal === 'cap' && (
        <p data-anyfilter-auto="cap" className="mb-0 mt-2 text-xs text-hide">
          {t('auto.capReached')}
        </p>
      )}
      {refusal === 'daily' && (
        <p data-anyfilter-auto="daily" className="mb-0 mt-2 text-xs text-hide">
          {t('auto.dailyReached')}
        </p>
      )}
      {state.spentMicro > 0 && (
        <button
          type="button"
          data-anyfilter-auto="reset"
          onClick={() => void gateway.resetAutoSpend()}
          className="mt-2 rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {t('auto.resetSpend')}
        </button>
      )}
    </section>
  );
}
