import { useState } from 'react';
import { useLanguage } from '../language';
import { EvaluationBudget } from './EvaluationBudget';
import { EvaluationExport } from './EvaluationExport';
import { EvaluationRunTable } from './EvaluationRunTable';
import type { PanelGateway } from './PanelGateway';
import type { EvaluationData } from './use-evaluation-data';

const MUTED_CLASS = 'text-xs text-ink-2';

/** Runs one labeller over the stored samples and exports what was recorded. It
 * never changes what the feed hides, and it never shows or reads back a key. The
 * data comes from the verification view, which also feeds its status strip. */
export function EvaluationSection({
  gateway,
  data,
  onOpenSettings,
}: {
  gateway: PanelGateway;
  data: EvaluationData;
  /** Opens the settings view at the models section, where keys are set. */
  onOpenSettings?: () => void;
}) {
  const { t } = useLanguage();
  const { overview, keys, connections, status, refresh, setStatus } = data;
  const [budgetError, setBudgetError] = useState('');

  const turnOn = (): void => {
    setBudgetError('');
    void gateway.enableVerificationBudget().then((result) => {
      if (!result.ok) setBudgetError(result.detail);
      void refresh();
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

      <EvaluationBudget overview={overview} budgetError={budgetError} onTurnOn={turnOn} />

      <EvaluationRunTable
        overview={overview}
        keys={keys}
        connections={connections}
        status={status}
        gateway={gateway}
        onStarted={(next) => {
          setStatus(next);
          void refresh();
        }}
        onOpenSettings={onOpenSettings}
      />

      <EvaluationExport gateway={gateway} />
    </section>
  );
}
