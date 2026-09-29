import { captureInputHash, observedStateJson, sampleIdFor } from './capture';
import type { ClassifyError } from './messages';
import type { Post } from './post';
import type { Rule } from './rule';
import { compileRuleQuestion, hasParent, ruleApplies } from './rule-compiler';
import type { Scores } from './verdict';

/**
 * The judgement snapshot behind the in-timeline review mode: what the feed
 * decided about one post, reduced to a state a person can read at a glance.
 *
 * It is derived from data the feed already holds (the scores of every rule), so
 * building one never costs a model request. It is a pure function of its input:
 * the caller supplies the clock and every fact about the post.
 */
export type ReviewState = 'kept' | 'flagged' | 'undecided';

export type UndecidedReason = 'pending' | 'failed' | 'missing-answer' | 'no-context';

export interface ReviewRuleView {
  ruleId: string;
  label: string;
  /** The provider's score for this rule; `null` for a local rule, a rule the
   * provider did not answer, or a post that was never scored. */
  score: number | null;
  /** The threshold this rule is actually judged against (its own, or the global
   * one). `null` for a local rule, which has no score to compare. */
  threshold: number | null;
  hit: boolean;
  /** A rule decided by page signals (the platform promoted marker), not a model. */
  local: boolean;
}

export interface ReviewSnapshot {
  sampleId: string;
  inputHash: string;
  /** The exact model input this snapshot was made for; what an annotation keeps. */
  stateJson: string;
  postId: string;
  threadId: string;
  state: ReviewState;
  undecidedReason?: UndecidedReason;
  rules: ReviewRuleView[];
  /** True when this post itself matched a rule. False for a post that is only
   * covered because another post in its thread was flagged. */
  direct: boolean;
  /** The person already put this flagged post back into the feed. */
  putBack: boolean;
  rulesFingerprint: string;
  at: number;
}

/** What the feed knows about a post, without the feed's private bookkeeping. */
export type ReviewJudgement =
  | { status: 'pending' }
  | { status: 'failed'; error: ClassifyError }
  /** `answered` is true only when the provider answered every question asked. */
  | { status: 'scored'; scores: Scores; answered: boolean }
  | { status: 'rule-only' };

export interface ReviewSnapshotInput {
  post: Post;
  judgement: ReviewJudgement;
  rules: readonly Rule[];
  /** The global threshold; a rule's own `threshold` takes precedence. */
  globalThreshold: number;
  /** True when the person put this post back into the feed. */
  putBack: boolean;
  /** True when some post of the thread is (still) flagged, which hides the
   * whole thread in normal mode. */
  threadFlagged: boolean;
  rulesFingerprint: string;
  at: number;
}

function validScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/** Per-rule view of one post: every enabled rule that applies to it. */
export function ruleViewsOf(
  post: Post,
  scores: Scores,
  rules: readonly Rule[],
  globalThreshold: number,
): ReviewRuleView[] {
  const withParent = hasParent(post);
  const views: ReviewRuleView[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !ruleApplies(rule, withParent)) continue;
    if (rule.kind === 'local') {
      views.push({
        ruleId: rule.id,
        label: rule.label,
        score: null,
        threshold: null,
        hit: post.promoted,
        local: true,
      });
      continue;
    }
    if (compileRuleQuestion(rule) === null) continue;
    const threshold = rule.threshold ?? globalThreshold;
    const score = validScore(scores[rule.id]);
    views.push({
      ruleId: rule.id,
      label: rule.label,
      score,
      threshold,
      hit: score !== null && score >= threshold,
      local: false,
    });
  }
  return views;
}

/** True when a `replies` rule applies but the parent text it must be judged
 * against has not been read yet. */
function missingParentContext(post: Post, rules: readonly Rule[]): boolean {
  if (post.kind !== 'reply') return false;
  if ((post.parent?.text ?? '') !== '') return false;
  return rules.some(
    (rule) => rule.enabled && rule.kind === 'semantic' && rule.scope === 'replies',
  );
}

/**
 * The snapshot for one post, or `null` when the post is not something the feed
 * judged (the person's own post, an empty body, a feed with no semantic rules).
 * Such a post is never shown as "kept": nothing was decided about it.
 *
 * A post is `kept` only when the provider answered every question and nothing
 * matched. "Nothing matched" alone is never enough, because a pending, failed or
 * partly answered judgement also has no matches.
 */
export function buildReviewSnapshot(input: ReviewSnapshotInput): ReviewSnapshot | null {
  const { post, judgement, rules, globalThreshold } = input;
  if (post.own) return null;
  const scores = judgement.status === 'scored' ? judgement.scores : {};
  const views = ruleViewsOf(post, scores, rules, globalThreshold);
  const hit = views.some((view) => view.hit);
  const stateJson = observedStateJson(post);
  const base = {
    sampleId: sampleIdFor(post),
    inputHash: captureInputHash(stateJson),
    stateJson,
    postId: post.id,
    threadId: post.thread,
    rules: views,
    rulesFingerprint: input.rulesFingerprint,
    at: input.at,
  };
  if (hit && input.putBack && !input.threadFlagged) {
    return { ...base, state: 'kept', direct: true, putBack: true };
  }
  if (hit) return { ...base, state: 'flagged', direct: true, putBack: false };
  if (input.threadFlagged) return { ...base, state: 'flagged', direct: false, putBack: false };
  if (judgement.status === 'rule-only') return null;
  if (judgement.status === 'pending') {
    return { ...base, state: 'undecided', undecidedReason: 'pending', direct: false, putBack: false };
  }
  if (judgement.status === 'failed') {
    return { ...base, state: 'undecided', undecidedReason: 'failed', direct: false, putBack: false };
  }
  if (!judgement.answered) {
    return {
      ...base,
      state: 'undecided',
      undecidedReason: 'missing-answer',
      direct: false,
      putBack: false,
    };
  }
  if (missingParentContext(post, rules)) {
    return {
      ...base,
      state: 'undecided',
      undecidedReason: 'no-context',
      direct: false,
      putBack: false,
    };
  }
  return { ...base, state: 'kept', direct: false, putBack: false };
}
