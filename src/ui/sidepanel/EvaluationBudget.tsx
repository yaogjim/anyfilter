import { formatMicro } from '../../domain/evaluation-budget';
import { PRICING_CHECKED_ON, labelOfModel } from '../../domain/evaluation-pricing';
import type { EvaluationOverview, LabellerSpend } from '../../domain/evaluation-run';
import { useLanguage } from '../language';

const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50';
const SUBHEADING_CLASS = 'm-0 text-[12px] font-bold text-ink';
const MUTED_CLASS = 'text-xs text-ink-2';

function percent(part: number, cap: number | null): number {
  if (cap === null || cap <= 0) return 0;
  return Math.max(0, Math.min(100, (part / cap) * 100));
}

/** One model: the existing text line, with a bar under it for spent and held. The
 * bar is decoration only; every number is in the text. */
function SpendRow({ row }: { row: LabellerSpend }) {
  const { t } = useLanguage();
  const spent = percent(row.spentMicro, row.capMicro);
  const held = Math.min(percent(row.reservedMicro, row.capMicro), 100 - spent);
  return (
    <li className="flex flex-col gap-1">
      <span className={MUTED_CLASS}>
        {t('evaluation.budget.row', {
          label: labelOfModel(row.model),
          spent: formatMicro(row.spentMicro, row.currency),
          cap: row.capMicro === null ? '—' : formatMicro(row.capMicro, row.currency),
          held: formatMicro(row.reservedMicro, row.currency),
          settled: row.settledJobs,
          open: row.heldJobs,
        })}
      </span>
      <span aria-hidden="true" className="flex h-1.5 overflow-hidden rounded-full bg-surface">
        <span className="h-full bg-ink" style={{ width: `${spent}%` }} />
        <span className="h-full bg-[#cfd9de]" style={{ width: `${held}%` }} />
      </span>
    </li>
  );
}

/** The local spending picture per model, and the one switch that turns it on. */
export function EvaluationBudget({
  overview,
  budgetError,
  onTurnOn,
}: {
  overview: EvaluationOverview;
  budgetError: string;
  onTurnOn: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className={SUBHEADING_CLASS}>{t('evaluation.budget.heading')}</h3>
      <p className={`${MUTED_CLASS} m-0`} data-anyfilter-evaluation="budget-state">
        {overview.enabled ? t('evaluation.budget.on') : overview.partial ? t('evaluation.budget.partial') : t('evaluation.budget.off')}
      </p>
      {!overview.enabled && (
        <div>
          <button type="button" className={BUTTON_CLASS} onClick={onTurnOn} data-anyfilter-evaluation="budget-on">
            {t('evaluation.budget.turnOn')}
          </button>
        </div>
      )}
      {budgetError !== '' && (
        <p role="alert" className="m-0 text-xs text-[#a32020]">
          {t('evaluation.budget.turnOnFailed', { detail: budgetError })}
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-anyfilter-evaluation="spend">
        {overview.spend.map((row) => (
          <SpendRow key={row.model} row={row} />
        ))}
      </ul>
      <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.budget.note', { checked: PRICING_CHECKED_ON })}</p>
    </div>
  );
}
