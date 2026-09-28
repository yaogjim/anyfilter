import {
  validateRules,
  type PreviewInput,
  type PreviewResult,
  type PreviewRuleResult,
} from '../domain/rule';
import { compileRules } from '../domain/rule-compiler';
import { classifyText } from './classifier';

function previewState(input: PreviewInput): Record<string, unknown> {
  const state: Record<string, unknown> = { text: input.text };
  const name = input.name ?? '';
  const handle = input.handle ?? '';
  if (name !== '' || handle !== '') {
    state.author = { handle: handle === '' ? '' : `@${handle}`, name };
  }
  if (input.quotedText) state.quoted = input.quotedText;
  if (input.parentText) state.replyingTo = { author: '', text: input.parentText };
  return state;
}

function thresholdOf(value: number): number {
  return typeof value === 'number' && value > 0 && value <= 1 ? value : 0.7;
}

/** Text preview: compiles the draft rules with the same compiler as the feed and
 * runs them through the provider without touching the panel, cache, or DOM. */
export async function previewRules(input: PreviewInput): Promise<PreviewResult> {
  const validation = validateRules(input.rules);
  if (!validation.ok) return { ok: false, error: 'invalid', detail: validation.detail };
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    return { ok: false, error: 'invalid', detail: 'text is required' };
  }

  const threshold = thresholdOf(input.threshold);
  const hasParent = typeof input.parentText === 'string' && input.parentText.trim() !== '';
  const compiled = compileRules(validation.rules, { hasParent });
  const outcome = await classifyText(previewState(input), compiled.questions);

  const results: PreviewRuleResult[] = validation.rules.map((rule) => {
    const ruleThreshold = rule.threshold ?? threshold;
    const base = { id: rule.id, label: rule.label, threshold: ruleThreshold };
    if (!rule.enabled || rule.kind === 'local' || (rule.scope === 'replies' && !hasParent)) {
      return { ...base, status: 'not-applicable' };
    }
    if (!outcome.ok) return { ...base, status: 'unavailable' };
    const score = outcome.scores[rule.id];
    if (typeof score !== 'number') return { ...base, status: 'unavailable' };
    return { ...base, score, status: score >= ruleThreshold ? 'match' : 'no-match' };
  });

  if (!outcome.ok) return { ok: false, error: outcome.error, detail: outcome.detail };
  return outcome.model === ''
    ? { ok: true, results, tokens: outcome.tokens }
    : { ok: true, results, tokens: outcome.tokens, model: outcome.model };
}