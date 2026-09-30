import { useState } from 'react';
import type { BatchHaltReason } from '../../domain/evaluation-batch';
import {
  LABELLER_IDS,
  LABELLER_SPECS,
  labelOfModel,
  type EvaluationConnections,
  type LabellerId,
} from '../../domain/evaluation-pricing';
import type { EvaluationOverview, EvaluationRunStatus } from '../../domain/evaluation-run';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import { useLanguage, type Translate } from '../language';
import type { PanelGateway } from './PanelGateway';

const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50';
const SUBHEADING_CLASS = 'm-0 text-[12px] font-bold text-ink';
const MUTED_CLASS = 'text-xs text-ink-2';

function haltLabel(reason: BatchHaltReason, t: Translate): string {
  switch (reason) {
    case 'budget':
      return t('evaluation.run.halt.budget');
    case 'key':
      return t('evaluation.run.halt.key');
    case 'storage':
      return t('evaluation.run.halt.storage');
    case 'stopped':
      return t('evaluation.run.halt.stopped');
    case 'failures':
      return t('evaluation.run.halt.failures');
    case 'ceiling':
      return t('evaluation.run.halt.ceiling');
    case 'inactive':
      return t('evaluation.run.halt.inactive');
  }
}

function RunRow({
  labeller,
  globalBlocked,
  keys,
  connections,
  status,
  gateway,
  onStarted,
}: {
  labeller: LabellerId;
  /** The budget is off or there is nothing to send: said once above the table. */
  globalBlocked: boolean;
  keys: KeyPresence;
  connections: EvaluationConnections;
  status: EvaluationRunStatus;
  gateway: PanelGateway;
  onStarted: (status: EvaluationRunStatus) => void;
}) {
  const { t } = useLanguage();
  const label = labeller === 'jev' ? LABELLER_SPECS.jev.label : labelOfModel(connections[labeller].model);
  const [authorized, setAuthorized] = useState(false);
  const [refused, setRefused] = useState('');
  const busy = status.running;
  const mine = status.labeller === labeller;
  const keyMissing = !keys[labeller];

  const start = (): void => {
    setRefused('');
    void gateway.startEvaluationBatch(labeller).then((result) => {
      if (!result.ok) setRefused(result.detail);
      onStarted(result.status);
    });
  };

  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5"
      data-anyfilter-evaluation={`run-${labeller}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-[13px] font-semibold text-ink">{label}</span>
        <span
          className={`text-xs ${keyMissing ? 'font-semibold text-[#a32020]' : 'text-ink-2'}`}
          data-anyfilter-evaluation={`summary-${labeller}`}
        >
          {t('evaluation.run.keyState', {
            state: keyMissing ? t('evaluation.keys.missing') : t('evaluation.keys.set'),
          })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex items-center gap-1.5 text-xs text-ink-2" title={t('evaluation.run.authorize', { label })}>
          <input
            type="checkbox"
            checked={authorized}
            onChange={(event) => setAuthorized(event.target.checked)}
            aria-label={t('evaluation.run.authorize', { label })}
          />
          <span>{t('evaluation.run.authorizeShort')}</span>
        </label>
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={!authorized || busy || globalBlocked || keyMissing}
          onClick={start}
          data-anyfilter-evaluation="start"
        >
          {t('evaluation.run.start', { label })}
        </button>
        {mine && busy && (
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={() => void gateway.stopEvaluationBatch().then((next) => next && onStarted(next))}
            data-anyfilter-evaluation="stop"
          >
            {t('evaluation.run.stop')}
          </button>
        )}
        {keyMissing && <span className={MUTED_CLASS}>{t('evaluation.run.needKey')}</span>}
      </div>
      {refused !== '' && (
        <p role="alert" className="m-0 text-xs text-[#a32020]">
          {t('evaluation.run.refused', { detail: refused })}
        </p>
      )}
      {mine && status.progress !== null && (
        <div role="status" className={`${MUTED_CLASS} border-t border-line pt-1.5`} data-anyfilter-evaluation="progress">
          <div>
            {busy
              ? t('evaluation.run.running', { label })
              : status.progress.halted !== null
                ? haltLabel(status.progress.halted, t)
                : t('evaluation.run.done')}
          </div>
          <div>
            {t('evaluation.run.progress', {
              started: status.progress.started,
              total: status.progress.total,
              recorded: status.progress.recorded,
              repeats: status.progress.repeats,
              skipped: status.progress.skipped,
              failed: status.progress.failed,
            })}
          </div>
          {!busy && status.progress.haltDetail !== '' && (
            <div>{t('evaluation.run.detail', { detail: status.progress.haltDetail })}</div>
          )}
        </div>
      )}
    </li>
  );
}

/** One row per labeller: its model, whether a key is stored, the authorization
 * tick and the run control. The authorization wording is stated once above the
 * rows; a reason that blocks every row (budget off, nothing to send) is also said
 * once, so a row only ever says what is specific to it. */
export function EvaluationRunTable({
  overview,
  keys,
  connections,
  status,
  gateway,
  onStarted,
  onOpenSettings,
}: {
  overview: EvaluationOverview;
  keys: KeyPresence;
  connections: EvaluationConnections;
  status: EvaluationRunStatus;
  gateway: PanelGateway;
  onStarted: (status: EvaluationRunStatus) => void;
  /** Opens the settings view at the models section, where keys are set. */
  onOpenSettings?: () => void;
}) {
  const { t } = useLanguage();
  const tasks = overview.sampleCount * overview.ruleCount;
  const globalBlocker = !overview.enabled
    ? t('evaluation.run.needBudget')
    : tasks === 0
      ? t('evaluation.noTasks')
      : '';

  return (
    <div className="flex flex-col gap-1.5" data-anyfilter-evaluation="runs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={SUBHEADING_CLASS}>{t('evaluation.run.heading')}</h3>
        {onOpenSettings !== undefined && (
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={onOpenSettings}
            data-anyfilter-evaluation="open-settings"
          >
            {t('evaluation.keys.goSettings')}
          </button>
        )}
      </div>
      <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.run.authorizeNote')}</p>
      {globalBlocker !== '' && (
        <p className={`${MUTED_CLASS} m-0 font-semibold`} data-anyfilter-evaluation="blocker">
          {globalBlocker}
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {LABELLER_IDS.map((labeller) => (
          <RunRow
            key={labeller}
            labeller={labeller}
            globalBlocked={globalBlocker !== ''}
            keys={keys}
            connections={connections}
            status={status}
            gateway={gateway}
            onStarted={onStarted}
          />
        ))}
      </ul>
      <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.keys.summaryNote')}</p>
    </div>
  );
}
