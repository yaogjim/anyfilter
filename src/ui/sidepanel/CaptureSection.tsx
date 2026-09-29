import { MAX_SAMPLES, type CaptureRunState, type CaptureState } from '../../domain/capture';
import { useLanguage, type Translate } from '../language';
import type { PanelGateway } from './PanelGateway';
import { useSubscribedValue } from './use-subscribed-value';

const SUBHEADING_CLASS = 'mb-2 text-[15px] font-bold text-ink';
const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';
const MUTED_CLASS = 'text-ink-2';

function statusLine(state: CaptureState, t: Translate): string {
  if (state.runState === 'off') {
    return t('capture.status.off');
  }
  if (state.runState === 'paused') {
    return t('capture.status.paused', { stored: state.stored });
  }
  return t('capture.status.active', { stored: state.stored });
}

/**
 * Default-off controls for the local verification library: start, pause, read the
 * count, delete. Every control goes through the gateway to the background, which
 * is the only writer and which refuses a control request that does not come from
 * one of our own pages.
 */
export function CaptureSection({ gateway }: { gateway: PanelGateway }) {
  const { t } = useLanguage();
  const capture = useSubscribedValue(gateway.loadCaptureState, gateway.onCaptureStateChanged);
  const setRunState = (runState: CaptureRunState): void => {
    void gateway.setCaptureRunState(runState);
  };

  return (
    <section id="capture" className="scroll-mt-24" data-anyfilter-capture="section">
      <h2 className={SUBHEADING_CLASS}>{t('capture.heading')}</h2>
      {capture.status === 'error' ? (
        <p className={MUTED_CLASS}>{capture.message}</p>
      ) : capture.status === 'loading' ? (
        <p className={MUTED_CLASS}>{t('capture.loading')}</p>
      ) : (
        <>
          {/* Compact control card: state, controls and the short key privacy note. */}
          <div className="rounded-lg border border-line bg-surface p-2.5">
            <p className={`m-0 text-[13px] ${MUTED_CLASS}`} data-anyfilter-capture="status">
              {statusLine(capture.value, t)}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
            {capture.value.runState === 'active' ? (
              <button type="button" className={BUTTON_CLASS} onClick={() => setRunState('paused')}>
                {t('capture.pause')}
              </button>
            ) : (
              <button type="button" className={BUTTON_CLASS} onClick={() => setRunState('active')}>
                {capture.value.runState === 'paused'
                  ? t('capture.resume')
                  : t('capture.start')}
              </button>
            )}
            {capture.value.runState === 'off' ? null : (
              <button type="button" className={BUTTON_CLASS} onClick={() => setRunState('off')}>
                {t('capture.turnOff')}
              </button>
            )}
            <button
              type="button"
              className={BUTTON_CLASS}
              data-anyfilter-capture="clear"
              onClick={() => void gateway.clearCapture()}
            >
              {t('capture.deleteSamples')}
            </button>
          </div>
            <p className="m-0 mt-2 text-[11px] leading-relaxed text-ink-2">
              {t('capture.privacyNote')}
            </p>
          </div>
          <details className="mt-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[11px] text-ink-2">
            <summary className="cursor-pointer font-semibold text-ink">
              {t('capture.detailsSummary')}
            </summary>
            <p className="mb-0 mt-2">
              {t('capture.scopeNote')}
            </p>
            <p className="mb-0 mt-2">
              {t('capture.retentionNote', { max: MAX_SAMPLES, skipped: capture.value.skipped })}
            </p>
          </details>
        </>
      )}
    </section>
  );
}