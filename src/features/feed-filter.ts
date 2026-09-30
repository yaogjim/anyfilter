import {
  captureInputHash,
  observedStateJson,
  sampleIdFor,
  type CaptureOutcome,
  type CaptureOutcomeDetail,
  type CaptureOutcomeReporter,
  type CaptureOutcomeStage,
  type CaptureOutcomeStatus,
  type CaptureThreadAction,
} from '../domain/capture';
import type { ClassifierPort } from '../domain/classifier-port';
import { isValidScore } from '../domain/evaluation';
import type { ClassifyError } from '../domain/messages';
import { postContentKey, postSource, samePostContent, type Post } from '../domain/post';
import { buildReviewSnapshot, type ReviewJudgement } from '../domain/review';
import type { Rule } from '../domain/rule';
import {
  COMPILER_VERSION,
  compileRules,
  hasParent,
  type CompiledRules,
} from '../domain/rule-compiler';
import { activeKey, type Settings } from '../domain/settings';
import type { TimelineView } from '../domain/timeline-view';
import { matchRuleReasons, type Reason, type Scores } from '../domain/verdict';
import type { VerdictSink } from '../domain/verdict-sink';
import { loadOverrides, saveOverrides } from '../infrastructure/override-store';

type KnownPost =
  | { status: 'pending'; post: Post }
  | { status: 'scored'; post: Post; scores: Scores; reasons: Reason[]; questionsKey: string }
  | { status: 'rule-only'; post: Post; reasons: Reason[] }
  | { status: 'failed'; post: Post; error: ClassifyError };

const RETRYABLE_ERRORS: readonly ClassifyError[] = ['rate-limited', 'network'];

function sameReasons(a: Reason[], b: Reason[]): boolean {
  return a.length === b.length && a.every((reason, i) => reason.categoryId === b[i].categoryId);
}

/**
 * True only when the provider answered every question the feed asked. A question
 * it left out is not a decision about the post, so a partially answered reply may
 * never be reported as a kept `no-match` that a later phase could read as a real
 * negative. The classifier accepts such a partial answer and drops the missing
 * id, so the check has to happen here.
 */
export function everyQuestionAnswered(
  questions: Record<string, string>,
  scores: Scores,
): boolean {
  return Object.keys(questions).every((id) => isValidScore(scores[id]));
}

export class FeedFilter {
  private settings: Settings;
  private readonly view: TimelineView;
  private readonly classifier: ClassifierPort;
  private readonly sink: VerdictSink;
  /** Optional. `null` (or a reporter whose `captureEpoch` is `0`) makes every
   * outcome report a no-op, so production filtering is unchanged. */
  private readonly outcomes: CaptureOutcomeReporter | null;
  private rules: Rule[] = [];
  /** Question set for a post whose parent context is available (every enabled rule). */
  private compiledWithParent: CompiledRules = compileRules([]);
  /** Question set for a post with no parent context, which drops `replies` rules. */
  private compiledWithoutParent: CompiledRules = compileRules([]);
  /** Fingerprint of the full rule set; used to mark articles as already processed. */
  private questionsKey = '';
  private readonly known = new Map<string, KnownPost>();
  private readonly threads = new Map<string, Set<string>>();
  private readonly overrides = new Map<string, boolean>();
  private readonly awaitingAvatar = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Review mode keeps every post visible and draws the judgement on it instead
   * of hiding. It lives in memory only and is never a setting. */
  private reviewMode = false;
  private stopObserving: (() => void) | null = null;
  /** Bumped on every settings change or stop so late responses from an older
   * configuration are discarded instead of being applied to the new one. */
  private generation = 0;
  /** One counter per post id. A newer judgement for the same id bumps it, so an
   * older in-flight response can never overwrite the newer task's result when a
   * DOM cell is reused or a post is edited mid-flight. */
  private readonly attempts = new Map<string, number>();

  constructor(
    view: TimelineView,
    classifier: ClassifierPort,
    sink: VerdictSink,
    settings: Settings,
    outcomes: CaptureOutcomeReporter | null = null,
  ) {
    this.view = view;
    this.classifier = classifier;
    this.sink = sink;
    this.settings = settings;
    this.outcomes = outcomes;
    this.deriveQuestions();
  }

  /** Loads persisted "put back in feed" choices before the first scan. */
  async hydrate(): Promise<void> {
    const stored = await loadOverrides();
    for (const [postId, shown] of stored) this.overrides.set(postId, shown);
  }

  start(): void {
    this.stopObserving = this.view.onChange(() => this.scan());
    this.scan();
  }

  stop(): void {
    if (this.reviewMode) this.clearDecorations();
    this.generation += 1;
    this.stopObserving?.();
    this.stopObserving = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Drops all local knowledge after a data clear: every in-flight task is
   * invalidated (a bump of the generation makes its response a no-op) and the
   * cached scores, overrides and reasons are forgotten. Nothing is re-scanned
   * here, so a cleared panel stays empty instead of being immediately refilled. */
  clear(): void {
    if (this.reviewMode) this.clearDecorations();
    this.generation += 1;
    this.attempts.clear();
    this.known.clear();
    this.threads.clear();
    this.overrides.clear();
    this.awaitingAvatar.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  applySettings(next: Settings): void {
    const previous = this.settings;
    this.settings = next;
    this.generation += 1;
    this.deriveQuestions();
    const credentialsChanged =
      activeKey(previous) !== activeKey(next) || previous.provider !== next.provider;
    this.forgetPending();
    if (credentialsChanged) this.forgetFailed(() => true);
    this.reapply();
    this.scan();
  }

  isReviewMode(): boolean {
    return this.reviewMode;
  }

  /**
   * Switches review mode. Turning it on shows every post and draws what the feed
   * decided about each one; turning it off clears the drawing and hides flagged
   * posts again exactly as the settings say. Neither direction asks the provider
   * anything or changes a setting: the decisions come from scores already held.
   */
  setReviewMode(on: boolean): void {
    if (on === this.reviewMode) return;
    this.reviewMode = on;
    if (on) {
      for (const postId of this.known.keys()) this.apply(postId, false);
      return;
    }
    this.clearDecorations();
    this.reapply();
  }

  private clearDecorations(): void {
    for (const postId of this.known.keys()) this.view.clearDecoration(postId);
  }

  override(postId: string, shown: boolean): void {
    this.overrides.set(postId, shown);
    void saveOverrides(this.overrides).catch(() => undefined);
    this.apply(postId, true);
  }

  private deriveQuestions(): void {
    this.rules = this.settings.rules;
    this.compiledWithParent = compileRules(this.rules);
    this.compiledWithoutParent = compileRules(this.rules, { hasParent: false });
    this.questionsKey = this.compiledWithParent.key;
  }

  /** Picks the question set that matches the parent context a post actually has,
   * so a `replies` rule is never asked about without a parent to judge it by. */
  private compiledFor(post: Post): CompiledRules {
    return hasParent(post) ? this.compiledWithParent : this.compiledWithoutParent;
  }

  private reasonsFor(post: Post, scores: Scores): Reason[] {
    return matchRuleReasons(post, scores, this.rules, this.settings.threshold);
  }

  private scan(): void {
    if (!this.settings.filterOn) return;
    for (const post of this.view.scan(this.questionsKey)) {
      this.remember(post);
      const known = this.known.get(post.id);
      const questionsChanged =
        known?.status === 'scored' && known.questionsKey !== this.compiledFor(post).key;
      const contentChanged =
        known !== undefined && known.status !== 'pending' && !samePostContent(known.post, post);
      if (!known || questionsChanged || contentChanged) {
        void this.evaluate(post);
        continue;
      }
      this.apply(post.id, false);
    }
    this.refreshAvatars();
  }

  private refreshAvatars(): void {
    for (const postId of this.awaitingAvatar) {
      const known = this.known.get(postId);
      if (!known || (known.status !== 'scored' && known.status !== 'rule-only')) {
        this.awaitingAvatar.delete(postId);
        continue;
      }
      const latest = this.view.read(postId);
      if (!latest || latest.avatarUrl === '') continue;
      known.post = latest;
      this.awaitingAvatar.delete(postId);
      this.sink.report(latest, known.reasons, 0);
    }
  }

  private report(post: Post, reasons: Reason[], tokens: number): void {
    this.sink.report(post, reasons, tokens);
    // Only X posts have an avatar to wait for.
    if (reasons.length > 0 && post.avatarUrl === '' && postSource(post) === 'x') {
      this.awaitingAvatar.add(post.id);
    }
  }

  private async evaluate(post: Post): Promise<void> {
    const generation = this.generation;
    const attempt = (this.attempts.get(post.id) ?? 0) + 1;
    this.attempts.set(post.id, attempt);
    const compiled = this.compiledFor(post);
    // Locked once per judgement, then re-checked before each report. A pause, a
    // resume or a delete that lands while the request is in flight bumps the
    // capture epoch; this result then belongs to the run it started in and must
    // not be reported under the new epoch.
    const captureEpoch = this.captureEpoch();
    // The threshold in force for this judgement, read once like the epoch, so
    // every outcome of this judgement records the configuration that actually
    // produced its decision instead of whatever a later settings change left
    // behind.
    const threshold = this.settings.threshold;
    if (post.own) {
      this.known.set(post.id, { status: 'rule-only', post, reasons: [] });
      this.view.show(post.id);
      this.observeOutcome(captureEpoch, post, {
        stage: 'rule-only',
        status: 'no-match',
        detail: 'own',
        reasons: [],
        threadAction: 'shown',
        textDecidable: false,
        rulesFingerprint: compiled.key,
        threshold,
      });
      return;
    }
    if (post.promoted || post.text === '') {
      const reasons = this.reasonsFor(post, {});
      this.known.set(post.id, { status: 'rule-only', post, reasons });
      const threadAction = this.apply(post.id, true);
      this.report(post, this.reasonsOf(post.id), 0);
      this.observeOutcome(captureEpoch, post, {
        stage: 'rule-only',
        status: reasons.length > 0 ? 'match' : 'no-match',
        detail: 'empty-or-promoted',
        reasons,
        threadAction,
        // The feed never asked a text-decided rule about this post, so a keep is
        // not a negative for one.
        textDecidable: false,
        rulesFingerprint: compiled.key,
        threshold,
      });
      return;
    }
    // No enabled semantic rules (or none that can apply without a parent): there
    // is nothing to ask the provider, so keep the post local-only and free.
    if (Object.keys(compiled.questions).length === 0) {
      this.known.set(post.id, { status: 'rule-only', post, reasons: [] });
      const threadAction = this.apply(post.id, true);
      this.observeOutcome(captureEpoch, post, {
        stage: 'rule-only',
        status: 'no-match',
        detail: 'no-semantic-rules',
        reasons: [],
        threadAction,
        textDecidable: false,
        rulesFingerprint: compiled.key,
        threshold,
      });
      return;
    }
    this.known.set(post.id, { status: 'pending', post });
    this.drawWhileReviewing(post.id);
    const questionsKey = compiled.key;
    this.observeOutcome(captureEpoch, post, {
      stage: 'pending',
      status: 'undecided',
      detail: 'pending',
      reasons: [],
      threadAction: 'none',
      textDecidable: true,
      rulesFingerprint: questionsKey,
      threshold,
    });
    const result = await this.classifier.classify(post, compiled.questions, questionsKey);
    // A newer judgement for this id, or a data clear / settings change, makes this
    // response obsolete: it must not touch the panel, the cache or the DOM.
    if (generation !== this.generation || this.attempts.get(post.id) !== attempt) return;
    if (!result.ok) {
      this.known.set(post.id, { status: 'failed', post, error: result.error });
      this.drawWhileReviewing(post.id);
      const retryable = RETRYABLE_ERRORS.includes(result.error);
      if (retryable) this.scheduleRetry();
      this.observeOutcome(captureEpoch, post, {
        stage: 'failed',
        status: 'error',
        detail: retryable ? 'failed-retryable' : 'failed-terminal',
        reasons: [],
        threadAction: 'none',
        textDecidable: true,
        rulesFingerprint: questionsKey,
        threshold,
      });
      return;
    }
    const latest = this.view.read(post.id) ?? post;
    const reasons = this.reasonsFor(latest, result.scores);
    this.known.set(post.id, {
      status: 'scored',
      post: latest,
      scores: result.scores,
      reasons,
      questionsKey,
    });
    const threadAction = this.apply(post.id, true);
    this.report(latest, reasons, result.tokens);
    // The outcome describes the exact input that was sent for judgement, never a
    // later DOM re-read: the stored sample it may pair with is keyed on that same
    // text, so re-using `latest` here could make another text claim this result.
    const judgedReasons = samePostContent(post, latest)
      ? reasons
      : this.reasonsFor(post, result.scores);
    // A question the provider left unanswered is not a decision about the post,
    // so only a fully answered question set may be reported as a kept `no-match`.
    const allAnswered = everyQuestionAnswered(compiled.questions, result.scores);
    this.observeOutcome(captureEpoch, post, {
      stage: 'scored',
      status: judgedReasons.length > 0 ? 'match' : allAnswered ? 'no-match' : 'undecided',
      detail: 'scored',
      reasons: judgedReasons,
      threadAction,
      textDecidable: true,
      rulesFingerprint: questionsKey,
      threshold,
    });
  }

  /**
   * The capture epoch in force when a judgement starts, or `0` when observation
   * is off. Read once per judgement so every report of that judgement is stamped
   * with the same run and can be dropped if the run ended meanwhile.
   */
  private captureEpoch(): number {
    return this.outcomes?.captureEpoch() ?? 0;
  }

  /**
   * Reports what the feed actually did with one post, so an already-captured
   * sample can be paired with a real current outcome.
   *
   * `captureEpoch` is the epoch captured when this judgement started. The report
   * is made only while that run is still the current one: a pause, a resume or a
   * delete since then raises a new epoch, and this result is dropped instead of
   * being presented as an observation of the new run.
   *
   * `post` must be the exact snapshot that was judged: every identity field of
   * the outcome (sample id, input and content fingerprints, parent and truncation
   * flags) is derived from it, so a later re-read of the DOM can never make a
   * different text claim this result.
   *
   * This is purely observational. It is skipped entirely unless a reporter exists
   * and says capture is active, it never awaits, and it cannot touch the DOM, the
   * panel, the cache, a rule or a setting — so production filtering semantics are
   * exactly what they were before it was added.
   */
  private observeOutcome(
    captureEpoch: number,
    post: Post,
    options: {
      readonly stage: CaptureOutcomeStage;
      readonly status: CaptureOutcomeStatus;
      readonly detail: CaptureOutcomeDetail;
      readonly reasons: readonly Reason[];
      readonly threadAction: CaptureThreadAction;
      readonly textDecidable: boolean;
      readonly rulesFingerprint: string;
      readonly threshold: number;
    },
  ): void {
    const reporter = this.outcomes;
    if (!reporter || captureEpoch === 0) return;
    // Observation must still be the run this judgement started in.
    if (reporter.captureEpoch() !== captureEpoch) return;
    const matchedRuleIds = options.reasons.map((reason) => reason.categoryId);
    const outcome: CaptureOutcome = {
      sampleId: sampleIdFor(post),
      postId: post.id,
      threadId: post.thread,
      inputHash: captureInputHash(observedStateJson(post)),
      contentKey: postContentKey(post),
      rulesFingerprint: options.rulesFingerprint,
      compilerVersion: COMPILER_VERSION,
      threshold: options.threshold,
      stage: options.stage,
      status: options.status,
      detail: options.detail,
      matchedRuleIds,
      keepReasons: options.reasons.length > 0 && this.overrides.get(post.id) === true
        ? matchedRuleIds
        : [],
      hasParent: hasParent(post),
      textDecidable: options.textDecidable,
      threadAction: options.threadAction,
      threadSize: [...this.threadOf(post.id)].length,
      scoreTruncated: post.truncated,
      at: Date.now(),
    };
    reporter.reportOutcome(captureEpoch, outcome);
  }

  private reasonsOf(postId: string): Reason[] {
    const known = this.known.get(postId);
    return known && (known.status === 'scored' || known.status === 'rule-only')
      ? known.reasons
      : [];
  }

  private remember(post: Post): void {
    const members = this.threads.get(post.thread) ?? new Set<string>();
    members.add(post.id);
    this.threads.set(post.thread, members);
  }

  private threadOf(postId: string): Iterable<string> {
    const thread = this.known.get(postId)?.post.thread;
    return (thread && this.threads.get(thread)) ?? [postId];
  }

  private flagged(postId: string): boolean {
    return this.reasonsOf(postId).length > 0 && this.overrides.get(postId) !== true;
  }

  /**
   * Applies the current visibility of one post and its thread. Returns the action
   * taken for `postId` itself, so an outcome report can say what actually
   * happened without re-deriving the decision.
   */
  private apply(postId: string, animate: boolean): CaptureThreadAction {
    const members = [...this.threadOf(postId)];
    const threadFlagged = this.settings.filterOn && members.some((member) => this.flagged(member));
    if (this.reviewMode) {
      // Nothing is hidden while reviewing, so the reported action is `shown`.
      for (const member of members) {
        this.view.show(member);
        this.decorate(member, threadFlagged);
      }
      return 'shown';
    }
    const shouldHide = threadFlagged;
    for (const member of members) {
      if (shouldHide && !this.known.get(member)?.post.own) this.view.hide(member, animate);
      else this.view.show(member);
    }
    const own = this.known.get(postId)?.post.own ?? false;
    return shouldHide && !own ? 'hidden' : 'shown';
  }

  /** A pending or failed post is never hidden, so normal mode has nothing to do
   * for it; review mode still has to show its amber "undecided" state. */
  private drawWhileReviewing(postId: string): void {
    if (this.reviewMode) this.apply(postId, false);
  }

  /** Draws (or clears) the review decoration of one post from what the feed
   * already knows about it. */
  private decorate(postId: string, threadFlagged: boolean): void {
    const known = this.known.get(postId);
    if (!known || !this.settings.filterOn) {
      this.view.clearDecoration(postId);
      return;
    }
    const post = known.post;
    const judgement: ReviewJudgement =
      known.status === 'scored'
        ? {
            status: 'scored',
            scores: known.scores,
            answered: everyQuestionAnswered(this.compiledFor(post).questions, known.scores),
          }
        : known.status === 'failed'
          ? { status: 'failed', error: known.error }
          : { status: known.status };
    const snapshot = buildReviewSnapshot({
      post,
      judgement,
      rules: this.rules,
      globalThreshold: this.settings.threshold,
      putBack: this.overrides.get(postId) === true,
      threadFlagged,
      rulesFingerprint: this.compiledFor(post).key,
      at: Date.now(),
    });
    if (snapshot) this.view.decorate(postId, snapshot);
    else this.view.clearDecoration(postId);
  }

  private reapply(): void {
    for (const [postId, known] of this.known) {
      if (known.status === 'scored' || known.status === 'rule-only') {
        const scores = known.status === 'scored' ? known.scores : {};
        const reasons = this.reasonsFor(known.post, scores);
        if (!sameReasons(reasons, known.reasons)) {
          known.reasons = reasons;
          this.report(known.post, reasons, 0);
        }
      }
      this.apply(postId, true);
    }
  }

  private forgetPending(): void {
    for (const [postId, known] of this.known) {
      if (known.status === 'pending') {
        this.known.delete(postId);
        this.view.unmark(postId);
      }
    }
  }

  private forgetFailed(matches: (error: ClassifyError) => boolean): void {
    for (const [postId, known] of this.known) {
      if (known.status === 'failed' && matches(known.error)) {
        this.known.delete(postId);
        this.view.unmark(postId);
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.forgetFailed((error) => RETRYABLE_ERRORS.includes(error));
      this.scan();
    }, 25_000);
  }
}