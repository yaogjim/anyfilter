import {
  captureSkipReason,
  CAPTURE_RETENTION_MS,
  isCaptureOutcome,
  isCaptureSample,
  MAX_SAMPLES,
  mergeSample,
  normalizeCaptureState,
  sampleOf,
  withOutcome,
  type CaptureOutcome,
  type CapturePage,
  type CaptureRunState,
  type CaptureSample,
  type CaptureState,
  type CaptureSubmitResult,
} from '../domain/capture';
import type { Post } from '../domain/post';

/**
 * Local, independent storage for the voluntary verification library.
 *
 * It owns exactly two `storage.local` keys and nothing else. It never reads or
 * writes the production panel state, the score cache (`storage.session`), the
 * settings record or a provider key, so turning observation on can not change
 * what the feed hides and deleting samples can not lose a key or a rule.
 *
 * Reads are safe from any extension context; every write is serialized through
 * one queue and is intended to be called by the background only, after the
 * sender and the run state have been checked.
 */

const STATE_KEY = 'anyfilter.capture.state';
const SAMPLES_KEY = 'anyfilter.capture.samples';

/** Every write goes through this queue, so a start/pause/clear can never
 * interleave with the read-modify-write of a submit. */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task);
  writeChain = next.catch(() => undefined);
  return next;
}

export async function loadCaptureState(): Promise<CaptureState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeCaptureState(stored[STATE_KEY]);
}

async function readRawSamples(): Promise<CaptureSample[]> {
  const stored = await chrome.storage.local.get(SAMPLES_KEY);
  const raw: unknown = stored[SAMPLES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCaptureSample).slice(-MAX_SAMPLES);
}

/** Expired text is never returned to callers; background maintenance also
 * removes its physical storage record when the worker starts or writes. */
export async function loadCaptureSamples(): Promise<CaptureSample[]> {
  const now = Date.now();
  return (await readRawSamples()).filter(
    (sample) => sample.capturedAt > now - CAPTURE_RETENTION_MS && sample.capturedAt <= now,
  );
}

/** Serialized cleanup on background startup. No alarm or extra permission is
 * required; a sleeping browser removes expired data on its next worker wake. */
export function pruneExpiredCaptureSamples(): Promise<CaptureState> {
  return enqueue(async () => {
    const current = await loadCaptureState();
    const raw = await readRawSamples();
    const fresh = await loadCaptureSamples();
    if (raw.length === fresh.length && current.stored === fresh.length) return current;
    return write({ ...current, updatedAt: Date.now() }, fresh);
  });
}

async function write(
  state: CaptureState,
  samples: readonly CaptureSample[],
): Promise<CaptureState> {
  const next: CaptureState = { ...state, stored: samples.length };
  await chrome.storage.local.set({ [STATE_KEY]: next, [SAMPLES_KEY]: [...samples] });
  return next;
}

/** Moves the run state. The epoch is bumped on every change so an in-flight
 * submit from before the change is refused instead of landing afterwards. */
export function setCaptureRunState(runState: CaptureRunState): Promise<CaptureState> {
  return enqueue(async () => {
    const current = await loadCaptureState();
    const samples = await loadCaptureSamples();
    return write(
      {
        ...current,
        runState,
        epoch: current.epoch + 1,
        updatedAt: Date.now(),
      },
      samples,
    );
  });
}

/**
 * Deletes every verification sample and bumps the epoch, so a submit that was
 * already in flight cannot re-add what the user just deleted. Only the two
 * capture keys are touched: rules, settings and provider keys are left alone.
 */
export function clearCaptureSamples(): Promise<CaptureState> {
  return enqueue(async () => {
    const current = await loadCaptureState();
    return write(
      {
        ...current,
        epoch: current.epoch + 1,
        skipped: 0,
        updatedAt: Date.now(),
      },
      [],
    );
  });
}

export interface RecordObservationsInput {
  /** The epoch the content script read; a mismatch means the batch is stale. */
  readonly epoch: number;
  readonly page: CapturePage;
  readonly pageUrl: string;
  readonly capturedAt: number;
  readonly posts: readonly Post[];
}

/**
 * Stores the admissible posts of one batch.
 *
 * The gate is re-checked here, not trusted from the caller: the run state must
 * still be `active` and the epoch must still be current, so a paused or cleared
 * workflow cannot be written to by a late request. Admissibility per post is
 * decided by `captureSkipReason`, repeats are idempotent, and the cap sheds the
 * oldest sample. `skipped` counts everything that was read but not stored.
 */
export function recordObservations(input: RecordObservationsInput): Promise<CaptureSubmitResult> {
  return enqueue(async (): Promise<CaptureSubmitResult> => {
    const current = await loadCaptureState();
    if (current.runState !== 'active') {
      return { ok: false, error: 'not-active', detail: `capture is ${current.runState}` };
    }
    if (current.epoch !== input.epoch) {
      return {
        ok: false,
        error: 'stale-epoch',
        detail: `epoch ${input.epoch} is not the current epoch ${current.epoch}`,
      };
    }

    let samples = await loadCaptureSamples();
    let stored = 0;
    let skipped = 0;
    for (const post of input.posts) {
      if (captureSkipReason(post) !== null) {
        skipped += 1;
        continue;
      }
      const merged = mergeSample(
        samples,
        sampleOf(post, { page: input.page, pageUrl: input.pageUrl, capturedAt: input.capturedAt }),
      );
      samples = [...merged.samples];
      if (merged.added) stored += 1;
      else skipped += 1;
    }

    await write(
      {
        ...current,
        skipped: current.skipped + skipped,
        updatedAt: Date.now(),
      },
      samples,
    );
    return { ok: true, stored, skipped };
  });
}

/**
 * Attaches filtering outcomes to the samples they describe.
 *
 * The run state and the epoch are re-checked here for the same reason as
 * {@link recordObservations}: a batch that started before a pause or a delete
 * must not land afterwards. An outcome whose `sampleId` is not stored is counted
 * as skipped instead of creating a sample. Only the two capture keys are
 * touched.
 */
export interface RecordOutcomesInput {
  readonly epoch: number;
  readonly outcomes: readonly CaptureOutcome[];
}

export function recordCaptureOutcomes(input: RecordOutcomesInput): Promise<CaptureSubmitResult> {
  return enqueue(async (): Promise<CaptureSubmitResult> => {
    const current = await loadCaptureState();
    if (current.runState !== 'active') {
      return { ok: false, error: 'not-active', detail: `capture is ${current.runState}` };
    }
    if (current.epoch !== input.epoch) {
      return {
        ok: false,
        error: 'stale-epoch',
        detail: `epoch ${input.epoch} is not the current epoch ${current.epoch}`,
      };
    }

    const samples = await loadCaptureSamples();
    let stored = 0;
    let skipped = 0;
    if (samples.length > 0) {
      const byId = new Map(samples.map((sample) => [sample.sampleId, sample]));
      const updated = new Map<string, CaptureSample>();
      for (const outcome of input.outcomes) {
        if (!isCaptureOutcome(outcome)) {
          skipped += 1;
          continue;
        }
        const sample = byId.get(outcome.sampleId);
        // The sample id already encodes the post and its content, but the same
        // input and content are checked again so a fingerprint collision can
        // never pair an outcome with a different post.
        if (
          sample === undefined ||
          sample.postId !== outcome.postId ||
          sample.contentKey !== outcome.contentKey ||
          sample.inputHash !== outcome.inputHash
        ) {
          skipped += 1;
          continue;
        }
        const base = updated.get(outcome.sampleId) ?? sample;
        const next = withOutcome(base, outcome);
        // A repeat of the same snapshot is not a new observation.
        if (next === base) {
          skipped += 1;
          continue;
        }
        updated.set(outcome.sampleId, next);
        stored += 1;
      }
      if (updated.size > 0) {
        await write(
          { ...current, updatedAt: Date.now() },
          samples.map((sample) => updated.get(sample.sampleId) ?? sample),
        );
      }
    }
    return { ok: true, stored, skipped };
  });
}

export function onCaptureStateChanged(listener: (state: CaptureState) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ): void => {
    if (area === 'local' && STATE_KEY in changes) {
      listener(normalizeCaptureState(changes[STATE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}