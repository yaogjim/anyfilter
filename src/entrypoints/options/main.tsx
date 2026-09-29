import '../../assets/globals.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BackgroundClient } from '../../infrastructure/background-client';
import { loadCaptureState, onCaptureStateChanged } from '../../infrastructure/capture-store';
import {
  loadVerificationCandidates,
  loadVerificationStatus,
} from '../../infrastructure/evaluation-verification';
import { loadPanelState, onPanelStateChanged } from '../../infrastructure/panel-state-store';
import { loadReviewCount, loadReviewStore, onReviewRecordsChanged } from '../../infrastructure/review-store';
import { loadSettings, onSettingsChanged, saveSettings } from '../../infrastructure/settings-store';
import { CaptureSection } from '../../ui/sidepanel/CaptureSection';
import type { PanelGateway } from '../../ui/sidepanel/PanelGateway';
import { SettingsSection } from '../../ui/sidepanel/SettingsSection';
import { useSubscribedValue } from '../../ui/sidepanel/use-subscribed-value';
import { LanguageProvider, useLanguage, type TranslationKey } from '../../ui/language';

const NAV: ReadonlyArray<{ id: string; labelKey: TranslationKey }> = [
  { id: 'appearance', labelKey: 'shell.nav.appearance' },
  { id: 'provider', labelKey: 'shell.nav.provider' },
  { id: 'threshold', labelKey: 'shell.nav.threshold' },
  { id: 'rules', labelKey: 'shell.nav.rules' },
  { id: 'capture', labelKey: 'shell.nav.capture' },
  { id: 'data', labelKey: 'shell.nav.data' },
];

const LINK_CLASS =
  'block rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-ink-2 transition hover:bg-white hover:text-ink';

function Shield() {
  return (
    <span
      className="grid h-8.5 w-8.5 flex-none place-items-center rounded-lg bg-ink text-white"
      aria-hidden="true"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    </span>
  );
}

function OptionsPage({ gateway }: { gateway: PanelGateway }) {
  const { t } = useLanguage();
  const settings = useSubscribedValue(gateway.loadSettings, gateway.onSettingsChanged);

  const shell = (body: React.ReactNode) => (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-2.5 px-6 py-3.5">
          <Shield />
          <div className="min-w-0">
            <h1 className="m-0 text-[15px] font-bold leading-tight">
              {t('shell.options.title')}
            </h1>
            <p className="m-0 text-xs text-ink-2">
              {t('shell.options.subtitle')}
            </p>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl gap-6 px-3 py-6 sm:px-6">
        <aside className="hidden w-44 flex-none lg:block">
          <nav className="sticky top-24" aria-label={t('shell.options.sections')}>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-2">
              {t('shell.options.onThisPage')}
            </p>
            <ul className="m-0 list-none space-y-1 p-0">
              {NAV.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`} className={LINK_CLASS}>
                    {t(item.labelKey)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{body}</main>
      </div>
    </div>
  );

  if (settings.status === 'error') {
    return shell(<p className="text-ink-2">{settings.message}</p>);
  }
  if (settings.status === 'loading') {
    return shell(<p className="text-ink-2">{t('shell.loading')}</p>);
  }

  const current = settings.value;

  return shell(
    <>
      <section className="mb-6 rounded-2xl border border-line bg-white p-5">
        <h2 className="m-0 text-[15px] font-bold text-ink">
          {t('shell.options.howTitle')}
        </h2>
        <p className="mb-0 mt-1.5 text-[13px] text-ink-2">
          {t('shell.options.howBody')}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5 lg:hidden">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] font-semibold text-ink-2"
            >
              {t(item.labelKey)}
            </a>
          ))}
        </div>
      </section>
      <div>
        <SettingsSection
          settings={current}
          onChange={(patch) => void gateway.saveSettings({ ...current, ...patch })}
          onClearData={gateway.clearData}
          onClearHidden={gateway.clearHidden}
          onSaveRules={gateway.saveRules}
          onPreview={gateway.previewRule}
        />
      </div>
      <div className="mt-6 rounded-2xl border border-line bg-white p-5">
        <CaptureSection gateway={gateway} />
      </div>
    </>,
  );
}

const client = new BackgroundClient();

const gateway: PanelGateway = {
  loadSettings,
  saveSettings,
  onSettingsChanged,
  loadPanelState,
  onPanelStateChanged,
  saveRules: (rules, expectedRevision) => client.saveRules(rules, expectedRevision),
  previewRule: (input) => client.previewRule(input),
  override: (postId, shown) => client.override(postId, shown),
  clearData: () => client.clearData(),
  clearHidden: (kind) => client.clearHidden(kind),
  loadCaptureState,
  onCaptureStateChanged,
  setCaptureRunState: (runState) => client.setCaptureRunState(runState),
  clearCapture: () => client.clearCapture(),
  loadVerificationCandidates,
  loadVerificationStatus,
  loadVerificationSampleDetail: (sampleId) => client.loadVerificationSampleDetail(sampleId),
  enableVerificationBudget: () => client.enableVerificationBudget(),
  disableVerificationBudget: () => client.disableVerificationBudget(),
  runVerificationSample: (sampleId, ruleId) => client.runVerificationSample(sampleId, ruleId),
  loadReviewCount,
  onReviewCountChanged: onReviewRecordsChanged,
  clearReviewRecords: () => client.clearReviewRecords(),
  exportReviewRecords: async () => (await loadReviewStore()).records,
  loadEvaluationOverview: () => client.loadEvaluationOverview(),
  loadKeyPresence: () => client.loadKeyPresence(),
  setEvaluationKey: (labeller, key) => client.setEvaluationKey(labeller, key),
  loadEvaluationConnections: () => client.loadEvaluationConnections(),
  setEvaluationConnection: (labeller, baseUrl, model) => client.setEvaluationConnection(labeller, baseUrl, model),
  startEvaluationBatch: (labeller) => client.startEvaluationBatch(labeller),
  stopEvaluationBatch: () => client.stopEvaluationBatch(),
  loadEvaluationRunStatus: () => client.loadEvaluationRunStatus(),
  exportEvaluation: () => client.exportEvaluation(),
};

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('options root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <LanguageProvider>
      <OptionsPage gateway={gateway} />
    </LanguageProvider>
  </React.StrictMode>,
);