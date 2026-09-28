import type { ClassifierPort } from '../domain/classifier-port';
import type { ClassifyError } from '../domain/messages';
import { samePostContent, type Post } from '../domain/post';
import type { Rule } from '../domain/rule';
import { compileRules, hasParent, type CompiledRules } from '../domain/rule-compiler';
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

export class FeedFilter {
  private settings: Settings;
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
  private stopObserving: (() => void) | null = null;
  /** Bumped on every settings change or stop so late responses from an older
   * configuration are discarded instead of being applied to the new one. */
  private generation = 0;
  /** One counter per post id. A newer judgement for the same id bumps it, so an
   * older in-flight response can never overwrite the newer task's result when a
   * DOM cell is reused or a post is edited mid-flight. */
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly view: TimelineView,
    private readonly classifier: ClassifierPort,
    private readonly sink: VerdictSink,
    settings: Settings,
  ) {
    this.settings = settings;
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
    if (reasons.length > 0 && post.avatarUrl === '') this.awaitingAvatar.add(post.id);
  }

  private async evaluate(post: Post): Promise<void> {
    const generation = this.generation;
    const attempt = (this.attempts.get(post.id) ?? 0) + 1;
    this.attempts.set(post.id, attempt);
    if (post.own) {
      this.known.set(post.id, { status: 'rule-only', post, reasons: [] });
      this.view.show(post.id);
      return;
    }
    if (post.promoted || post.text === '') {
      this.known.set(post.id, { status: 'rule-only', post, reasons: this.reasonsFor(post, {}) });
      this.apply(post.id, true);
      this.report(post, this.reasonsOf(post.id), 0);
      return;
    }
    // No enabled semantic rules (or none that can apply without a parent): there
    // is nothing to ask the provider, so keep the post local-only and free.
    const compiled = this.compiledFor(post);
    if (Object.keys(compiled.questions).length === 0) {
      this.known.set(post.id, { status: 'rule-only', post, reasons: [] });
      this.apply(post.id, true);
      return;
    }
    this.known.set(post.id, { status: 'pending', post });
    const questionsKey = compiled.key;
    const result = await this.classifier.classify(post, compiled.questions, questionsKey);
    // A newer judgement for this id, or a data clear / settings change, makes this
    // response obsolete: it must not touch the panel, the cache or the DOM.
    if (generation !== this.generation || this.attempts.get(post.id) !== attempt) return;
    if (!result.ok) {
      this.known.set(post.id, { status: 'failed', post, error: result.error });
      if (RETRYABLE_ERRORS.includes(result.error)) this.scheduleRetry();
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
    this.apply(post.id, true);
    this.report(latest, reasons, result.tokens);
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

  private apply(postId: string, animate: boolean): void {
    const members = [...this.threadOf(postId)];
    const shouldHide = this.settings.filterOn && members.some((member) => this.flagged(member));
    for (const member of members) {
      if (shouldHide && !this.known.get(member)?.post.own) this.view.hide(member, animate);
      else this.view.show(member);
    }
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