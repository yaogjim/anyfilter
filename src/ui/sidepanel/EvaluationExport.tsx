import { useState } from 'react';
import { useLanguage } from '../language';
import type { PanelGateway } from './PanelGateway';

const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50';
const MUTED_CLASS = 'text-xs text-ink-2';

/** Saves the recorded answers as a file the person keeps by hand. The file holds
 * post text and no key. */
export function EvaluationExport({ gateway }: { gateway: PanelGateway }) {
  const { t } = useLanguage();
  const [note, setNote] = useState('');

  const save = (): void => {
    setNote('');
    void gateway.exportEvaluation().then((data) => {
      if (data === null) {
        setNote(t('evaluation.export.failed'));
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
      setNote(t('evaluation.export.saved', { samples: data.samples.length, results: data.results.length }));
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[12px] font-bold text-ink">{t('evaluation.export.heading')}</h3>
      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON_CLASS} onClick={save} data-anyfilter-evaluation="export">
          {t('evaluation.export.button')}
        </button>
        {note !== '' && (
          <span role="status" className={MUTED_CLASS}>
            {note}
          </span>
        )}
      </div>
      <p className={`${MUTED_CLASS} m-0`}>{t('evaluation.export.note')}</p>
    </div>
  );
}
