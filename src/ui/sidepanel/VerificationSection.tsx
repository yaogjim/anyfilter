import { useCallback, useEffect, useState } from 'react';
import type { CapturePage } from '../../domain/capture';
import { formatMicro } from '../../domain/evaluation-budget';
import {
  enabledSemanticRuleOptions,
  isVerificationCandidates,
  verificationDetailFlags,
  type VerificationBudgetStatus,
  type VerificationCandidate,
  type VerificationDetailResult,
  type VerificationRunResult,
} from '../../domain/evaluation-verification';
import type { Settings } from '../../domain/settings';
import { useLanguage, type Translate } from '../language';
import type { PanelGateway } from './PanelGateway';
import { useSubscribedValue } from './use-subscribed-value';

const SUBHEADING_CLASS = 'mb-2 text-[15px] font-bold text-ink';
const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold transition hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white';
const MUTED_CLASS = 'text-ink-2';

/** Bounded page size: the sample list is paginated so the DOM never renders all 300. */
const PAGE_SIZE = 10;
/** Every source filter the list offers, "all" first. */
const SOURCE_FILTERS: ReadonlyArray<'all' | CapturePage> = ['all', 'home', 'search', 'status'];

/** Short, non-URL source label shown on one list row. The full URL stays in the detail pane. */
function sourceLabel(page: CapturePage, t: Translate): string {
  switch (page) {
    case 'home':
      return t('verification.source.home');
    case 'search':
      return t('verification.source.search');
    case 'status':
      return t('verification.source.status');
    default:
      return page;
  }
}

/** A short relative age for one row, so no timestamp or URL ever fills the row. */
function relativeTime(at: number, t: Translate): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return t('verification.time.justNow');
  if (minutes < 60) return t('verification.time.minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('verification.time.hoursAgo', { hours });
  const days = Math.floor(hours / 24);
  return t('verification.time.daysAgo', { days });
}

/** Why one send was skipped, localized. The reason codes themselves are domain values. */
function skipLabel(reason: string, t: Translate): string {
  switch (reason) {
    case 'not-authorized':
      return t('verification.skip.notAuthorized');
    case 'no-key':
      return t('verification.skip.noKey');
    case 'sample-not-found':
      return t('verification.skip.sampleNotFound');
    case 'not-sendable':
      return t('verification.skip.notSendable');
    case 'rule-not-compiled':
      return t('verification.skip.ruleNotCompiled');
    case 'budget-disabled':
      return t('verification.skip.budgetDisabled');
    case 'cap-exceeded':
      return t('verification.skip.capExceeded');
    case 'budget-refused':
      return t('verification.skip.budgetRefused');
    case 'already-recorded':
      return t('verification.skip.alreadyRecorded');
    case 'job-inactive':
      return t('verification.skip.jobInactive');
    case 'storage':
      return t('verification.skip.storage');
    case 'wrong-sender':
      return t('verification.skip.wrongSender');
    default:
      return reason;
  }
}

function money(micro: number | null, currency: string): string {
  return micro === null ? '—' : formatMicro(micro, currency);
}

function statusLine(status: VerificationBudgetStatus, t: Translate): string {
  if (!status.enabled) {
    // A stop refuses new requests but never refunds an unknown reservation: a
    // request that was already sent may already have been charged. Say so instead
    // of showing a tidy zero.
    const held =
      status.reservedMicro > 0
        ? t('verification.status.disabledHeld', {
            amount: money(status.reservedMicro, status.currency),
          })
        : '';
    return t('verification.status.disabled') + held;
  }
  return [
    t('verification.status.onForModel', { model: status.model }),
    t('verification.status.cap', { amount: money(status.capMicro, status.currency) }),
    t('verification.status.spent', { amount: money(status.spentMicro, status.currency) }),
    t('verification.status.held', { amount: money(status.reservedMicro, status.currency) }),
    t('verification.status.available', { amount: money(status.availableMicro, status.currency) }),
  ].join(' · ');
}

function resultText(result: VerificationRunResult, t: Translate): string {
  switch (result.kind) {
    case 'match':
      return t('verification.result.match', {
        score: result.score.toFixed(3),
        threshold: result.trace.threshold.toFixed(3),
      });
    case 'no-match':
      return t('verification.result.noMatch', {
        score: result.score.toFixed(3),
        threshold: result.trace.threshold.toFixed(3),
      });
    case 'undecided':
      return t('verification.result.undecided', { detail: result.detail });
    case 'unknown':
      return t('verification.result.unknown', { detail: result.detail });
    case 'skipped':
      return t('verification.result.skipped', {
        reason: skipLabel(result.reason, t),
        detail: result.detail,
      });
  }
}

/**
 * The budget/cost/safety lines of the confirm area. Each line is a resource
 * template (English and Chinese), so the warnings read identically in both
 * locales: the cap is a local estimate and not a provider-enforced hard cap, a
 * real request cannot be recalled or refunded, and an unknown charge stays held
 * rather than being guessed.
 */
function disclosureLines(status: VerificationBudgetStatus, t: Translate): readonly string[] {
  const cap = status.capMicro === null ? 'USD 1' : formatMicro(status.capMicro, status.currency);
  return [
    t('verification.disclosure.model', { model: status.model }),
    t('verification.disclosure.cap', { cap }),
    t('verification.disclosure.charge'),
    t('verification.disclosure.thirdParty'),
    t('verification.disclosure.score'),
    t('verification.disclosure.unknownUsage'),
  ];
}

/** Localized text of one exact-text warning, keyed by the domain flag key. An
 * unknown key falls back to the domain's own text rather than inventing one. */
function flagText(flag: { readonly key: string; readonly text: string }, t: Translate): string {
  switch (flag.key) {
    case 'exact-state':
      return t('verification.flag.exactState');
    case 'truncated':
      return t('verification.flag.truncated');
    case 'excerpt-mismatch':
      return t('verification.flag.excerptMismatch');
    case 'third-party':
      return t('verification.flag.thirdParty');
    default:
      return flag.text;
  }
}

/** Localized message for a refused preview read; the reason code is a domain value. */
function previewRefusalText(reason: string, fallback: string, t: Translate): string {
  switch (reason) {
    case 'wrong-sender':
      return t('verification.previewRefusal.wrongSender');
    case 'sample-not-found':
      return t('verification.previewRefusal.sampleNotFound');
    case 'unreadable':
      return t('verification.previewRefusal.unreadable');
    default:
      return fallback;
  }
}

/**
 * The manual, single-sample verification entry point, shown only on the trusted
 * side panel.
 *
 * It offers no way to configure a price, an endpoint, a model or a key: it names
 * one stored sample and one enabled semantic rule, and nothing else travels to the
 * background. Nothing here loops over samples or sends on its own. A call happens
 * only on the click of one button, only after the disclosure below, and only after
 * the user ticks that this one post may be sent.
 *
 * Sample management is deliberately list-first: a bounded, paginated list with a
 * search box and a source filter, short two-line previews and short source/time
 * tags. The full, exact stored text — the only thing a send may carry — is shown
 * for one selected sample in the detail pane, never as a truncated row.
 *
 * The send button is additionally held shut until this one sample's *exact* stored
 * text has been read back and shown — the full body plus any quoted or parent
 * text, with the flags that say when that text cannot be trusted on its own. A
 * short excerpt cannot support a confirmation that a whole third-party post may
 * leave the browser, so the user is never asked to confirm text they cannot see.
 * The read is local and read-only; it never logs and never reaches the network.
 */
export function VerificationSection({
  gateway,
  settings,
}: {
  gateway: PanelGateway;
  settings: Settings;
}) {
  const { t } = useLanguage();
  const capture = useSubscribedValue(gateway.loadCaptureState, gateway.onCaptureStateChanged);

  const [candidates, setCandidates] = useState<VerificationCandidate[]>([]);
  const [sampleQuery, setSampleQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | CapturePage>('all');
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<VerificationBudgetStatus | null>(null);
  const [sampleId, setSampleId] = useState('');
  // Narrow-layout only: whether the detail pane covers the list. On wide layouts
  // both panes are always visible, so this is ignored there.
  const [detailOpen, setDetailOpen] = useState(false);
  const [ruleId, setRuleId] = useState('');
  const [detail, setDetail] = useState<VerificationDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{ sampleId: string; run: VerificationRunResult } | null>(null);

  const reloadStatus = useCallback(async (): Promise<void> => {
    setStatus(await gateway.loadVerificationStatus());
  }, [gateway]);

  const reloadCandidates = useCallback(async (): Promise<void> => {
    const next = await gateway.loadVerificationCandidates();
    setCandidates(isVerificationCandidates(next) ? next : []);
  }, [gateway]);

  useEffect(() => {
    void reloadStatus();
    void reloadCandidates();
  }, [reloadStatus, reloadCandidates]);

  // The stored sample set can change under us (a delete, an expiry, a restore).
  // Re-read it whenever the capture state moves, so a deleted sample cannot stay
  // selected and a newly stored one becomes offerable.
  const captureStamp = capture.status === 'ready' ? capture.value.updatedAt : 0;
  useEffect(() => {
    if (captureStamp === 0) return;
    void reloadCandidates();
  }, [captureStamp, reloadCandidates]);

  const options = enabledSemanticRuleOptions(settings);
  // Newest first, then the search box and the source filter, then one bounded page.
  const filteredCandidates = [...candidates]
    .reverse()
    .filter((candidate) => {
      if (sourceFilter !== 'all' && candidate.page !== sourceFilter) return false;
      const query = sampleQuery.trim().toLocaleLowerCase();
      if (query === '') return true;
      return `${candidate.excerpt} ${sourceLabel(candidate.page, t)} ${candidate.pageUrl}`
        .toLocaleLowerCase()
        .includes(query);
    });
  const pageCount = Math.max(1, Math.ceil(filteredCandidates.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedCandidates = filteredCandidates.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );
  const filteredKey = filteredCandidates.map((candidate) => candidate.sampleId).join('|');
  const pageKey = pagedCandidates.map((candidate) => candidate.sampleId).join('|');
  const selected = candidates.find((candidate) => candidate.sampleId === sampleId) ?? null;
  const applicable = options.filter(
    (option) => option.scope === 'all' || (selected?.hasParent ?? false),
  );
  const applicableIds = applicable.map((option) => option.id).join(',');
  const optionIds = options.map((option) => option.id).join(',');

  // A filter or a page move can push the selected sample out of sight. If the
  // filter hides it entirely, drop the selection and everything read for it, so a
  // hidden sample can never stay armed. If it is merely on another page, keep it
  // visible but drop the send authorization, so it must be re-confirmed before a
  // send. The checkbox is cleared in both cases.
  useEffect(() => {
    if (sampleId === '') return;
    if (filteredKey.split('|').includes(sampleId)) return;
    setSampleId('');
    setConfirmed(false);
    setDetail(null);
    setResult(null);
    setDetailOpen(false);
  }, [filteredKey, sampleId]);

  useEffect(() => {
    if (sampleId === '') return;
    if (pageKey.split('|').includes(sampleId)) return;
    setConfirmed(false);
  }, [pageKey, sampleId]);

  // Any change to the query or the source filter starts the list over at page 1.
  useEffect(() => {
    setPage(0);
  }, [sampleQuery, sourceFilter]);

  // Keep the page inside the bounds when the filtered set shrinks (a delete).
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  // The exact stored text is read only for the selected sample, only through the
  // trusted gateway, and only locally. Nothing may be sent until that read has
  // finished and returned a complete body: a person has to be able to inspect the
  // whole post before confirming that it may leave the browser. The cleanup marks
  // an older read as stale, so switching samples quickly cannot show one sample's
  // text under another's id.
  useEffect(() => {
    if (sampleId === '') {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    void gateway
      .loadVerificationSampleDetail(sampleId)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setDetailLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDetail({ ok: false, reason: 'unreadable', message: 'the preview could not be loaded' });
        setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gateway, sampleId]);

  useEffect(() => {
    if (applicableIds.split(',').includes(ruleId)) return;
    setRuleId('');
  }, [applicableIds, ruleId]);

  useEffect(() => {
    if (optionIds === '' || optionIds.split(',').includes(ruleId)) return;
    setRuleId('');
  }, [optionIds, ruleId]);

  const disclosure = status === null ? [] : disclosureLines(status, t);
  const detailReady = detail?.ok === true;
  // A verdict is only ever shown for a sample the library still holds, so a call
  // that finished after the user deleted the sample cannot leave its result on
  // screen.
  const visibleResult =
    result !== null && candidates.some((candidate) => candidate.sampleId === result.sampleId)
      ? result.run
      : null;
  const canSend =
    !busy &&
    !detailLoading &&
    detailReady &&
    status?.enabled === true &&
    selected !== null &&
    ruleId !== '' &&
    applicableIds.split(',').includes(ruleId) &&
    confirmed;

  const onEnable = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      const outcome = await gateway.enableVerificationBudget();
      setStatus(outcome.status);
      setMessage(
        outcome.ok
          ? t('verification.message.enabled')
          : outcome.detail,
      );
    } finally {
      setBusy(false);
    }
  };

  const onStop = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      const outcome = await gateway.disableVerificationBudget();
      setStatus(outcome.status);
      // A stop refuses new requests; the confirmation is dropped so switching the
      // budget back on cannot immediately re-enable a send the user stopped.
      if (outcome.ok) setConfirmed(false);
      setMessage(
        outcome.ok
          ? t('verification.message.stopped')
          : outcome.detail,
      );
    } finally {
      setBusy(false);
    }
  };

  const onRun = async (): Promise<void> => {
    if (!canSend || selected === null || ruleId === '') return;
    setBusy(true);
    setMessage('');
    setResult(null);
    try {
      const outcome = await gateway.runVerificationSample(selected.sampleId, ruleId);
      setResult({ sampleId: selected.sampleId, run: outcome });
      setConfirmed(false);
      await reloadStatus();
      await reloadCandidates();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-line bg-white p-3.5"
      data-anyfilter-verification="section"
    >
      <h2 className={SUBHEADING_CLASS}>{t('verification.heading')}</h2>

      <div className="rounded-lg border border-line bg-surface p-2.5">
        <p className={`m-0 text-[13px] ${MUTED_CLASS}`} data-anyfilter-verification="status">
          {status === null ? t('verification.loading') : statusLine(status, t)}
        </p>
        <p className="m-0 mt-2 text-[11px] leading-relaxed text-ink-2">
          {t('verification.budgetNote')}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON_CLASS}
            data-anyfilter-verification="enable"
            disabled={busy || status?.enabled === true}
            onClick={() => void onEnable()}
          >
            {status?.enabled === true
              ? t('verification.budgetOn')
              : t('verification.enableBudget')}
          </button>
          {/* The manual stop stays usable even while a run is in flight: a person
              must always be able to refuse new requests. */}
          <button
            type="button"
            className={BUTTON_CLASS}
            data-anyfilter-verification="disable"
            disabled={status?.enabled !== true}
            onClick={() => void onStop()}
          >
            {t('verification.stopBudget')}
          </button>
        </div>
        <p className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`}>
          {t('verification.stopNote')}
        </p>
        {message !== '' && (
          <p className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`} data-anyfilter-verification="message">
            {message}
          </p>
        )}
      </div>

      <div className="mb-2 mt-4 flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold text-ink">{t('verification.localSamples')}</h3>
        <span className="text-[11px] tabular-nums text-ink-2">
          {filteredCandidates.length === candidates.length
            ? candidates.length
            : `${filteredCandidates.length} / ${candidates.length}`}
        </span>
      </div>

      <div className="min-w-0 [overflow-wrap:anywhere] md:grid md:grid-cols-2 md:items-start md:gap-3">
        {/* Left / narrow-default pane: the bounded, paginated sample list. Hidden on
            a narrow panel once a sample is opened so the detail is not below it. */}
        <div className={detailOpen ? 'hidden md:block' : ''}>
          {candidates.length === 0 ? (
            <p className={`m-0 text-[11px] ${MUTED_CLASS}`}>
              {t('verification.noSamples')}
            </p>
          ) : (
            <>
              <input
                type="search"
                className="mb-2 w-full rounded-lg border border-[#cfd9de] bg-white px-2.5 py-2 text-[12px] disabled:opacity-50"
                aria-label={t('verification.searchSamples')}
                placeholder={t('verification.searchPlaceholder')}
                value={sampleQuery}
                disabled={busy}
                onChange={(event) => setSampleQuery(event.target.value)}
                data-anyfilter-verification="search"
              />
              <label className="mb-2 flex items-center gap-2 text-[11px] text-ink-2">
                <span className="flex-none">{t('verification.sourceLabel')}</span>
                <select
                  className="min-w-0 flex-1 rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[12px] disabled:opacity-50"
                  value={sourceFilter}
                  disabled={busy}
                  onChange={(event) => setSourceFilter(event.target.value as 'all' | CapturePage)}
                  data-anyfilter-verification="source-filter"
                >
                  {SOURCE_FILTERS.map((value) => (
                    <option key={value} value={value}>
                      {value === 'all' ? t('verification.allSources') : sourceLabel(value, t)}
                    </option>
                  ))}
                </select>
              </label>
              <p className={`m-0 mb-2 text-[11px] ${MUTED_CLASS}`}>
                {t('verification.selectFree')}
              </p>
              <ul
                className="m-0 max-h-[55vh] list-none space-y-1 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-1.5"
                data-anyfilter-verification="candidates"
                role="radiogroup"
                aria-label={t('verification.localSamples')}
              >
                {pagedCandidates.map((candidate) => {
                  const isSelected = candidate.sampleId === sampleId;
                  return (
                    <li key={candidate.sampleId}>
                      <label
                        className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-[12px] transition ${
                          isSelected ? 'border-ink bg-white shadow-sm' : 'border-transparent hover:bg-white'
                        }`}
                      >
                        <input
                          type="radio"
                          name="anyfilter-verification-sample"
                          className="mt-0.5 flex-none"
                          value={candidate.sampleId}
                          checked={isSelected}
                          disabled={busy}
                          onClick={() => setDetailOpen(true)}
                          onChange={() => {
                            setSampleId(candidate.sampleId);
                            setDetailOpen(true);
                            setConfirmed(false);
                            setResult(null);
                          }}
                          data-anyfilter-verification="sample"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 break-words text-ink">
                            {candidate.excerpt}
                          </span>
                          <span
                            className={`mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] ${MUTED_CLASS}`}
                          >
                            <span>{sourceLabel(candidate.page, t)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{relativeTime(candidate.capturedAt, t)}</span>
                            {candidate.truncated && (
                              <span className="rounded bg-surface px-1">{t('verification.badge.truncated')}</span>
                            )}
                            {candidate.promoted && (
                              <span className="rounded bg-surface px-1">{t('verification.badge.promoted')}</span>
                            )}
                            {candidate.hasParent && (
                              <span className="rounded bg-surface px-1">{t('verification.badge.reply')}</span>
                            )}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {filteredCandidates.length === 0 ? (
                <p className={`m-0 mt-2 text-[11px] ${MUTED_CLASS}`}>
                  {t('verification.noMatching')}
                </p>
              ) : (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className={`${BUTTON_CLASS} px-2 py-1 text-[12px]`}
                    data-anyfilter-verification="previous-page"
                    disabled={busy || safePage === 0}
                    onClick={() => setPage(Math.max(0, safePage - 1))}
                  >
                    {t('verification.previous')}
                  </button>
                  <span className="text-[11px] tabular-nums text-ink-2">
                    {t('verification.page', { page: safePage + 1, count: pageCount })}
                  </span>
                  <button
                    type="button"
                    className={`${BUTTON_CLASS} px-2 py-1 text-[12px]`}
                    data-anyfilter-verification="next-page"
                    disabled={busy || safePage >= pageCount - 1}
                    onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                  >
                    {t('verification.next')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right pane: the exact text and the send controls. Always in the DOM so
            the disabled send controls exist before a sample is chosen; on a narrow
            panel it is revealed by selecting a sample. */}
        <div className={`mt-3 md:mt-0 ${detailOpen ? '' : 'hidden md:block'}`}>
          <button
            type="button"
            className={`${BUTTON_CLASS} mb-2 w-full md:hidden`}
            data-anyfilter-verification="back-to-samples"
            disabled={busy}
            onClick={() => {
              setDetailOpen(false);
              setConfirmed(false);
            }}
          >
            {t('verification.backToSamples')}
          </button>

          {selected === null ? (
            <p
              className={`m-0 text-[11px] ${MUTED_CLASS}`}
              data-anyfilter-verification="empty-detail"
            >
              {t('verification.selectSample')}
            </p>
          ) : (
            <div
              className="rounded-lg border border-line bg-surface p-2"
              data-anyfilter-verification="preview"
            >
              <p className="m-0 text-[11px] font-bold uppercase tracking-wide text-ink-2">
                {t('verification.exactTextHeading')}
              </p>
              {detailLoading ? (
                <p
                  className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`}
                  data-anyfilter-verification="preview-loading"
                >
                  {t('verification.previewLoading')}
                </p>
              ) : detail === null || !detail.ok ? (
                <p
                  className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`}
                  data-anyfilter-verification="preview-error"
                >
                  {detail?.ok === false
                    ? `${previewRefusalText(detail.reason, detail.message, t)}.`
                    : t('verification.previewUnreadable')}{' '}
                  {t('verification.cannotSend')}
                </p>
              ) : (
                <>
                  <p
                    className="m-0 mt-1 text-[11px] font-semibold text-ink"
                    data-anyfilter-verification="preview-author"
                  >
                    {detail.sample.author.name} · {detail.sample.author.handle}
                  </p>
                  <p
                    className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`}
                    data-anyfilter-verification="preview-source"
                  >
                    {t('verification.fullSource')}:{' '}
                    <span className="break-all">{selected.pageUrl}</span>
                  </p>
                  <pre
                    className="m-0 mt-1 whitespace-pre-wrap break-words font-sans text-[12px] text-ink"
                    data-anyfilter-verification="preview-text"
                  >
                    {detail.sample.text}
                  </pre>
                  {detail.sample.quoted !== null && (
                    <div className="mt-1 border-l-2 border-line pl-2">
                      <p className={`m-0 text-[11px] ${MUTED_CLASS}`}>{t('verification.quotedPost')}</p>
                      <pre
                        className="m-0 whitespace-pre-wrap break-words font-sans text-[12px] text-ink"
                        data-anyfilter-verification="preview-quoted"
                      >
                        {detail.sample.quoted}
                      </pre>
                    </div>
                  )}
                  {detail.sample.replyingTo !== null && (
                    <div className="mt-1 border-l-2 border-line pl-2">
                      <p className={`m-0 text-[11px] ${MUTED_CLASS}`}>{t('verification.replyingTo')}</p>
                      <pre
                        className="m-0 whitespace-pre-wrap break-words font-sans text-[12px] text-ink"
                        data-anyfilter-verification="preview-parent"
                      >
                        {`${detail.sample.replyingTo.author}: ${detail.sample.replyingTo.text}`}
                      </pre>
                    </div>
                  )}
                  <ul className="m-0 mt-1 list-disc space-y-1 pl-4 text-[11px] text-ink-2">
                    {verificationDetailFlags(detail.sample).map((flag) => (
                      <li key={flag.key} data-anyfilter-verification={`preview-flag-${flag.key}`}>
                        {flagText(flag, t)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <label
            className="mt-3 block text-[13px] font-semibold text-ink"
            htmlFor="anyfilter-verification-rule"
          >
            {t('verification.ruleLabel')}
          </label>
          <select
            id="anyfilter-verification-rule"
            className="mt-1 w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px] disabled:opacity-50"
            value={ruleId}
            disabled={selected === null || busy}
            onChange={(event) => {
              setRuleId(event.target.value);
              setConfirmed(false);
              setResult(null);
            }}
            data-anyfilter-verification="rule"
          >
            <option value="">{t('verification.chooseRule')}</option>
            {applicable.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} ({t('verification.threshold')} {option.threshold.toFixed(2)})
              </option>
            ))}
          </select>
          {selected !== null && applicable.length === 0 && (
            <p className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`}>
              {t('verification.noApplicableRule')}
            </p>
          )}

          <label className="mt-3 flex items-start gap-2 text-[12px] text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmed}
              disabled={selected === null || ruleId === '' || !detailReady || busy}
              onChange={(event) => setConfirmed(event.target.checked)}
              data-anyfilter-verification="confirm"
            />
            <span>
              {t('verification.confirm')}
            </span>
          </label>

          <button
            type="button"
            className={`${BUTTON_CLASS} mt-2 w-full`}
            data-anyfilter-verification="run"
            disabled={!canSend}
            onClick={() => void onRun()}
          >
            {busy
              ? t('verification.running')
              : t('verification.send')}
          </button>
          <p className={`m-0 mt-1 text-[11px] ${MUTED_CLASS}`}>
            {t('verification.sendNote')}
          </p>

          <details className="mt-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[11px] text-ink-2">
            <summary className="cursor-pointer font-semibold text-ink">
              {t('verification.disclosureSummary')}
            </summary>
            <ul
              className="m-0 mt-2 list-disc space-y-1 pl-4"
              data-anyfilter-verification="disclosure"
            >
              {disclosure.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>

          {visibleResult !== null && (
            <div
              className="mt-2 rounded-lg bg-surface p-2 text-[11px] text-ink"
              data-anyfilter-verification="result"
              data-kind={visibleResult.kind}
            >
              <p className="m-0">{resultText(visibleResult, t)}</p>
              {visibleResult.kind !== 'skipped' && (
                <p className={`m-0 mt-1 ${MUTED_CLASS}`}>
                  {t('verification.trace.requested')} {visibleResult.trace.requestedModel} ·{' '}
                  {t('verification.trace.answered')} {visibleResult.trace.answeredModel} ·{' '}
                  {t('verification.trace.tokensIn')} {visibleResult.trace.inputTokens ?? t('verification.trace.unknown')} /{' '}
                  {t('verification.trace.out')} {visibleResult.trace.outputTokens ?? t('verification.trace.unknown')} ·{' '}
                  {t('verification.trace.recordedCost')}{' '}
                  {money(visibleResult.trace.costMicro, status?.currency ?? 'USD')}
                  {visibleResult.trace.truncated
                    ? ` · ${t('verification.trace.truncated')}`
                    : ''}
                </p>
              )}
              {visibleResult.kind === 'unknown' && (
                <p className={`m-0 mt-1 ${MUTED_CLASS}`}>
                  {t('verification.unknownHeld')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}