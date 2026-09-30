import { useEffect, useState } from 'react';
import type { CaptureRunState, CaptureState } from '../../domain/capture';
import type { Settings } from '../../domain/settings';
import { useLanguage } from '../language';
import { EvaluationSection } from './EvaluationSection';
import type { PanelGateway } from './PanelGateway';
import { ReviewDataSection } from './ReviewDataSection';
import { panelId, tabId, TabStrip, type TabItem } from './TabStrip';
import { useEvaluationData } from './use-evaluation-data';
import { useSubscribedValue } from './use-subscribed-value';
import { VerificationSection } from './VerificationSection';

const ID_BASE = 'anyfilter-verify';
const LINK_CLASS =
  'rounded text-[12px] font-semibold text-ink underline underline-offset-2 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

type VerifyTab = 'evaluation' | 'single' | 'review';

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface px-2.5 py-1.5" data-anyfilter-strip={id}>
      <div className="truncate text-[11px] text-ink-2" title={label}>
        {label}
      </div>
      <div className="text-[17px] font-extrabold leading-tight tabular-nums text-ink">{value}</div>
    </div>
  );
}

function useReviewCount(gateway: PanelGateway): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void gateway.loadReviewCount().then((next) => active && setCount(next), () => undefined);
    };
    refresh();
    const stop = gateway.onReviewCountChanged(refresh);
    return () => {
      active = false;
      stop();
    };
  }, [gateway]);
  return count;
}

/** The numbers a verification depends on, always in view, with a way to the place
 * that changes each: capture is set in Settings, the budget on the evaluation tab. */
function StatusStrip({
  gateway,
  capture,
  onOpenSettings,
  onOpenBudget,
  overview,
}: {
  gateway: PanelGateway;
  capture: ReturnType<typeof useSubscribedValue<CaptureState>>;
  onOpenSettings: () => void;
  onOpenBudget: () => void;
  overview: { enabled: boolean; sampleCount: number; ruleCount: number } | null;
}) {
  const { t } = useLanguage();
  const reviews = useReviewCount(gateway);
  const dash = '—';
  const captureLabel = (state: CaptureRunState): string =>
    state === 'active'
      ? t('verification.strip.captureActive')
      : state === 'paused'
        ? t('verification.strip.capturePaused')
        : t('verification.strip.captureOff');

  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3"
      aria-label={t('verification.strip.label')}
      data-anyfilter-verify="strip"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat id="samples" label={t('verification.strip.samples')} value={overview === null ? dash : String(overview.sampleCount)} />
        <Stat id="rules" label={t('verification.strip.rules')} value={overview === null ? dash : String(overview.ruleCount)} />
        <Stat
          id="requests"
          label={t('verification.strip.requests')}
          value={overview === null ? dash : String(overview.sampleCount * overview.ruleCount)}
        />
        <Stat id="reviews" label={t('verification.strip.reviews')} value={String(reviews)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="flex flex-wrap items-center gap-1.5" data-anyfilter-strip="capture">
          <span>
            {t('verification.strip.capture')}:{' '}
            <b className="text-ink">{capture.status === 'ready' ? captureLabel(capture.value.runState) : dash}</b>
          </span>
          <button type="button" className={LINK_CLASS} onClick={onOpenSettings} data-anyfilter-strip="go-settings">
            {t('verification.strip.goSettings')}
          </button>
        </span>
        <span className="flex flex-wrap items-center gap-1.5" data-anyfilter-strip="budget">
          <span>
            {t('verification.strip.budget')}:{' '}
            <b className="text-ink">
              {overview === null
                ? dash
                : overview.enabled
                  ? t('verification.strip.budgetOn')
                  : t('verification.strip.budgetOff')}
            </b>
          </span>
          {overview !== null && !overview.enabled && (
            <button type="button" className={LINK_CLASS} onClick={onOpenBudget} data-anyfilter-strip="open-budget">
              {t('verification.strip.openBudget')}
            </button>
          )}
        </span>
      </div>
    </section>
  );
}

/** The verification view: a status strip, then one of three tools at a time.
 * Collecting samples is not here: it is set in Settings, and the strip links there. */
export function VerificationView({
  gateway,
  settings,
  onOpenSettings,
}: {
  gateway: PanelGateway;
  settings: Settings;
  /** Opens the settings view scrolled to a section (`models`, `capture`). */
  onOpenSettings: (anchor: string) => void;
}) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<VerifyTab>('evaluation');
  const data = useEvaluationData(gateway);
  // A capture or a delete changes how many samples a run would send, so the
  // overview is read again at once instead of waiting for the next poll.
  const capture = useSubscribedValue(gateway.loadCaptureState, gateway.onCaptureStateChanged);
  const stored = capture.status === 'ready' ? capture.value.stored : -1;
  const { refresh } = data;
  useEffect(() => {
    void refresh();
  }, [stored, refresh]);

  const items: TabItem[] = [
    { id: 'evaluation', label: t('verification.tab.evaluation') },
    { id: 'single', label: t('verification.tab.single') },
    { id: 'review', label: t('verification.tab.review') },
  ];

  return (
    <>
      <StatusStrip
        gateway={gateway}
        capture={capture}
        overview={data.overview}
        onOpenSettings={() => onOpenSettings('capture')}
        onOpenBudget={() => setTab('evaluation')}
      />
      <TabStrip
        idBase={ID_BASE}
        items={items}
        selected={tab}
        onSelect={(id) => setTab(id as VerifyTab)}
        label={t('verification.view.tabs')}
      />
      <div role="tabpanel" id={panelId(ID_BASE)} aria-labelledby={tabId(ID_BASE, tab)} className="flex flex-col gap-3">
        {tab === 'evaluation' && (
          <EvaluationSection gateway={gateway} data={data} onOpenSettings={() => onOpenSettings('models')} />
        )}
        {tab === 'single' && <VerificationSection gateway={gateway} settings={settings} />}
        {tab === 'review' && <ReviewDataSection gateway={gateway} />}
      </div>
    </>
  );
}
