import { scannedCount, type PanelState } from '../../domain/panel-state';
import { useLanguage, type Translate } from '../language';
import type { Settings } from '../../domain/settings';

/** Only the filter being off is said here. A missing key or a failing provider is
 * the home view's banner, so it is stated once, next to the way to fix it. */
function statusText(settings: Settings, state: PanelState, t: Translate): string {
  if (!settings.filterOn) return t('shell.status.filterOff', { count: scannedCount(state) });
  return '';
}

export type PanelView = 'home' | 'page' | 'settings' | 'verification';

export function Header({
  settings,
  state,
  onToggle,
  view,
  onNavigate,
}: {
  settings: Settings;
  state: PanelState;
  onToggle: (filterOn: boolean) => void;
  view: PanelView;
  onNavigate: (view: PanelView) => void;
}) {
  const { t } = useLanguage();
  const status = statusText(settings, state, t);
  return (
    <header>
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-lg text-left font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          aria-label={t('shell.nav.home')}
          aria-pressed={view === 'home'}
          data-anyfilter-nav="home"
          onClick={() => onNavigate('home')}
        >
          <span
            className={`grid h-8.5 w-8.5 flex-none place-items-center rounded-lg text-white ${settings.filterOn ? 'bg-ink' : 'bg-[#cfd9de]'}`}
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block text-[13px] font-bold sm:text-[15px]">AnyFilter</span>
            <span className="block text-[10px] font-medium text-ink-2">{t('shell.nav.home')}</span>
          </span>
        </button>
        <nav className="ml-auto flex flex-none items-center gap-1" aria-label={t('shell.nav.views')}>
          {([
            { id: 'page', labelKey: 'page.nav' },
            { id: 'settings', labelKey: 'shell.nav.settings' },
            { id: 'verification', labelKey: 'shell.nav.verification' },
          ] as const).map(({ id, labelKey }) => (
            <button
              key={id}
              type="button"
              aria-label={t(labelKey)}
              aria-pressed={view === id}
              data-anyfilter-nav={id}
              onClick={() => onNavigate(id)}
              className={`min-h-9 rounded-lg border px-2.5 py-1.5 text-center text-[12px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${view === id ? 'border-ink bg-ink text-white' : 'border-transparent text-ink-2 hover:bg-surface hover:text-ink'}`}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>
        <label className="relative ml-1 inline-flex h-6 w-10.5 flex-none cursor-pointer items-center">
          <span className="sr-only">{t('shell.filterOn')}</span>
          <input
            type="checkbox"
            role="switch"
            className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
            checked={settings.filterOn}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span className="absolute inset-0 rounded-full bg-[#cfd9de] transition peer-checked:bg-ink" />
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-4.5" />
        </label>
      </div>
      {status !== '' && (
        <p
          role="status"
          className="mb-0 mt-2 text-xs text-ink-2"
        >
          {status}
        </p>
      )}
    </header>
  );
}
