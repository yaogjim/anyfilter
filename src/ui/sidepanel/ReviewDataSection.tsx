import { useEffect, useState } from 'react';
import { useLanguage } from '../language';
import type { PanelGateway } from './PanelGateway';

/** Count of stored review labels and one button that deletes all of them. It
 * touches nothing else: samples, rules, settings and keys stay. */
export function ReviewDataSection({ gateway }: { gateway: PanelGateway }) {
  const { t } = useLanguage();
  const [count, setCount] = useState(0);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void gateway.loadReviewCount().then((next) => active && setCount(next), () => undefined);
    };
    refresh();
    const stop = gateway.onReviewCountChanged(refresh);
    return () => {
      active = false;
      stop();
    };
  }, [gateway]);

  const clear = (): void => {
    setBusy(true);
    setDone(false);
    void gateway
      .clearReviewRecords()
      .then(() => setDone(true))
      .finally(() => setBusy(false));
  };

  const exportFile = (): void => {
    void gateway.exportReviewRecords().then((records) => {
      const body = {
        kind: 'anyfilter-review-labels',
        version: 1,
        source: 'in-timeline-assisted',
        exportedAt: new Date().toISOString(),
        records,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `anyfilter-review-labels-${body.exportedAt.replace(/[-:.]/g, '').slice(0, 15)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <section
      className="rounded-xl border border-line bg-white p-3.5"
      aria-label={t('review.data.heading')}
      data-anyfilter-review="data"
    >
      <h2 className="m-0 text-[13px] font-bold">{t('review.data.heading')}</h2>
      <p className="mb-0 mt-1 text-xs text-ink-2" data-anyfilter-review="count">
        {t('review.data.count', { count })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || count === 0}
          onClick={exportFile}
          data-anyfilter-review="export"
          title={t('review.data.exportHint')}
          className="min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50"
        >
          {t('review.data.export')}
        </button>
        <button
          type="button"
          disabled={busy || count === 0}
          onClick={clear}
          data-anyfilter-review="delete-all"
          className="min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50"
        >
          {t('review.data.deleteAll')}
        </button>
        {done && <span role="status" className="text-xs text-ink-2">{t('review.data.deleted')}</span>}
      </div>
    </section>
  );
}
