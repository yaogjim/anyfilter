import { useId } from 'react';
import { useLanguage } from '../language';

/** Turns review mode on or off for every X page. The state is one stored setting,
 * so it needs no open tab and a new page opens in the same state. `scope` tells
 * the two places this switch appears apart: `home` is one compact row, and
 * `settings` is a row that sits inside the filtering card.
 *
 * Both are a plain `button` with `aria-pressed`, never `role="switch"`: the page
 * tests look up the header's filter switch by that role, and a second one would
 * make the lookup ambiguous. The settings row only looks like a switch. */
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
  const headingId = useId();

  if (scope === 'settings') {
    return (
      <div
        role="group"
        aria-labelledby={headingId}
        data-anyfilter-review="settings-section"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 id={headingId} className="m-0 text-[13px] font-bold text-ink">
            {t('review.panel.heading')}
          </h3>
          <button
            type="button"
            aria-pressed={on}
            aria-label={t('review.panel.heading')}
            data-anyfilter-review="setting-toggle"
            onClick={() => onChange(!on)}
            className="flex min-h-9 flex-none items-center gap-2 rounded-lg px-1.5 text-[12px] font-semibold text-ink-2 transition hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <span className={on ? 'text-ink' : ''}>
              {t(on ? 'settings.reviewOn' : 'settings.reviewOff')}
            </span>
            <span
              aria-hidden="true"
              className={`relative h-5 w-9 flex-none rounded-full transition ${on ? 'bg-ink' : 'bg-[#cfd9de]'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-4' : ''}`}
              />
            </span>
          </button>
        </div>
        <p className="mb-0 mt-1 text-[11px] text-ink-2">
          {t(on ? 'review.panel.descriptionOn' : 'review.panel.descriptionOff')}
        </p>
      </div>
    );
  }

  // The home row: a heading and the same switch look, on one line. The longer
  // description is announced with the button instead of taking a second line.
  return (
    <section
      className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-3.5 py-1"
      aria-label={t('review.panel.heading')}
      data-anyfilter-review="section"
    >
      <h2 className="m-0 text-[13px] font-bold">{t('review.panel.heading')}</h2>
      <span id={headingId} className="sr-only">
        {t(on ? 'review.panel.descriptionOn' : 'review.panel.descriptionOff')}
      </span>
      <button
        type="button"
        aria-pressed={on}
        aria-label={t('review.panel.heading')}
        aria-describedby={headingId}
        title={t(on ? 'review.panel.turnOff' : 'review.panel.turnOn')}
        data-anyfilter-review="toggle"
        onClick={() => onChange(!on)}
        className="flex min-h-9 flex-none items-center gap-2 rounded-lg px-1.5 text-[12px] font-semibold text-ink-2 transition hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span className={on ? 'text-ink' : ''}>{t(on ? 'settings.reviewOn' : 'settings.reviewOff')}</span>
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 flex-none rounded-full transition ${on ? 'bg-ink' : 'bg-[#cfd9de]'}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-4' : ''}`}
          />
        </span>
      </button>
    </section>
  );
}
