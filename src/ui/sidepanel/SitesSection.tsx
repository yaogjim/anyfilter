import { useEffect, useState } from 'react';
import { FEED_SITES } from '../../domain/feed-sites';
import { useLanguage } from '../language';
import type { PageGateway } from './PanelGateway';

/**
 * The sites other than X that can be turned on. A switch here is a real browser
 * permission: turning one on asks the browser, turning it off gives the access
 * back. The panel keeps no separate on/off flag, so it cannot drift from the truth.
 */
export function SitesSection({ gateway }: { gateway: PageGateway }) {
  const { t } = useLanguage();
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void gateway.enabledFeedSiteIds().then((ids) => {
        if (live) setEnabled(ids);
      });
    };
    refresh();
    const stop = gateway.onAuthorisedSitesChanged(refresh);
    return () => {
      live = false;
      stop();
    };
  }, [gateway]);

  if (enabled === null) return null;

  return (
    <section className="rounded-xl border border-line bg-white p-3.5" aria-label={t('sites.heading')} data-anyfilter-sites="section">
      <h2 className="m-0 text-[13px] font-bold">{t('sites.heading')}</h2>
      <p className="mb-0 mt-1 text-xs text-ink-2">{t('sites.intro')}</p>
      <ul className="mb-0 mt-2 list-none space-y-3 p-0">
        {FEED_SITES.map((site) => {
          const on = enabled.includes(site.id);
          return (
            <li key={site.id} data-anyfilter-site={site.id} data-anyfilter-site-on={on ? 'true' : 'false'}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{site.name}</span>
                <button
                  type="button"
                  aria-pressed={on}
                  data-anyfilter-sites="toggle"
                  // The browser only shows its prompt inside the click itself, so the
                  // request is the first thing the handler does.
                  onClick={() => {
                    if (on) {
                      void gateway.removeSite(site.pattern);
                      return;
                    }
                    setDenied(null);
                    void gateway.requestSite(site.pattern).then((granted) => {
                      if (!granted) setDenied(site.name);
                    });
                  }}
                  className={`min-h-9 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${on ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:bg-surface hover:text-ink'}`}
                >
                  {on ? t('sites.turnOff') : t('sites.turnOn')}
                </button>
              </div>
              <p className="mb-0 mt-1 text-xs text-ink-2">{t('sites.hn.blurb')}</p>
            </li>
          );
        })}
      </ul>
      {denied !== null && (
        <p role="alert" data-anyfilter-sites="denied" className="mb-0 mt-2 text-xs text-hide">
          {t('sites.denied', { site: denied })}
        </p>
      )}
      <p className="mb-0 mt-2 text-[11px] text-ink-2">{t('sites.note')}</p>
    </section>
  );
}
