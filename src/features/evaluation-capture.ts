import {
  captureSkipReason,
  emptyCaptureState,
  MAX_OBSERVATIONS_PER_MESSAGE,
  MAX_SAMPLES,
  sampleIdFor,
  xPageOf,
  type CaptureOutcome,
  type CaptureOutcomeReporter,
  type CaptureState,
  type CaptureSubmitResult,
} from '../domain/capture';
import type { ParentPost, Post } from '../domain/post';
import {
  readOwnHandle,
  readParentPost,
  readPost,
  readPostId,
  threadHeadOf,
  type ReadContext,
} from '../infrastructure/timeline-reader';

/**
 * Passive, read-only capture of already-loaded public posts.
 *
 * Boundaries, all enforced here rather than promised:
 *
 * - It reads the page and nothing else. Every helper it calls is a `read*`
 *   function from `timeline-reader`, and it never sets an attribute, a class or a
 *   style — so it can not hide a post, un-hide one, or make the feed's own
 *   bookkeeping stale. `TimelineView` is deliberately not used, because that
 *   class marks articles and animates hides.
 * - It is inert while the run state is not `active`: no observer is installed at
 *   all, so the default-off state costs nothing and reads nothing.
 * - It makes no network call and holds no key. It hands already-read posts to a
 *   submitter, which in production is one `chrome.runtime.sendMessage` to the
 *   background; the background re-checks everything before it writes.
 * - Own posts, text-less posts and protected placeholders are refused locally and
 *   never sent.
 */

const ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
const STATUS_PATH = /\/status\/(\d+)/;
/** Bounded memory for the "already handled" and "in flight" bookkeeping. */
const MAX_TRACKED = 2000;
/** One retry after a refused batch, so a static page is not lost. */
const RETRY_MS = 5000;

export type CaptureSubmitter = (epoch: number, posts: Post[]) => Promise<CaptureSubmitResult>;

interface Focal {
  readonly id: string;
  readonly article: Element | null;
}

export class PassiveCapture {
  private state: CaptureState = emptyCaptureState();
  private stopObserving: (() => void) | null = null;
  /** Identity of every post already accepted (or decided permanently ineligible)
   * in this page's lifetime, so a re-scan never resubmits and a delete is never
   * silently undone by the next scan. */
  private readonly sent = new Map<string, true>();
  private readonly inFlight = new Set<string>();
  private pending: Post[] = [];
  private submitting = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly submit: CaptureSubmitter;

  constructor(submit: CaptureSubmitter) {
    this.submit = submit;
  }

  /**
   * Applies an observed run state. Starting installs the read-only observer and
   * scans immediately; anything else removes the observer. A changed epoch means
   * a pause, a delete or a fresh start happened, so buffered work from the
   * previous epoch is dropped and the already-handled set is kept — that is what
   * stops a delete from being re-added by the next scan.
   */
  applyState(next: CaptureState): void {
    const epochChanged = next.epoch !== this.state.epoch;
    this.state = next;
    if (epochChanged) {
      // Deleting while a batch is queued must not make those same on-screen
      // posts eligible again on the next scan of this tab.
      for (const post of this.pending) this.remember(sampleIdFor(post));
      for (const key of this.inFlight) this.remember(key);
      this.pending = [];
      this.inFlight.clear();
    }
    if (next.runState === 'active') {
      this.observe();
      this.scan();
      return;
    }
    this.stop();
  }

  /** Stops observing without forgetting what was already handled. */
  stop(): void {
    this.stopObserving?.();
    this.stopObserving = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private observe(): void {
    if (this.stopObserving) return;
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        this.scan();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.stopObserving = () => observer.disconnect();
  }

  private scan(): void {
    if (this.state.runState !== 'active') return;
    if (xPageOf(location.href) === null) return;
    const focal = this.focal();
    // On a status page whose focal post has not rendered, reply context cannot be
    // derived. Reading those articles as top-level posts would mislabel them, so
    // this scan is skipped entirely until the page settles.
    if (focal !== null && focal.article === null) return;

    const ownHandle = readOwnHandle(document);
    // Without the account handle we cannot distinguish the user's own posts.
    // Fail closed until X renders account identity, rather than storing them.
    if (ownHandle === '') return;
    for (const article of document.querySelectorAll<HTMLElement>(ARTICLE_SELECTOR)) {
      const post = this.readArticle(article, ownHandle, focal);
      if (!post) continue;
      const key = sampleIdFor(post);
      if (this.sent.has(key) || this.inFlight.has(key) || this.pending.some((item) => sampleIdFor(item) === key)) continue;
      if (captureSkipReason(post) !== null) {
        this.remember(key);
        continue;
      }
      this.pending.push(post);
    }
    if (this.pending.length > MAX_SAMPLES) this.pending = this.pending.slice(-MAX_SAMPLES);
    void this.flush();
  }

  /** The read-only, structural mirror of the feed's own context derivation: the
   * focal post of a status page is the parent of every article rendered below
   * it, and articles above it are its ancestors, not replies. */
  private parentContextOf(article: Element, id: string, focal: Focal | null): ParentPost | null {
    if (focal === null || focal.article === null) return null;
    if (id === focal.id) return null;
    const precedesFocal =
      (article.compareDocumentPosition(focal.article) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return precedesFocal ? null : readParentPost(focal.article);
  }

  private readArticle(article: Element, ownHandle: string, focal: Focal | null): Post | null {
    const id = readPostId(article);
    if (id === '') return null;
    const parent = this.parentContextOf(article, id, focal);
    const context: ReadContext = {
      kind: parent ? 'reply' : 'post',
      parent,
      thread: parent ? '' : readPostId(threadHeadOf(article)),
      ownHandle,
    };
    return readPost(article, context);
  }

  private focal(): Focal | null {
    const id = location.pathname.match(STATUS_PATH)?.[1];
    if (id === undefined) return null;
    const article =
      Array.from(document.querySelectorAll(ARTICLE_SELECTOR)).find(
        (candidate) => readPostId(candidate) === id,
      ) ?? null;
    return { id, article };
  }

  private async flush(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    try {
      while (this.pending.length > 0 && this.state.runState === 'active') {
        const epoch = this.state.epoch;
        const batch = this.pending.slice(0, MAX_OBSERVATIONS_PER_MESSAGE);
        for (const post of batch) this.inFlight.add(sampleIdFor(post));
        let result: CaptureSubmitResult;
        try {
          result = await this.submit(epoch, batch);
        } catch (error) {
          result = {
            ok: false,
            error: 'storage',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        for (const post of batch) this.inFlight.delete(sampleIdFor(post));
        if (this.state.epoch === epoch) this.pending = this.pending.slice(batch.length);
        if (result.ok) {
          for (const post of batch) this.remember(sampleIdFor(post));
          continue;
        }
        // A refused batch is not retried in a tight loop. Whatever is still on
        // the page is re-observed by the scheduled retry or the next mutation.
        this.scheduleRetry();
        break;
      }
    } finally {
      this.submitting = false;
    }
  }

  private remember(key: string): void {
    this.sent.set(key, true);
    if (this.sent.size > MAX_TRACKED) {
      const oldest = this.sent.keys().next();
      if (!oldest.done) this.sent.delete(oldest.value);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scan();
    }, RETRY_MS);
  }
}

export type OutcomeSubmitter = (
  epoch: number,
  outcomes: readonly CaptureOutcome[],
) => Promise<CaptureSubmitResult>;

/**
 * Buffers the filtering outcomes the production feed observes and hands them to
 * the background in bounded batches.
 *
 * It reads nothing: the feed only calls it when capture is already active, and
 * the background re-checks the run state and the epoch before attaching anything.
 * Outcomes are keyed by sample, so a re-scan collapses into the latest
 * observation instead of queueing duplicates, and a refused batch is retried once
 * rather than dropped silently.
 *
 * A pause, a delete or a fresh start clears the buffer immediately, so a late
 * response for an older epoch can never attach an outcome to a sample the user
 * just deleted.
 */
export class PassiveOutcomeReporter implements CaptureOutcomeReporter {
  private state: CaptureState = emptyCaptureState();
  /** At most one pending outcome per sample: the newest observation wins. */
  private readonly pending = new Map<string, { epoch: number; outcome: CaptureOutcome }>();
  private readonly submit: OutcomeSubmitter;
  private submitting = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(submit: OutcomeSubmitter) {
    this.submit = submit;
  }

  /** Applies an observed run state. Anything other than the current active epoch
   * drops buffered work, which is what stops a delete from being undone. */
  applyState(next: CaptureState): void {
    if (next.runState !== 'active' || next.epoch !== this.state.epoch) this.drop();
    this.state = next;
  }

  captureEpoch(): number {
    return this.state.runState === 'active' ? this.state.epoch : 0;
  }

  reportOutcome(epoch: number, outcome: CaptureOutcome): void {
    if (this.state.runState !== 'active' || this.state.epoch !== epoch) return;
    this.pending.set(outcome.sampleId, { epoch, outcome });
    void this.flush();
  }

  stop(): void {
    this.drop();
  }

  private drop(): void {
    this.pending.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async flush(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    try {
      while (this.pending.size > 0 && this.state.runState === 'active') {
        const epoch = this.state.epoch;
        const batch = [...this.pending.values()]
          .filter((entry) => entry.epoch === epoch)
          .slice(0, MAX_OBSERVATIONS_PER_MESSAGE);
        if (batch.length === 0) return;
        let result: CaptureSubmitResult;
        try {
          result = await this.submit(epoch, batch.map((entry) => entry.outcome));
        } catch (error) {
          result = {
            ok: false,
            error: 'storage',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        // The state may have moved while the batch was in flight. If it did, the
        // buffer was already dropped and nothing from it may be re-added.
        if (this.state.runState !== 'active' || this.state.epoch !== epoch) {
          this.drop();
          return;
        }
        if (!result.ok) {
          this.scheduleRetry();
          return;
        }
        for (const entry of batch) {
          if (this.pending.get(entry.outcome.sampleId) === entry) {
            this.pending.delete(entry.outcome.sampleId);
          }
        }
      }
    } finally {
      this.submitting = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, RETRY_MS);
  }
}