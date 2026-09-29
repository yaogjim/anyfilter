import {
  normalizeJobState,
  type EvaluationJob,
  type EvaluationJobState,
} from '../domain/evaluation-budget';

/**
 * A durable copy of every settled judgement.
 *
 * The budget store keeps at most 200 settled jobs and sheds the oldest, which is
 * right for money bookkeeping but would lose almost every answer of a run over
 * hundreds of samples. Each settled job that carries a real verdict is therefore
 * also written here, in the same `storage.local.set` call as the job store, so
 * the answer and the money are still recorded together.
 *
 * The archive is sharded so a write rewrites a small record, not the whole run.
 * It is also what makes a repeat free after shedding: an identical task is found
 * here and is never sent again. Only the job store's serial write chain calls the
 * writing functions, so two writers never race one shard. The archive never holds
 * a key or a post body: a job carries only ids, hashes, tokens, money and the
 * verdict.
 */

export const ARCHIVE_PREFIX = 'anyfilter.evaluation.archive.';
export const ARCHIVE_META_KEY = `${ARCHIVE_PREFIX}meta`;
const SHARDS = 64;

function shardOf(jobId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < jobId.length; i += 1) {
    hash = Math.imul(hash ^ jobId.charCodeAt(i), 16777619) >>> 0;
  }
  return `${ARCHIVE_PREFIX}s${hash % SHARDS}`;
}

const ALL_SHARD_KEYS: readonly string[] = Array.from({ length: SHARDS }, (_, i) => `${ARCHIVE_PREFIX}s${i}`);

/** Settled jobs archived per model, for a cheap count in the panel. */
export type ArchiveCounts = Readonly<Record<string, number>>;

function shardJobs(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function readCounts(raw: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) counts[model] = value;
    }
  }
  return counts;
}

function revive(state: EvaluationJobState, raw: readonly unknown[]): EvaluationJob[] {
  return normalizeJobState({ epoch: state.epoch, prices: state.prices, jobs: raw }).jobs.filter(
    (job) => job.status === 'settled' && job.verdict !== null,
  );
}

/** The archived job for an id, or `null`. */
export async function findArchivedJob(state: EvaluationJobState, jobId: string): Promise<EvaluationJob | null> {
  const key = shardOf(jobId);
  const shard = shardJobs((await chrome.storage.local.get(key))[key]);
  const raw = shard[jobId];
  return raw === undefined ? null : (revive(state, [raw])[0] ?? null);
}

/** The storage entries that record one settled job. Merge them into the same
 * `set` call that writes the job store. Returns `{}` for a job with no verdict. */
export async function archiveEntriesFor(job: EvaluationJob): Promise<Record<string, unknown>> {
  if (job.status !== 'settled' || job.verdict === null) return {};
  const key = shardOf(job.jobId);
  const stored = await chrome.storage.local.get([key, ARCHIVE_META_KEY]);
  const shard = shardJobs(stored[key]);
  const counts = readCounts(stored[ARCHIVE_META_KEY]);
  if (shard[job.jobId] === undefined) counts[job.model] = (counts[job.model] ?? 0) + 1;
  shard[job.jobId] = job;
  return { [key]: shard, [ARCHIVE_META_KEY]: counts };
}

export async function loadArchivedJobs(state: EvaluationJobState): Promise<EvaluationJob[]> {
  const stored = await chrome.storage.local.get([...ALL_SHARD_KEYS]);
  const raw: unknown[] = [];
  for (const key of ALL_SHARD_KEYS) raw.push(...Object.values(shardJobs(stored[key])));
  return revive(state, raw);
}

export async function loadArchiveCounts(): Promise<ArchiveCounts> {
  return readCounts((await chrome.storage.local.get(ARCHIVE_META_KEY))[ARCHIVE_META_KEY]);
}

export async function clearArchive(): Promise<void> {
  await chrome.storage.local.remove([...ALL_SHARD_KEYS, ARCHIVE_META_KEY]);
}

/** The job store's state with every archived job that was shed from it added back,
 * for an export or a count. Read-only. */
export async function loadEvaluationJobsWithArchive(state: EvaluationJobState): Promise<EvaluationJobState> {
  const archived = await loadArchivedJobs(state);
  const known = new Set(state.jobs.map((job) => job.jobId));
  return { ...state, jobs: [...state.jobs, ...archived.filter((job) => !known.has(job.jobId))] };
}
