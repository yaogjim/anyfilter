import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../domain/settings';
import { useLanguage } from '../language';
import { CaptureSection } from './CaptureSection';
import { Header, type PanelView } from './Header';
import { EvaluationSection } from './EvaluationSection';
import { HiddenGroups } from './HiddenGroups';
import { AutoSection } from './AutoSection';
import { PageSection } from './PageSection';
import type { PageGateway, PanelGateway } from './PanelGateway';
import { ReviewDataSection } from './ReviewDataSection';
import { ReviewSwitch } from './ReviewSwitch';
import { SettingsSection } from './SettingsSection';
import { SitesSection } from './SitesSection';
import { Tiles } from './Tiles';
import { useSubscribedValue } from './use-subscribed-value';
import { VerificationSection } from './VerificationSection';

export function App({ gateway }: { gateway: PanelGateway & PageGateway }) {
  const { t } = useLanguage();
  const [view, setView] = useState<PanelView>('home');
  const [settingsVisited, setSettingsVisited] = useState(false);
  // Which view to open on: X keeps its overview, any other page opens on "this
  // page". Decided once, and only if the person has not already picked a view.
  const chosen = useRef(false);
  useEffect(() => {
    let active = true;
    void gateway.loadActiveTab().then((tab) => {
      // Only an ordinary web page can be judged; on X, a new tab or a browser page
      // the home view is the useful one.
      const url = tab.url ?? '';
      const judgeable =
        /^https?:\/\//.test(url) &&
        !url.startsWith('https://x.com/') &&
        !url.startsWith('https://news.ycombinator.com/');
      if (active && !chosen.current && judgeable) setView('page');
    });
    return () => {
      active = false;
    };
  }, [gateway]);
  const settings = useSubscribedValue(gateway.loadSettings, gateway.onSettingsChanged);
  const panel = useSubscribedValue(gateway.loadPanelState, gateway.onPanelStateChanged);

  if (settings.status === 'error') return <p className="p-4 text-ink-2">{settings.message}</p>;
  if (panel.status === 'error') return <p className="p-4 text-ink-2">{panel.message}</p>;
  if (settings.status === 'loading' || panel.status === 'loading') {
    return <p className="p-4 text-ink-2">{t('shell.loading')}</p>;
  }

  const current = settings.value;
  const state = panel.value;
  const updateSettings = (patch: Partial<Settings>): void => {
    void gateway.saveSettings({ ...current, ...patch });
  };
  const navigate = (next: PanelView): void => {
    chosen.current = true;
    if (next === 'settings') setSettingsVisited(true);
    setView(next);
  };
  const labelOrder = current.rules.map((rule) => rule.label);

  return (
    <main className="mx-auto max-w-6xl space-y-3 p-3 sm:p-4">
      <h1 className="sr-only">AnyFilter</h1>
      <div className="sticky top-0 z-20 rounded-xl border border-line bg-white p-2.5 shadow-sm sm:p-3.5">
        <Header
          settings={current}
          state={state}
          view={view}
          onNavigate={navigate}
          onToggle={(filterOn) => updateSettings({ filterOn })}
        />
      </div>
      {view === 'page' && (
        <>
          <PageSection gateway={gateway} />
          {/* The one place sites are turned on, next to the list of authorised sites. */}
          <SitesSection gateway={gateway} />
          <AutoSection gateway={gateway} />
        </>
      )}
      {view === 'home' && (
        <>
          <section className="rounded-xl border border-line bg-white p-3.5" aria-label={t('shell.overview')}>
            <Tiles state={state} />
          </section>
          <ReviewSwitch scope="home" on={current.reviewMode} onChange={(reviewMode) => updateSettings({ reviewMode })} />
          <HiddenGroups state={state} labelOrder={labelOrder} onOverride={gateway.override} />
        </>
      )}
      {settingsVisited && (
        <div hidden={view !== 'settings'}>
          <div className="mb-3 flex items-center justify-between gap-2 px-1">
            <h2 className="m-0 text-[17px] font-bold">{t('shell.settingsHeading')}</h2>
            <button
              type="button"
              className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:bg-surface"
              onClick={() => void chrome.runtime.openOptionsPage()}
            >
              {t('shell.openFullPage')}
            </button>
          </div>
          <SettingsSection
            settings={current}
            onChange={updateSettings}
            onClearData={gateway.clearData}
            onClearHidden={gateway.clearHidden}
            onSaveRules={gateway.saveRules}
            onPreview={gateway.previewRule}
          />
        </div>
      )}
      {view === 'verification' && (
        <>
          <div className="rounded-xl border border-line bg-white p-3.5">
            <CaptureSection gateway={gateway} />
          </div>
          <ReviewDataSection gateway={gateway} />
          <EvaluationSection gateway={gateway} />
          <VerificationSection gateway={gateway} settings={current} />
        </>
      )}
    </main>
  );
}