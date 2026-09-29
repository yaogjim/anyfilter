import { useLanguage } from '../language';

/** Turns review mode on or off for every X page. The state is one stored setting,
 * so it needs no open tab and a new page opens in the same state. `scope` only
 * tells the two places this switch appears (home and settings) apart. */
export function ReviewSwitch({
  on,
  onChange,
  scope,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  scope: 'home' | 'settings';
}) {
  const { t } = useLanguage();
  return (
    <section
      className="rounded-xl border border-line bg-white p-3.5"
      aria-label={t('review.panel.heading')}
      data-anyfilter-review={scope === 'home' ? 'section' : 'settings-section'}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[13px] font-bold">{t('review.panel.heading')}</h2>
        <button
          type="button"
          aria-pressed={on}
          data-anyfilter-review={scope === 'home' ? 'toggle' : 'setting-toggle'}
          onClick={() => onChange(!on)}
          className={`min-h-9 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${on ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:bg-surface hover:text-ink'}`}
        >
          {on ? t('review.panel.turnOff') : t('review.panel.turnOn')}
        </button>
      </div>
      <p className="mb-0 mt-2 text-xs text-ink-2">{t(on ? 'review.panel.descriptionOn' : 'review.panel.descriptionOff')}</p>
    </section>
  );
}
