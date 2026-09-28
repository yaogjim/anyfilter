import { MAX_LABEL_LENGTH, type Rule } from '../../domain/rule';

/** Rules are drafts until saved, so equality is used to know whether the board
 * has unsaved edits and whether Save should be enabled. */
export function rulesEqual(a: readonly Rule[], b: readonly Rule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Applies a patch to one rule, dropping an optional threshold entirely when the
 * editor turns the custom threshold off. */
export function withRule(
  rules: readonly Rule[],
  id: string,
  patch: Partial<Rule>,
): Rule[] {
  return rules.map((rule) => {
    if (rule.id !== id) return rule;
    const next: Rule = { ...rule, ...patch };
    if ('threshold' in patch && patch.threshold === undefined) delete next.threshold;
    return next;
  });
}

export function withoutRule(rules: readonly Rule[], id: string): Rule[] {
  return rules.filter((rule) => rule.id !== id);
}

function uniqueLabel(rules: readonly Rule[]): string {
  const taken = new Set(rules.map((rule) => rule.label.toLowerCase()));
  if (!taken.has('new rule')) return 'New rule';
  let n = 2;
  while (taken.has(`new rule ${n}`)) n += 1;
  return `New rule ${n}`;
}

function uniqueId(rules: readonly Rule[]): string {
  const taken = new Set(rules.map((rule) => rule.id));
  let id = `custom:${crypto.randomUUID()}`;
  while (taken.has(id)) id = `custom:${crypto.randomUUID()}`;
  return id;
}

/** A fresh custom semantic rule. `include` is intentionally empty so the editor
 * opens it ready to describe the rule; saving stays blocked until it is filled. */
export function newCustomRule(rules: readonly Rule[]): Rule {
  const label = uniqueLabel(rules).slice(0, MAX_LABEL_LENGTH);
  return {
    id: uniqueId(rules),
    label,
    source: 'custom',
    kind: 'semantic',
    enabled: true,
    include: '',
    exclude: '',
    examplesYes: [],
    examplesNo: [],
    scope: 'all',
  };
}