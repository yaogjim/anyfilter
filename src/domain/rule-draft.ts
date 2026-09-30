import { MAX_LABEL_LENGTH, parseRule, type Rule, type RuleScope } from './rule';
import { groupNameKey, MAX_GROUP_NAME_LENGTH, MAX_GROUPS } from './rule-group';
import { hasUnsafeChars } from './safe-text';

/**
 * A rule drafted by the helper model from a plain-language requirement.
 *
 * Everything here is pure. The model's answer is untrusted text: it is read into
 * a candidate rule and handed to the same `parseRule` that guards a save, so the
 * length, example-count and control-character limits are the existing ones and
 * not a second copy. The draft only ever fills the editor; it is never stored.
 */

/** Longest requirement a person may send. */
export const MAX_REQUIREMENT_LENGTH = 600;

/** The output budget of one drafting request. Reasoning is switched off, so this
 * is the whole bill for the answer. */
export const GENERATE_MAX_OUTPUT_TOKENS = 1200;

export interface GenerateRuleInput {
  /** What the person wants filtered, in their own words. */
  requirement: string;
  /** The categories the draft may pick from, as the person sees them. */
  groupNames: string[];
}

export interface GeneratedRuleDraft {
  label: string;
  /** An existing category, spelled exactly as it was offered. */
  groupName?: string;
  /** A category that does not exist yet. At most one of the two is set. */
  newGroupName?: string;
  include: string;
  exclude: string;
  examplesYes: string[];
  examplesNo: string[];
  scope: RuleScope;
}

export type GenerateRuleError = 'no-key' | 'auth' | 'rate-limited' | 'network' | 'bad-response' | 'invalid';

export type GenerateRuleResult =
  | { ok: true; draft: GeneratedRuleDraft; model: string }
  | { ok: false; error: GenerateRuleError; detail: string };

const GENERATE_ERRORS: readonly GenerateRuleError[] = [
  'no-key',
  'auth',
  'rate-limited',
  'network',
  'bad-response',
  'invalid',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** What a requirement must be before anything is sent: something to say, no longer
 * than the cap, and free of characters that hide or reorder text. */
export function requirementProblem(requirement: string): 'empty' | 'too-long' | 'unsafe' | null {
  if (requirement.trim() === '') return 'empty';
  if (requirement.length > MAX_REQUIREMENT_LENGTH) return 'too-long';
  if (hasUnsafeChars(requirement, true)) return 'unsafe';
  return null;
}

export function isGenerateRuleInput(value: unknown): value is GenerateRuleInput {
  const record = asRecord(value);
  if (!record || typeof record.requirement !== 'string') return false;
  if (requirementProblem(record.requirement) !== null) return false;
  if (!isStringArray(record.groupNames) || record.groupNames.length > MAX_GROUPS) return false;
  return record.groupNames.every((name) => name.length <= MAX_GROUP_NAME_LENGTH && !hasUnsafeChars(name));
}

function isDraft(value: unknown): value is GeneratedRuleDraft {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.label !== 'string' || typeof record.include !== 'string') return false;
  if (typeof record.exclude !== 'string') return false;
  if (!isStringArray(record.examplesYes) || !isStringArray(record.examplesNo)) return false;
  if (record.scope !== 'all' && record.scope !== 'replies') return false;
  if (record.groupName !== undefined && typeof record.groupName !== 'string') return false;
  if (record.newGroupName !== undefined && typeof record.newGroupName !== 'string') return false;
  return true;
}

export function isGenerateRuleResult(value: unknown): value is GenerateRuleResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) return isDraft(record.draft) && typeof record.model === 'string';
  return (
    record.ok === false &&
    GENERATE_ERRORS.some((error) => error === record.error) &&
    typeof record.detail === 'string'
  );
}

export type ParsedDraft = { ok: true; draft: GeneratedRuleDraft } | { ok: false; detail: string };

function trimmedList(value: unknown): string[] | null {
  if (!isStringArray(value)) return null;
  // A blank line is noise from the model, not an example.
  return value.map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * Reads the model's JSON answer into a draft. `knownGroupNames` are the
 * categories that were offered; a `group` that matches one (ignoring case and
 * space) becomes `groupName`, any other non-empty one becomes `newGroupName`.
 *
 * Anything that is not exactly the asked-for shape, or that `parseRule` would
 * refuse, is an error. Nothing is repaired by guessing.
 */
export function parseGeneratedDraft(raw: string | undefined, knownGroupNames: readonly string[]): ParsedDraft {
  if (raw === undefined) return { ok: false, detail: 'the model returned no text' };
  let body = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, detail: 'the answer was not valid JSON' };
  }
  const record = asRecord(parsed);
  if (!record) return { ok: false, detail: 'the answer was not a JSON object' };

  const yes = trimmedList(record.examplesYes ?? []);
  const no = trimmedList(record.examplesNo ?? []);
  if (typeof record.label !== 'string' || typeof record.include !== 'string') {
    return { ok: false, detail: 'the answer needs a label and a condition' };
  }
  if (yes === null || no === null) return { ok: false, detail: 'examples must be lists of text' };
  if (record.exclude !== undefined && typeof record.exclude !== 'string') {
    return { ok: false, detail: 'the exceptions must be text' };
  }
  if (record.scope !== undefined && record.scope !== 'all' && record.scope !== 'replies') {
    return { ok: false, detail: 'the scope must be all or replies' };
  }
  if (record.group !== undefined && record.group !== null && typeof record.group !== 'string') {
    return { ok: false, detail: 'the category must be text' };
  }

  const candidate: Rule = {
    id: 'custom:draft',
    label: record.label.trim(),
    source: 'custom',
    kind: 'semantic',
    enabled: true,
    include: record.include.trim(),
    exclude: typeof record.exclude === 'string' ? record.exclude.trim() : '',
    examplesYes: yes,
    examplesNo: no,
    scope: record.scope === 'replies' ? 'replies' : 'all',
  };
  const checked = parseRule(candidate);
  if (!checked.ok) return { ok: false, detail: checked.detail };

  const draft: GeneratedRuleDraft = {
    label: checked.rule.label,
    include: checked.rule.include,
    exclude: checked.rule.exclude,
    examplesYes: checked.rule.examplesYes,
    examplesNo: checked.rule.examplesNo,
    scope: checked.rule.scope,
  };

  const group = typeof record.group === 'string' ? record.group.trim() : '';
  if (group !== '') {
    const known = knownGroupNames.find((name) => groupNameKey(name) === groupNameKey(group));
    if (known !== undefined) draft.groupName = known;
    else if (group.length <= MAX_GROUP_NAME_LENGTH && !hasUnsafeChars(group)) draft.newGroupName = group;
    // A category name that cannot be kept is dropped rather than failing a draft
    // that is otherwise good: the person picks the category by hand.
  }
  return { ok: true, draft };
}

/** `base`, or `base 2`, `base 3`... so a generated name never collides with a
 * rule that is already there (a save would be refused for a repeated name). */
export function uniqueRuleLabel(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()));
  const root = base.trim().slice(0, MAX_LABEL_LENGTH);
  if (!used.has(root.toLowerCase())) return root;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${root.slice(0, MAX_LABEL_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
