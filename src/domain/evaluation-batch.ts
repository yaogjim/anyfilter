/**
 * The batch gate for the real evaluation: runs many (sample, rule) tasks through
 * one labeller and stops the moment continuing would be unsafe.
 *
 * Pure. The caller supplies `execute`, which performs one task and reports how it
 * ended. The per-call money gate (reserve before send, settle after) lives in the
 * budget; this module adds the rules a batch needs on top of it:
 *
 * - **Stop on excess.** A refused reservation (`cap-exceeded`), a switched-off
 *   budget, a missing key or a storage failure halts the whole batch. Nothing
 *   further is started, because retrying the next task would fail the same way
 *   or, worse, spend past what was authorized.
 * - **Stop on a bad run.** Several failures in a row (`unknown`: sent, no usable
 *   answer, money held) halt the batch, so a broken key or an outage cannot burn
 *   the whole budget one held reservation at a time.
 * - **A hard task ceiling** and a **person's stop** are checked before every task.
 * - **Bounded concurrency.** In-flight tasks always finish and are counted; a
 *   halt only prevents new ones from starting.
 *
 * Tasks that are refused for their own content (`not-sendable`, an uncompilable
 * rule, a vanished sample) are skipped without halting: they say nothing about
 * money.
 */

export interface BatchTask {
  readonly sampleId: string;
  readonly ruleId: string;
}

/** How one task ended, as far as the batch is concerned. */
export type BatchStep =
  | { readonly kind: 'recorded' }
  /** The identical task was already settled; nothing was sent. */
  | { readonly kind: 'repeat' }
  /** This task cannot be sent, for a reason specific to it. */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** Sent (or possibly sent) with no usable answer; money stays held. */
  | { readonly kind: 'failed'; readonly reason: string }
  /** Continuing is unsafe for everyone; stop the batch. */
  | { readonly kind: 'halt'; readonly reason: string; readonly haltAs?: BatchHaltReason };

export type BatchHaltReason =
  | 'budget'
  | 'key'
  | 'storage'
  | 'stopped'
  | 'failures'
  | 'ceiling'
  | 'inactive';

export interface BatchProgress {
  readonly total: number;
  readonly started: number;
  readonly recorded: number;
  readonly repeats: number;
  readonly skipped: number;
  readonly failed: number;
  readonly halted: BatchHaltReason | null;
  readonly haltDetail: string;
  readonly finished: boolean;
}

export interface BatchPolicy {
  /** No more than this many tasks are ever started in one run. */
  readonly maxTasks: number;
  /** Consecutive failures that halt the run. */
  readonly maxConsecutiveFailures: number;
  readonly concurrency: number;
}

export const DEFAULT_BATCH_POLICY: BatchPolicy = {
  maxTasks: 3000,
  maxConsecutiveFailures: 3,
  concurrency: 4,
};

/** Maps a skip reason from the executors to a batch step. Unknown reasons halt:
 * a batch never guesses that a new refusal is harmless. */
export function stepOfSkip(reason: string, detail: string): BatchStep {
  switch (reason) {
    case 'already-recorded':
      return { kind: 'repeat' };
    case 'not-sendable':
    case 'rule-not-compiled':
    case 'sample-not-found':
      return { kind: 'skipped', reason: detail };
    default:
      return { kind: 'halt', reason: `${reason}: ${detail}`, haltAs: haltReasonOfSkip(reason) };
  }
}

/** The halt category for a skip reason, for display and tests. */
export function haltReasonOfSkip(reason: string): BatchHaltReason {
  if (reason === 'no-key') return 'key';
  if (reason === 'storage') return 'storage';
  if (reason === 'job-inactive' || reason === 'not-authorized') return 'inactive';
  return 'budget';
}

export interface RunBatchInput {
  readonly tasks: readonly BatchTask[];
  readonly execute: (task: BatchTask) => Promise<BatchStep>;
  readonly policy?: Partial<BatchPolicy>;
  /** Checked before every task. */
  readonly shouldStop?: () => boolean;
  readonly onProgress?: (progress: BatchProgress) => void;
}

export async function runBatch(input: RunBatchInput): Promise<BatchProgress> {
  const policy: BatchPolicy = { ...DEFAULT_BATCH_POLICY, ...input.policy };
  const total = Math.min(input.tasks.length, policy.maxTasks);
  const counts = { started: 0, recorded: 0, repeats: 0, skipped: 0, failed: 0 };
  let halted: BatchHaltReason | null = null;
  let haltDetail = '';
  let consecutiveFailures = 0;
  let next = 0;

  const snapshot = (finished: boolean): BatchProgress => ({
    total,
    ...counts,
    halted,
    haltDetail,
    finished,
  });
  const halt = (reason: BatchHaltReason, detail: string): void => {
    if (halted === null) {
      halted = reason;
      haltDetail = detail;
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted !== null) return;
      if (input.shouldStop?.() === true) {
        halt('stopped', 'stopped by the user');
        return;
      }
      if (next >= total) return;
      const task = input.tasks[next];
      next += 1;
      counts.started += 1;
      let step: BatchStep;
      try {
        step = await input.execute(task);
      } catch (error) {
        step = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      switch (step.kind) {
        case 'recorded':
          counts.recorded += 1;
          consecutiveFailures = 0;
          break;
        case 'repeat':
          counts.repeats += 1;
          break;
        case 'skipped':
          counts.skipped += 1;
          break;
        case 'failed':
          counts.failed += 1;
          consecutiveFailures += 1;
          if (consecutiveFailures >= policy.maxConsecutiveFailures) {
            halt('failures', `${consecutiveFailures} failures in a row: ${step.reason}`);
          }
          break;
        case 'halt':
          halt(step.haltAs ?? 'budget', step.reason);
          break;
      }
      input.onProgress?.(snapshot(false));
    }
  };

  const workers = Math.max(1, Math.min(policy.concurrency, total || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (halted === null && input.tasks.length > policy.maxTasks) {
    halt('ceiling', `stopped at ${policy.maxTasks} tasks`);
  }
  const done = snapshot(true);
  input.onProgress?.(done);
  return done;
}
