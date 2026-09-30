import {
  costOf,
  hiddenCount,
  scannedCount,
  secondsSaved,
  type PanelState,
} from '../../domain/panel-state';
import { useLanguage } from '../language';
import { formatDuration } from './format-duration';
import { useCombo } from './use-combo';
import { useCountUp } from './use-count-up';

function Tile({
  label,
  value,
  format,
  tone,
  bump = false,
}: {
  label: string;
  value: number;
  format: (value: number) => string;
  tone?: 'hide' | 'keep';
  bump?: boolean;
}) {
  const displayed = useCountUp(value);
  const combo = useCombo(value);
  const toneClass = tone === 'hide' ? 'text-hide' : tone === 'keep' ? 'text-keep' : '';
  const bumping = bump && combo.count > 0;
  const comboScale = Math.min(1 + (combo.count - 1) * 0.12, 1.8);
  return (
    <div className="flex min-h-16 flex-col justify-end rounded-lg bg-surface px-2.5 py-2">
      <div className="text-[11px] text-ink-2">{label}</div>
      <div className="relative inline-block self-start">
        <span
          key={bumping ? combo.hit : 0}
          className={`whitespace-nowrap text-[26px] font-extrabold leading-tight tracking-tight tabular-nums ${toneClass} ${bumping ? 'anyfilter-bump origin-left' : ''}`}
        >
          {format(displayed)}
        </span>
        {bumping && (
          <span
            className="absolute -top-2 left-full ml-1 origin-bottom-left"
            style={{ transform: `scale(${comboScale})` }}
          >
            <span
              key={combo.hit}
              className="anyfilter-pop block rounded-full bg-hide px-1.5 text-[11px] font-bold leading-4 text-white"
            >
              +{combo.count}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

const asInt = (value: number): string => String(Math.round(value));
const asCompact = (value: number): string => {
  const rounded = Math.round(value);
  if (rounded < 10_000) return String(rounded);
  if (rounded < 1_000_000) return `${(rounded / 1_000).toFixed(rounded < 100_000 ? 1 : 0)}K`;
  return `${(rounded / 1_000_000).toFixed(rounded < 10_000_000 ? 2 : 1)}M`;
};
const asDollars = (value: number): string =>
  value > 0 && value < 0.001 ? '<$0.001' : `$${value.toFixed(3)}`;

/** A figure that matters less than the three above: label and value on one line
 * of the summary row, still counting up like the big ones. */
function MiniStat({ id, label, value, format }: { id: string; label: string; value: number; format: (value: number) => string }) {
  const displayed = useCountUp(value);
  return (
    <span className="whitespace-nowrap" data-anyfilter-stat={id}>
      {label} <b className="font-semibold tabular-nums text-ink">{format(displayed)}</b>
    </span>
  );
}

export function Tiles({ state }: { state: PanelState }) {
  const { t } = useLanguage();
  const hidden = hiddenCount(state);
  const scanned = scannedCount(state);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        <Tile label={t('shell.tiles.hidden')} value={hidden} format={asInt} tone="hide" bump />
        <Tile label={t('shell.tiles.kept')} value={scanned - hidden} format={asInt} tone="keep" />
        <Tile label={t('shell.tiles.scanned')} value={scanned} format={asInt} />
      </div>
      <div
        role="group"
        className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 px-0.5 text-[11px] text-ink-2"
        aria-label={t('shell.tiles.more')}
        data-anyfilter-stat="secondary"
      >
        <MiniStat id="timeSaved" label={t('shell.tiles.timeSaved')} value={secondsSaved(state)} format={formatDuration} />
        <MiniStat id="spent" label={t('shell.tiles.spent')} value={costOf(state)} format={asDollars} />
        <MiniStat id="tokens" label={t('shell.tiles.tokens')} value={state.tokens} format={asCompact} />
      </div>
    </div>
  );
}
