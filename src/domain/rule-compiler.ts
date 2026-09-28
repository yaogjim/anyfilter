import type { Post } from './post';
import { hashString, type Rule } from './rule';
import type { Scores } from './verdict';

/** Bumped whenever the compiled instruction format changes, so cached scores do
 * not get reused across an incompatible prompt shape. */
export const COMPILER_VERSION = 1;

/** Builds the single Jev question for one semantic rule. Built-in rules have no
 * exclude text or examples, so this returns their existing prompt verbatim. */
export function compileRuleQuestion(rule: Rule): string | null {
  if (rule.kind !== 'semantic') return null;
  const instructions = rule.include.trim();
  if (instructions === '') return null;
  const parts = [instructions];
  const exclude = rule.exclude.trim();
  if (exclude !== '') parts.push(`Answer no if: ${exclude}`);
  if (rule.examplesYes.length > 0) {
    parts.push(`Examples that should be answered yes:\n- ${rule.examplesYes.join('\n- ')}`);
  }
  if (rule.examplesNo.length > 0) {
    parts.push(`Examples that should be answered no:\n- ${rule.examplesNo.join('\n- ')}`);
  }
  return parts.join('\n\n');
}

export interface CompiledRules {
  questions: Record<string, string>;
  key: string;
}

/** Compiles every enabled semantic rule into the question map sent to the
 * provider and a fingerprint of that exact map. A `replies`-scoped rule is left
 * out when the caller has no parent context to judge it against, so the feed and
 * the preview never pay for a question that cannot apply. */
export function compileRules(
  rules: readonly Rule[],
  { hasParent = true }: { hasParent?: boolean } = {},
): CompiledRules {
  const questions: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleApplies(rule, hasParent)) continue;
    const question = compileRuleQuestion(rule);
    if (question !== null) questions[rule.id] = question;
  }
  return { questions, key: questionsFingerprint(questions) };
}

export function questionsFingerprint(questions: Record<string, string>): string {
  const canonical = JSON.stringify([
    COMPILER_VERSION,
    Object.entries(questions).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return hashString(canonical);
}

export function hasParent(post: Post): boolean {
  return post.parent !== null || post.kind === 'reply';
}

/** Programmatic scope check: a `replies` rule only applies when parent context
 * is actually available. */
export function ruleApplies(rule: Rule, withParent: boolean): boolean {
  return rule.scope === 'all' || withParent;
}

/** Matches the scores the provider returned against the compiled rules, keeping
 * only valid 0..1 numbers. Missing or invalid answers are left unmatched rather
 * than treated as a confident zero. */
export function matchedRuleScores(
  rules: readonly Rule[],
  scores: Scores,
  threshold: number,
  withParent: boolean,
): Map<string, number> {
  const matched = new Map<string, number>();
  for (const rule of rules) {
    if (!rule.enabled || rule.kind !== 'semantic') continue;
    if (!ruleApplies(rule, withParent)) continue;
    const score = scores[rule.id];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) continue;
    if (score < (rule.threshold ?? threshold)) continue;
    matched.set(rule.id, score);
  }
  return matched;
}