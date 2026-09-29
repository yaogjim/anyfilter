import {
  applyRecord,
  isReviewRecord,
  MAX_REVIEW_RECORDS,
  removeRecord,
  type ReviewLoadResult,
  type ReviewRecord,
  type ReviewSaveInput,
  type ReviewSaveResult,
} from '../domain/review-record';

/**
 * Local storage of in-timeline review annotations. It owns exactly one
 * `storage.local` key. It is separate from the verification sample library, the
 * evaluation ledger, the settings and every provider key: deleting annotations
 * cannot lose a sample, a rule or a key.
 *
 * Reads are safe anywhere. Every write goes through one queue and is meant to be
 * called only by the background, after it has checked the sender.
 *
 * `epoch` is bumped whenever the store is cleared. A write carries the epoch the
 * page read, so a save that was already in flight when the data was deleted is
 * refused instead of bringing the annotation back.
 */
const STORE_KEY = 'anyfilter.review.records';

interface Stored {
  epoch: number;
  records: ReviewRecord[];
}

let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task);
  writeChain = next.catch(() => undefined);
  return next;
}

async function read(): Promise<Stored> {
  const stored = await chrome.storage.local.get(STORE_KEY);
  const raw: unknown = stored[STORE_KEY];
  if (typeof raw !== 'object' || raw === null) return { epoch: 0, records: [] };
  const record = raw as Record<string, unknown>;
  const epoch = typeof record.epoch === 'number' && Number.isInteger(record.epoch) ? record.epoch : 0;
  const records = Array.isArray(record.records)
    ? record.records.filter(isReviewRecord).slice(-MAX_REVIEW_RECORDS)
    : [];
  return { epoch, records };
}

async function write(next: Stored): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: next });
}

export async function loadReviewStore(): Promise<{ epoch: number; records: ReviewRecord[] }> {
  return read();
}

export async function loadReviewLoadResult(): Promise<ReviewLoadResult> {
  try {
    const { epoch, records } = await read();
    return { ok: true, epoch, records };
  } catch (error) {
    return { ok: false, error: 'storage', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function saveReviewRecord(
  epoch: number,
  input: ReviewSaveInput,
  now: number,
  cap: number = MAX_REVIEW_RECORDS,
): Promise<ReviewSaveResult> {
  return enqueue(async () => {
    try {
      const current = await read();
      if (current.epoch !== epoch) {
        return { ok: false, error: 'stale-epoch', detail: 'annotations were deleted since this page loaded them' } as const;
      }
      const applied = applyRecord(current.records, input, now, cap);
      if (!applied.ok) {
        return { ok: false, error: 'full', detail: 'every stored annotation is marked worth reading' } as const;
      }
      await write({ epoch: current.epoch, records: applied.records });
      return { ok: true, record: applied.record, count: applied.records.length } as const;
    } catch (error) {
      return { ok: false, error: 'storage', detail: error instanceof Error ? error.message : String(error) } as const;
    }
  });
}

export function removeReviewRecord(
  epoch: number,
  sampleId: string,
  inputHash: string,
  rulesFingerprint: string,
): Promise<ReviewSaveResult> {
  return enqueue(async () => {
    try {
      const current = await read();
      if (current.epoch !== epoch) {
        return { ok: false, error: 'stale-epoch', detail: 'annotations were deleted since this page loaded them' } as const;
      }
      const records = removeRecord(current.records, sampleId, inputHash, rulesFingerprint);
      if (records.length !== current.records.length) await write({ epoch: current.epoch, records });
      return { ok: true, record: null, count: records.length } as const;
    } catch (error) {
      return { ok: false, error: 'storage', detail: error instanceof Error ? error.message : String(error) } as const;
    }
  });
}

/** Deletes every annotation and invalidates every save already in flight. */
export function clearReviewRecords(): Promise<number> {
  return enqueue(async () => {
    const current = await read();
    if (current.records.length === 0 && current.epoch === 0) {
      // Nothing was ever stored: still bump so an in-flight save is refused.
      await write({ epoch: 1, records: [] });
      return 1;
    }
    await write({ epoch: current.epoch + 1, records: [] });
    return current.epoch + 1;
  });
}

/** How many annotations are stored. Safe to call from any extension page. */
export async function loadReviewCount(): Promise<number> {
  return (await read()).records.length;
}

/** Fires when the stored annotations change, so a page can refresh its count. */
export function onReviewRecordsChanged(listener: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes[STORE_KEY]) listener();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
