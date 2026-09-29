import {
  abandonJob,
  clearJobHistory,
  disableBudget,
  enableBudget,
  normalizeJobState,
  recoverUnsettledJobs,
  settleJob,
  jobIdFor,
  settledBaselines,
  startJob,
  type AbandonJobRequest,
  type BudgetLimit,
  type BudgetPrice,
  type BudgetRefusal,
  type EvaluationJob,
  type EvaluationJobState,
  type SettledEvaluationBaseline,
  type SettleJobRequest,
  type StartJobRequest,
} from '../domain/evaluation-budget';
import { archiveEntriesFor, clearArchive, findArchivedJob, loadEvaluationJobsWithArchive } from './evaluation-archive';

/**
 * Persistence for the verification budget and its task states.
 *
 * It owns exactly one `storage.local` key and nothing else. It never reads or
 * writes the settings record, the production panel state, the capture library or
 * the score cache, and it makes no network call: starting a job only records a
 * reservation, it never sends anything. Turning this budget on therefore cannot
 * change what the normal feed hides, and it must never be described as bounding
 * the feed's own Jev usage — the feed's calls are not counted here.
 *
 * Every write is serialized through one queue, so a start racing a delete (or two
 * identical starts) can never interleave. A failed write is reported as a
 * failure instead of being presented as success.
 */

export const EVALUATION_JOBS_KEY = 'anyfilter.evaluation.jobs';

export type JobStoreError = BudgetRefusal | 'storage';

export interface JobStoreFailure {
  readonly ok: false;
  readonly error: JobStoreError;
  readonly detail: string;
}

export type StartJobStoreResult =
  | { readonly ok: true; readonly job: EvaluationJob; readonly deduped: boolean }
  | JobStoreFailure;

export type UpdateJobStoreResult =
  | {
      readonly ok: true;
      readonly job: EvaluationJob;
      readonly deduped: boolean;
      readonly released: boolean;
    }
  | JobStoreFailure;

export type BudgetStoreResult =
  | { readonly ok: true; readonly state: EvaluationJobState }
  | JobStoreFailure;

export type RecoverStoreResult =
  | { readonly ok: true; readonly recovered: number; readonly state: EvaluationJobState }
  | JobStoreFailure;

let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Reads the budget state; any context may read it, only the background writes. */
export async function loadEvaluationJobs(): Promise<EvaluationJobState> {
  const stored = await chrome.storage.local.get(EVALUATION_JOBS_KEY);
  return normalizeJobState(stored[EVALUATION_JOBS_KEY]);
}

function storageFailure(error: unknown): JobStoreFailure {
  return {
    ok: false,
    error: 'storage',
    detail: error instanceof Error ? error.message : String(error),
  };
}

async function persist(
  state: EvaluationJobState,
  extra: Record<string, unknown> = {},
): Promise<JobStoreFailure | null> {
  try {
    await chrome.storage.local.set({ ...extra, [EVALUATION_JOBS_KEY]: state });
    return null;
  } catch (error) {
    return storageFailure(error);
  }
}

export interface EnableBudgetStoreInput {
  readonly prices: readonly BudgetPrice[];
  readonly limits: readonly BudgetLimit[];
  readonly now?: number;
}

/**
 * Enables the budget. Refused when a limit has no known price in the same
 * currency, which is the offline gate that keeps an unpriced rate from ever
 * becoming a paid call.
 */
export function enableEvaluationBudget(input: EnableBudgetStoreInput): Promise<BudgetStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const result = enableBudget(state, { prices: input.prices, limits: input.limits }, input.now ?? Date.now());
    if (!result.ok) return result;
    const failed = await persist(result.state);
    if (failed) return failed;
    return { ok: true, state: result.state };
  });
}

/** Stops the run: open jobs become `unknown` and keep their money, and the epoch
 * is bumped so a late answer is refused. */
export function disableEvaluationBudget(now = Date.now()): Promise<BudgetStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const next = disableBudget(state, now);
    const failed = await persist(next);
    if (failed) return failed;
    return { ok: true, state: next };
  });
}

export interface StartJobStoreInput extends StartJobRequest {
  readonly now?: number;
}

/** Reserves the worst case for one task. The identical task is deduped instead of
 * reserving twice. No request is sent here. */
export function startEvaluationJob(input: StartJobStoreInput): Promise<StartJobStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const { now, ...request } = input;
    // A settled answer that was shed from the job store is still in the archive:
    // an identical task is found there and never sent again.
    const archived = await findArchivedJob(
      state,
      jobIdFor(request.model, request.rulesFingerprint, request.ruleId, request.inputHash),
    );
    if (archived !== null && !state.jobs.some((job) => job.jobId === archived.jobId)) {
      return { ok: true, job: archived, deduped: true };
    }
    const result = startJob(state, request, now ?? Date.now());
    if (!result.ok) return result;
    if (result.deduped) return { ok: true, job: result.job, deduped: true };
    const failed = await persist(result.state);
    if (failed) return failed;
    return { ok: true, job: result.job, deduped: false };
  });
}

export interface SettleJobStoreInput extends SettleJobRequest {
  readonly now?: number;
}

/** Records real usage for a finished task and releases its reservation. An answer
 * from before a stop or a delete is refused. */
export function settleEvaluationJob(input: SettleJobStoreInput): Promise<UpdateJobStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const { now, ...request } = input;
    const result = settleJob(state, request, now ?? Date.now());
    if (!result.ok) return result;
    if (result.deduped) return { ok: true, job: result.job, deduped: true, released: true };
    // The answer joins the money in one write, and the archive keeps it after the
    // job store sheds the job.
    let entries: Record<string, unknown>;
    try {
      entries = await archiveEntriesFor(result.job);
    } catch (error) {
      return storageFailure(error);
    }
    const failed = await persist(result.state, entries);
    if (failed) return failed;
    return { ok: true, job: result.job, deduped: false, released: true };
  });
}

export interface AbandonJobStoreInput extends AbandonJobRequest {
  readonly now?: number;
}

/** Gives up on a task. `sent: true` keeps the reservation as `unknown`; a job
 * that was never sent releases it. */
export function abandonEvaluationJob(input: AbandonJobStoreInput): Promise<UpdateJobStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const { now, ...request } = input;
    const result = abandonJob(state, request, now ?? Date.now());
    if (!result.ok) return result;
    if (result.deduped) return { ok: true, job: result.job, deduped: true, released: true };
    const failed = await persist(result.state);
    if (failed) return failed;
    return { ok: true, job: result.job, deduped: false, released: result.released };
  });
}

/**
 * Background-start recovery. Call this once when the worker starts: every job
 * still open becomes `unknown` and keeps its reservation, and nothing is
 * re-sent. A worker that died mid-request cannot know whether the provider
 * already charged it, so the reservation stays held until a person decides.
 */
export function recoverUnsettledEvaluationJobs(now = Date.now()): Promise<RecoverStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const result = recoverUnsettledJobs(state, now);
    if (result.recovered === 0) return { ok: true, recovered: 0, state };
    const failed = await persist(result.state);
    if (failed) return failed;
    return { ok: true, recovered: result.recovered, state: result.state };
  });
}

/**
 * Restores every real judgement that a previous worker had already settled, so a
 * restart can rebuild the Jev baseline from `storage.local` instead of losing it
 * with the in-memory result. Read-only and offline: it never re-sends, never
 * reads a key and never touches the sample bodies. Jobs that settled without a
 * recorded verdict are deliberately omitted — a held cost is not a baseline.
 */
export async function loadSettledEvaluationBaselines(): Promise<readonly SettledEvaluationBaseline[]> {
  const state = await loadEvaluationJobsWithArchive(await loadEvaluationJobs());
  return settledBaselines(state);
}

/** Why a job could not be re-confirmed as still active. */
export type JobActivityError = 'not-found' | 'stale-epoch' | 'not-pending';

export type JobActivityResult =
  | { readonly ok: true; readonly job: EvaluationJob }
  | { readonly ok: false; readonly error: JobActivityError; readonly detail: string };

/**
 * Fail-closed guard for the window between reserving a job and sending it. It is
 * queued on the same serial write chain as stop/clear, so any stop or delete that
 * was requested before this check is already visible: a mismatched epoch, a
 * missing job or a job no longer `pending` all refuse. The caller must not fetch
 * unless this returns `ok`. A refusal never releases the reservation — a stop
 * already turned it `unknown` and kept its money, and that must stay held.
 */
export function recheckActiveEvaluationJob(
  jobId: string,
  epoch: number,
): Promise<JobActivityResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    if (epoch !== state.epoch) {
      return { ok: false, error: 'stale-epoch', detail: `epoch ${epoch} is not the current epoch ${state.epoch}` };
    }
    const job = state.jobs.find((candidate) => candidate.jobId === jobId);
    if (!job) return { ok: false, error: 'not-found', detail: `no job ${jobId}` };
    if (job.status !== 'pending' || job.epoch !== state.epoch) {
      return { ok: false, error: 'not-pending', detail: `job ${jobId} is ${job.status} and cannot be sent` };
    }
    return { ok: true, job };
  });
}

/** Deletes the job history and bumps the epoch, so an answer for a deleted job
 * cannot land. Recorded spend and the price table stay. */
export function clearEvaluationJobs(now = Date.now()): Promise<BudgetStoreResult> {
  return enqueue(async () => {
    const state = await loadEvaluationJobs();
    const next = clearJobHistory(state, now);
    try {
      await clearArchive();
    } catch (error) {
      return storageFailure(error);
    }
    const failed = await persist(next);
    if (failed) return failed;
    return { ok: true, state: next };
  });
}