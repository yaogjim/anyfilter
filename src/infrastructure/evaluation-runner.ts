import { senderKind, type SenderLike } from '../domain/capture';
import {
  runBatch,
  stepOfSkip,
  type BatchProgress,
  type BatchStep,
  type BatchTask,
} from '../domain/evaluation-batch';
import type { EvaluationConnections, LabellerId, MachineConnectionId } from '../domain/evaluation-pricing';
import {
  buildEvaluationExport,
  idleRunStatus,
  overviewOf,
  type EvaluationExport,
  type EvaluationOverview,
  type EvaluationRunStartResult,
  type EvaluationRunStatus,
} from '../domain/evaluation-run';
import { enabledSemanticRuleOptions } from '../domain/evaluation-verification';
import type { MachineLabellerId } from '../domain/machine-label';
import { loadCaptureSamples } from './capture-store';
import { runSingleMachineLabel } from './evaluation-machine';
import { runSingleSampleEvaluation } from './evaluation-jev';
import { loadArchiveCounts, loadEvaluationJobsWithArchive } from './evaluation-archive';
import { loadEvaluationJobs } from './evaluation-jobs';
import { loadKeyPresence, saveEvaluationKey, type KeyPresence } from './evaluation-keys';
import { loadEvaluationConnections, saveEvaluationConnection } from './evaluation-connection';
import { loadSettings } from './settings-store';

/**
 * The authorization boundary for running one labeller over the whole capture
 * library, and the only place a batch of paid calls can start.
 *
 * - **Our own extension pages only.** Every entry point re-derives who sent the
 *   message with `senderKind`; a content script or web page is refused before a
 *   key is read or a sample is loaded.
 * - **Authorization is derived, never accepted.** The `authorized: true` handed to
 *   the executors is produced here and nowhere else; no message field can set it.
 * - **One run at a time.** A second start while one is running is refused, so two
 *   loops can never race the same budget.
 * - **The budget is the gate.** Each task reserves its worst case before it is
 *   sent. A refusal (cap, budget off, no key, storage) halts the whole batch via
 *   the batch gate; the halt is reported, never retried.
 * - **Nothing is remembered but progress.** Results live in the budget store; a
 *   restarted worker loses only the progress counters, and a re-run dedupes every
 *   task that already settled.
 *
 * Progress lives in the worker's memory. It is display only and never decides
 * spending.
 */

let status: EvaluationRunStatus = idleRunStatus();
let stopRequested = false;

export function currentRunStatus(): EvaluationRunStatus {
  return status;
}

function wrongSender(kind: string): string {
  return `evaluation may only be controlled from this extension's own pages, not from a ${kind} sender`;
}

/** The tasks of one run: every stored sample against every enabled semantic rule,
 * in a stable order, so an interrupted run resumes the same list. */
export async function evaluationTasks(): Promise<BatchTask[]> {
  const [samples, settings] = await Promise.all([loadCaptureSamples(), loadSettings()]);
  const rules = enabledSemanticRuleOptions(settings);
  const ordered = [...samples].sort((a, b) => a.sampleId.localeCompare(b.sampleId));
  const tasks: BatchTask[] = [];
  for (const sample of ordered) {
    for (const rule of rules) tasks.push({ sampleId: sample.sampleId, ruleId: rule.id });
  }
  return tasks;
}

async function executeOne(labeller: LabellerId, task: BatchTask): Promise<BatchStep> {
  if (labeller === 'jev') {
    const result = await runSingleSampleEvaluation({ ...task, authorized: true });
    switch (result.kind) {
      case 'match':
      case 'no-match':
      case 'undecided':
        return result.restored === true ? { kind: 'repeat' } : { kind: 'recorded' };
      case 'unknown':
        return { kind: 'failed', reason: result.detail };
      case 'skipped':
        return stepOfSkip(result.reason, result.detail);
    }
  }
  const result = await runSingleMachineLabel({
    labeller: labeller as MachineLabellerId,
    ...task,
    authorized: true,
  });
  switch (result.kind) {
    case 'labelled':
    case 'undecided':
      return result.restored === true ? { kind: 'repeat' } : { kind: 'recorded' };
    case 'unknown':
      return { kind: 'failed', reason: result.detail };
    case 'skipped':
      return stepOfSkip(result.reason, result.detail);
  }
}

/**
 * Starts one batch and returns as soon as it is running; progress is read with
 * {@link currentRunStatus}. The returned promise inside `done` resolves when the
 * batch ends, which the tests await and the message handler ignores.
 */
export async function startEvaluationBatch(
  sender: SenderLike,
  ownExtensionId: string,
  labeller: LabellerId,
): Promise<EvaluationRunStartResult & { readonly done?: Promise<BatchProgress> }> {
  const kind = senderKind(sender, ownExtensionId);
  if (kind !== 'extension-page') return { ok: false, detail: wrongSender(kind), status };
  if (status.running) {
    return { ok: false, detail: 'a batch is already running', status };
  }
  const tasks = await evaluationTasks();
  if (tasks.length === 0) {
    return { ok: false, detail: 'there are no stored samples or no enabled semantic rule', status };
  }
  stopRequested = false;
  const startedAt = Date.now();
  status = {
    running: true,
    labeller,
    startedAt,
    progress: {
      total: tasks.length,
      started: 0,
      recorded: 0,
      repeats: 0,
      skipped: 0,
      failed: 0,
      halted: null,
      haltDetail: '',
      finished: false,
    },
  };
  const done = runBatch({
    tasks,
    execute: (task) => executeOne(labeller, task),
    shouldStop: () => stopRequested,
    onProgress: (progress) => {
      status = { running: !progress.finished, labeller, startedAt, progress };
    },
  }).catch((error: unknown): BatchProgress => {
    const progress: BatchProgress = {
      ...(status.progress as BatchProgress),
      halted: 'storage',
      haltDetail: error instanceof Error ? error.message : String(error),
      finished: true,
    };
    status = { running: false, labeller, startedAt, progress };
    return progress;
  });
  return { ok: true, status, done };
}

/** Asks the running batch to stop before its next task. Tasks already in flight
 * finish and settle; nothing is refunded and nothing new starts. */
export function stopEvaluationBatch(sender: SenderLike, ownExtensionId: string): EvaluationRunStatus {
  const kind = senderKind(sender, ownExtensionId);
  if (kind !== 'extension-page') return status;
  stopRequested = true;
  return status;
}

export async function loadEvaluationOverview(): Promise<EvaluationOverview> {
  const [state, samples, settings, archived] = await Promise.all([
    loadEvaluationJobs(),
    loadCaptureSamples(),
    loadSettings(),
    loadArchiveCounts(),
  ]);
  return overviewOf(state, samples.length, enabledSemanticRuleOptions(settings).length, archived);
}

export async function setEvaluationKey(
  sender: SenderLike,
  ownExtensionId: string,
  labeller: MachineLabellerId,
  key: string,
): Promise<{ readonly ok: boolean; readonly keys: KeyPresence }> {
  if (senderKind(sender, ownExtensionId) !== 'extension-page') {
    return { ok: false, keys: await loadKeyPresence() };
  }
  const ok = await saveEvaluationKey(labeller, key);
  return { ok, keys: await loadKeyPresence() };
}

/** The export a person saves by hand. It contains post text and is handed only to
 * one of our own pages. */
export async function loadEvaluationExport(
  sender: SenderLike,
  ownExtensionId: string,
): Promise<EvaluationExport | null> {
  if (senderKind(sender, ownExtensionId) !== 'extension-page') return null;
  const [samples, current, settings] = await Promise.all([
    loadCaptureSamples(),
    loadEvaluationJobs(),
    loadSettings(),
  ]);
  const state = await loadEvaluationJobsWithArchive(current);
  return buildEvaluationExport(samples, state, settings, new Date().toISOString());
}

export async function readEvaluationConnections(sender: SenderLike, ownExtensionId: string): Promise<EvaluationConnections | null> {
  return senderKind(sender, ownExtensionId) === 'extension-page' ? loadEvaluationConnections() : null;
}

export async function setEvaluationConnection(
  sender: SenderLike,
  ownExtensionId: string,
  labeller: MachineConnectionId,
  connection: unknown,
): Promise<{ readonly ok: boolean; readonly connections: EvaluationConnections }> {
  if (senderKind(sender, ownExtensionId) !== 'extension-page') {
    return { ok: false, connections: await loadEvaluationConnections() };
  }
  const ok = await saveEvaluationConnection(labeller, connection);
  return { ok, connections: await loadEvaluationConnections() };
}
