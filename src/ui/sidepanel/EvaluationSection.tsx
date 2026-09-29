import { useCallback, useEffect, useState } from 'react';
import { formatMicro } from '../../domain/evaluation-budget';
import type { BatchHaltReason } from '../../domain/evaluation-batch';
import {
  LABELLER_IDS,
  LABELLER_SPECS,
  PRICING_CHECKED_ON,
  labelOfModel,
  modelsOf,
  type EvaluationConnections,
  type LabellerId,
} from '../../domain/evaluation-pricing';
import type { EvaluationOverview, EvaluationRunStatus } from '../../domain/evaluation-run';
import type { MachineLabellerId } from '../../domain/machine-label';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import { useLanguage, type Translate } from '../language';
import type { PanelGateway } from './PanelGateway';

const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50';
const SUBHEADING_CLASS = 'm-0 text-[12px] font-bold text-ink';
const MUTED_CLASS = 'text-xs text-ink-2';

/** Progress is only display; polling it never touches spending. Faster while a
 * batch runs, slow otherwise so a budget switched elsewhere shows up. */
const POLL_RUNNING_MS = 1000;
const POLL_IDLE_MS = 2500;

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

function ConnectionRow({
  labeller,
  connections,
  gateway,
  onConnections,
}: {
  labeller: MachineLabellerId;
  connections: EvaluationConnections;
  gateway: PanelGateway;
  onConnections: (next: EvaluationConnections) => void;
}) {
  const { t } = useLanguage();
  const saved = connections[labeller];
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [model, setModel] = useState(saved.model);
  const [invalid, setInvalid] = useState(false);
  const dirty = baseUrl.trim() !== saved.baseUrl || model !== saved.model;

  const store = (): void => {
    setInvalid(false);
    void gateway.setEvaluationConnection(labeller, baseUrl, model).then((result) => {
      if (result === null || !result.ok) {
        setInvalid(true);
        return;
      }
      onConnections(result.connections);
      setBaseUrl(result.connections[labeller].baseUrl);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pl-1" data-anyfilter-evaluation={`connection-${labeller}`}>
      <label className="flex items-center gap-1.5 text-xs text-ink-2">
        <span>{t('evaluation.connection.model')}</span>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="min-h-9 rounded-lg border border-line px-1.5 text-xs"
          data-anyfilter-evaluation="connection-model"
        >
          {modelsOf(labeller).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-ink-2">
        <span>{t('evaluation.connection.baseUrl')}</span>
        <input
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          data-anyfilter-evaluation="connection-url"
        />
      </label>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={!dirty}
        onClick={store}
        data-anyfilter-evaluation="connection-save"
      >
        {t('evaluation.connection.save')}
      </button>
      {invalid && (
        <span role="alert" className="w-full text-xs text-[#a32020]">
          {t('evaluation.connection.invalid')}
        </span>
      )}
    </div>
  );
}

function KeyRow({
  labeller,
  present,
  gateway,
  onPresence,
}: {
  labeller: MachineLabellerId;
  present: boolean;
  gateway: PanelGateway;
  onPresence: (keys: KeyPresence) => void;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const label = labeller === 'openai' ? t('evaluation.keys.openai') : t('evaluation.keys.deepseek');

  const store = (next: string): void => {
    setInvalid(false);
    void gateway.setEvaluationKey(labeller, next).then((result) => {
      if (result === null || !result.ok) {
        setInvalid(true);
        return;
      }
      setValue('');
      onPresence(result.keys);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-anyfilter-evaluation={`key-${labeller}`}>
      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-ink-2">
        <span className="w-24 shrink-0 font-semibold text-ink">{label}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={t('evaluation.keys.placeholder')}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        />
      </label>
      <span className={MUTED_CLASS} data-anyfilter-evaluation="key-state">
        {present ? t('evaluation.keys.set') : t('evaluation.keys.missing')}
      </span>
      <button type="button" className={BUTTON_CLASS} disabled={value.trim() === ''} onClick={() => store(value)}>
        {t('evaluation.keys.save')}
      </button>
      <button type="button" className={BUTTON_CLASS} disabled={!present} onClick={() => store('')}>
        {t('evaluation.keys.clear')}
      </button>
      {invalid && (
        <span role="alert" className="w-full text-xs text-[#a32020]">
          {t('evaluation.keys.invalid')}
        </span>
      )}
    </div>
  );
}

function RunRow({
  labeller,
  overview,
  keys,
  connections,
  status,
  gateway,
  onStarted,
}: {
  labeller: LabellerId;
  overview: EvaluationOverview;
  keys: KeyPresence;
  connections: EvaluationConnections;
  status: EvaluationRunStatus;
  gateway: PanelGateway;
  onStarted: (status: EvaluationRunStatus) => void;
}) {
  const { t } = useLanguage();
  const spec = { label: labeller === 'jev' ? LABELLER_SPECS.jev.label : labelOfModel(connections[labeller].model) };
  const [authorized, setAuthorized] = useState(false);
  const [refused, setRefused] = useState('');
  const tasks = overview.sampleCount * overview.ruleCount;
  const busy = status.running;
  const mine = status.labeller === labeller;
  const blocker = !overview.enabled
    ? t('evaluation.run.needBudget')
    : !keys[labeller]
      ? t('evaluation.run.needKey')
      : tasks === 0
        ? t('evaluation.noTasks')
        : '';

  const start = (): void => {
    setRefused('');
    void gateway.startEvaluationBatch(labeller).then((result) => {
      if (!result.ok) setRefused(result.detail);
      onStarted(result.status);
    });
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5"
      data-anyfilter-evaluation={`run-${labeller}`}
    >
      <label className="flex items-start gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={authorized}
          onChange={(event) => setAuthorized(event.target.checked)}
          className="mt-0.5"
        />
        <span>{t('evaluation.run.authorize', { label: spec.label })}</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={!authorized || busy || blocker !== ''}
          onClick={start}
          data-anyfilter-evaluation="start"
        >
          {t('evaluation.run.start', { label: spec.label })}
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
        {blocker !== '' && <span className={MUTED_CLASS}>{blocker}</span>}
      </div>
      {refused !== '' && (
        <p role="alert" className="m-0 text-xs text-[#a32020]">
          {t('evaluation.run.refused', { detail: refused })}
        </p>
      )}
      {mine && status.progress !== null && (
        <div role="status" className={MUTED_CLASS} data-anyfilter-evaluation="progress">
          <div>
            {busy
              ? t('evaluation.run.running', { label: spec.label })
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
    </div>
  );
}

/** Runs one labeller over the stored samples and exports what was recorded. It
 * never changes what the feed hides, and it never shows or reads back a key. */
export function EvaluationSection({ gateway }: { gateway: PanelGateway }) {
  const { t } = useLanguage();
  const [overview, setOverview] = useState<EvaluationOverview | null>(null);
  const [keys, setKeys] = useState<KeyPresence | null>(null);
  const [connections, setConnections] = useState<EvaluationConnections | null>(null);
  const [status, setStatus] = useState<EvaluationRunStatus | null>(null);
  const [budgetError, setBudgetError] = useState('');
  const [exportNote, setExportNote] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    const [nextOverview, nextKeys, nextStatus, nextConnections] = await Promise.all([
      gateway.loadEvaluationOverview(),
      gateway.loadKeyPresence(),
      gateway.loadEvaluationRunStatus(),
      gateway.loadEvaluationConnections(),
    ]);
    if (nextOverview) setOverview(nextOverview);
    if (nextKeys) setKeys(nextKeys);
    if (nextStatus) setStatus(nextStatus);
    if (nextConnections) setConnections(nextConnections);
  }, [gateway]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = status?.running === true;
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  const turnOn = (): void => {
    setBudgetError('');
    void gateway.enableVerificationBudget().then((result) => {
      if (!result.ok) setBudgetError(result.detail);
      void refresh();
    });
  };

  const save = (): void => {
    setExportNote('');
    void gateway.exportEvaluation().then((data) => {
      if (data === null) {
        setExportNote(t('evaluation.export.failed'));
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `anyfilter-evaluation-${data.exportedAt.replace(/[:.]/g, '-')}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNote(t('evaluation.export.saved', { samples: data.samples.length, results: data.results.length }));
    });
  };

  if (overview === null || keys === null || status === null || connections === null) {
    return (
      <section
        className="rounded-xl border border-line bg-white p-3.5"
        aria-label={t('evaluation.heading')}
        data-anyfilter-evaluation="section"
      >
        <h2 className="m-0 text-[13px] font-bold">{t('evaluation.heading')}</h2>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-line bg-white p-3.5"
      aria-label={t('evaluation.heading')}
      data-anyfilter-evaluation="section"
    >
      <div>
        <h2 className="m-0 text-[13px] font-bold">{t('evaluation.heading')}</h2>
        <p className={`${MUTED_CLASS} mb-0 mt-1`}>{t('evaluation.intro')}</p>
        <p className={`${MUTED_CLASS} mb-0 mt-1`} data-anyfilter-evaluation="size">
          {t('evaluation.size', {
            samples: overview.sampleCount,
            rules: overview.ruleCount,
            tasks: overview.sampleCount * overview.ruleCount,
          })}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className={SUBHEADING_CLASS}>{t('evaluation.budget.heading')}</h3>
        <p className={`${MUTED_CLASS} m-0`} data-anyfilter-evaluation="budget-state">
          {overview.enabled ? t('evaluation.budget.on') : overview.partial ? t('evaluation.budget.partial') : t('evaluation.budget.off')}
        </p>
        {!overview.enabled && (
          <div>
            <button type="button" className={BUTTON_CLASS} onClick={turnOn} data-anyfilter-evaluation="budget-on">
              {t('evaluation.budget.turnOn')}
            </button>
          </div>
        )}
        {budgetError !== '' && (
          <p role="alert" className="m-0 text-xs text-[#a32020]">
            {t('evaluation.budget.turnOnFailed', { detail: budgetError })}
          </p>
        )}
        <ul className="m-0 list-none p-0" data-anyfilter-evaluation="spend">
          {overview.spend.map((row) => (
            <li key={row.model} className={MUTED_CLASS}>
              {t('evaluation.budget.row', {
                label: labelOfModel(row.model),
                spent: formatMicro(row.spentMicro, row.currency),
                cap: row.capMicro === null ? '—' : formatMicro(row.capMicro, row.currency),
                held: formatMicro(row.reservedMicro, row.currency),
                settled: row.settledJobs,
                open: row.heldJobs,
              })}
            </li>
          ))}
        </ul>
        <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.budget.note', { checked: PRICING_CHECKED_ON })}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className={SUBHEADING_CLASS}>{t('evaluation.keys.heading')}</h3>
        <p className={`${MUTED_CLASS} m-0`}>
          {t('evaluation.keys.jev')} {keys.jev ? t('evaluation.keys.jevSet') : t('evaluation.keys.jevMissing')}
        </p>
        <KeyRow labeller="openai" present={keys.openai} gateway={gateway} onPresence={setKeys} />
        <ConnectionRow labeller="openai" connections={connections} gateway={gateway} onConnections={setConnections} />
        <KeyRow labeller="deepseek" present={keys.deepseek} gateway={gateway} onPresence={setKeys} />
        <ConnectionRow labeller="deepseek" connections={connections} gateway={gateway} onConnections={setConnections} />
        <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.keys.note')}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className={SUBHEADING_CLASS}>{t('evaluation.run.heading')}</h3>
        {LABELLER_IDS.map((labeller) => (
          <RunRow
            key={labeller}
            labeller={labeller}
            overview={overview}
            keys={keys}
            connections={connections}
            status={status}
            gateway={gateway}
            onStarted={(next) => {
              setStatus(next);
              void refresh();
            }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className={SUBHEADING_CLASS}>{t('evaluation.export.heading')}</h3>
        <div className="flex items-center gap-2">
          <button type="button" className={BUTTON_CLASS} onClick={save} data-anyfilter-evaluation="export">
            {t('evaluation.export.button')}
          </button>
          {exportNote !== '' && (
            <span role="status" className={MUTED_CLASS}>
              {exportNote}
            </span>
          )}
        </div>
        <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.export.note')}</p>
      </div>
    </section>
  );
}
