import {
  inputFromDraft,
  inputWithoutLabel,
  inputWithValuable,
  recordKey,
  snapshotKey,
  type ReviewActionResult,
  type ReviewAnnotationPort,
  type ReviewDraft,
  type ReviewLoadResult,
  type ReviewRecord,
  type ReviewSaveInput,
  type ReviewSaveResult,
} from '../domain/review-record';
import type { ReviewSnapshot } from '../domain/review';

/** The background operations the page relies on. */
export interface ReviewBackend {
  load(): Promise<ReviewLoadResult>;
  save(epoch: number, input: ReviewSaveInput): Promise<ReviewSaveResult>;
  remove(
    epoch: number,
    key: { sampleId: string; inputHash: string; rulesFingerprint: string },
  ): Promise<ReviewSaveResult>;
}

/**
 * The page's view of the stored annotations. It matches an annotation to a post
 * by the sample id, the input hash and the rule-set fingerprint, never by
 * position or colour, so a reused DOM node or an edited post never shows
 * another post's label.
 *
 * A change is shown only after the background confirmed it, so "labelled" on
 * screen always means "stored".
 */
export class ReviewAnnotations implements ReviewAnnotationPort {
  private epoch = 0;
  private readonly records = new Map<string, ReviewRecord>();

  private readonly backend: ReviewBackend;
  private readonly onChange: () => void;

  constructor(backend: ReviewBackend, onChange: () => void) {
    this.backend = backend;
    this.onChange = onChange;
  }

  /** Reads every stored annotation. False when the background could not be read. */
  async load(): Promise<boolean> {
    const result = await this.backend.load();
    if (!result.ok) return false;
    this.epoch = result.epoch;
    this.records.clear();
    for (const record of result.records) {
      this.records.set(
        recordKey(record.sampleId, record.inputHash, record.snapshot.rulesFingerprint),
        record,
      );
    }
    this.onChange();
    return true;
  }

  size(): number {
    return this.records.size;
  }

  labeledCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.overall !== null) count += 1;
    return count;
  }

  all(): ReviewRecord[] {
    return [...this.records.values()];
  }

  recordFor(snapshot: ReviewSnapshot): ReviewRecord | undefined {
    return this.records.get(snapshotKey(snapshot));
  }

  saveDraft(snapshot: ReviewSnapshot, draft: ReviewDraft): Promise<ReviewActionResult> {
    const existing = this.recordFor(snapshot);
    return this.commit(inputFromDraft(snapshot, draft, existing?.valuable ?? false));
  }

  setValuable(snapshot: ReviewSnapshot, valuable: boolean): Promise<ReviewActionResult> {
    const existing = this.recordFor(snapshot);
    if (!valuable && !existing) return Promise.resolve({ ok: true });
    if (!valuable && existing?.overall === null) return this.remove(snapshot);
    return this.commit(inputWithValuable(snapshot, existing, valuable));
  }

  removeLabel(snapshot: ReviewSnapshot): Promise<ReviewActionResult> {
    const existing = this.recordFor(snapshot);
    if (!existing) return Promise.resolve({ ok: true });
    const kept = inputWithoutLabel(existing);
    return kept ? this.commit(kept) : this.remove(snapshot);
  }

  private async commit(input: ReviewSaveInput | null): Promise<ReviewActionResult> {
    if (input === null) return { ok: false, error: 'no-input' };
    return this.settle(await this.backend.save(this.epoch, input));
  }

  private async remove(snapshot: ReviewSnapshot): Promise<ReviewActionResult> {
    const result = await this.backend.remove(this.epoch, {
      sampleId: snapshot.sampleId,
      inputHash: snapshot.inputHash,
      rulesFingerprint: snapshot.rulesFingerprint,
    });
    if (result.ok) this.records.delete(snapshotKey(snapshot));
    return this.settle(result);
  }

  private async settle(result: ReviewSaveResult): Promise<ReviewActionResult> {
    if (!result.ok) {
      // The store was deleted while this page was open: take the new epoch so a
      // retry can succeed, but keep what the person entered.
      if (result.error === 'stale-epoch') await this.load();
      return { ok: false, error: result.error };
    }
    if (result.record) {
      this.records.set(
        recordKey(result.record.sampleId, result.record.inputHash, result.record.snapshot.rulesFingerprint),
        result.record,
      );
    }
    this.onChange();
    return { ok: true };
  }
}
