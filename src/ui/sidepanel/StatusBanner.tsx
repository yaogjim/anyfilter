import type { PanelState } from '../../domain/panel-state';
import { activeKey, type Settings } from '../../domain/settings';
import { useLanguage, type Translate } from '../language';

/** What is stopping filtering from working, or null when nothing is. A missing key
 * comes first: no request is made without one, so a stale failure would mislead. */
function problemText(settings: Settings, state: PanelState, t: Translate): { text: string; failure: boolean } | null {
  if (!settings.filterOn) return null;
  if (activeKey(settings) === '') return { text: t('shell.status.addApiKey'), failure: false };
  const failure = state.lastFailure;
  if (!failure) return null;
  switch (failure.error) {
    case 'no-key':
      return { text: t('shell.status.addApiKey'), failure: false };
    case 'rate-limited':
      return { text: t('shell.status.failureRateLimited'), failure: true };
    case 'auth':
      return { text: t('shell.status.failureAuth'), failure: true };
    case 'network':
      return { text: t('shell.status.failureNetwork', { detail: failure.detail }), failure: true };
    case 'bad-response':
      return { text: t('shell.status.failureBadResponse', { detail: failure.detail }), failure: true };
  }
}

/** A banner on the home view for a missing key or a failing provider, with one
 * button that opens Settings at the models section. It renders nothing while
 * filtering is working (or switched off, which the header already says). */
export function StatusBanner({
  settings,
  state,
  onConfigure,
}: {
  settings: Settings;
  state: PanelState;
  onConfigure: () => void;
}) {
  const { t } = useLanguage();
  const problem = problemText(settings, state, t);
  if (problem === null) return null;
  return (
    <div
      role="status"
      data-anyfilter-banner={problem.failure ? 'failure' : 'no-key'}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-white p-3 ${problem.failure ? 'border-hide' : 'border-line'}`}
    >
      <p className={`m-0 min-w-0 flex-1 text-[13px] ${problem.failure ? 'text-hide' : 'text-ink'}`}>{problem.text}</p>
      <button
        type="button"
        onClick={onConfigure}
        data-anyfilter-banner-action="configure"
        className="min-h-9 flex-none rounded-lg border border-ink bg-ink px-3 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        {t('shell.banner.configure')}
      </button>
    </div>
  );
}
