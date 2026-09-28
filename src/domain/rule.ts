import { BUILT_IN_CATEGORIES } from './category';
import type { Settings } from './settings';

export type RuleSource = 'builtin' | 'custom';
export type RuleKind = 'local' | 'semantic';
export type RuleScope = 'all' | 'replies';

/**
 * A single editable filter rule. Custom and built-in rules share one shape so the
 * UI can use a single editor. `kind: 'local'` rules are decided by page signals
 * (currently only the platform-promoted marker) and never sent to Jev.
 */
export interface Rule {
  id: string;
  label: string;
  source: RuleSource;
  kind: RuleKind;
  enabled: boolean;
  include: string;
  exclude: string;
  examplesYes: string[];
  examplesNo: string[];
  scope: RuleScope;
  threshold?: number;
}

export const MAX_RULES = 100;
export const MAX_LABEL_LENGTH = 80;
export const MAX_INCLUDE_LENGTH = 2000;
export const MAX_EXCLUDE_LENGTH = 1000;
export const MAX_EXAMPLE_LENGTH = 200;
export const MAX_EXAMPLES_PER_SIDE = 5;

/** Ids become object keys in the compiled question map, so they are restricted to
 * a conservative identifier shape. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RESERVED_IDS: readonly string[] = ['__proto__', 'prototype', 'constructor'];

/** C0/C1 controls plus zero-width and bidi-override characters. These can hide or
 * reorder text inside a compiled prompt, so they are rejected outright. */
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

/** True when `value` carries a control or invisible character. Multi-line fields
 * may keep newlines and tabs; everything else may not. */
function hasUnsafeChars(value: string, allowNewlines = false): boolean {
  const probe = allowNewlines ? value.replace(/[\n\t]/g, '') : value;
  return INVISIBLE_CHARS.test(probe);
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** The ten built-in rules, all enabled, carrying the default condition,
 * `exclude` and examples maintained in `category.ts`. */
export function builtInRules(): Rule[] {
  return BUILT_IN_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    source: 'builtin' as const,
    kind: category.rule === 'promoted' ? 'local' : 'semantic',
    enabled: true,
    include: category.question ?? '',
    exclude: category.exclude ?? '',
    examplesYes: [...(category.examplesYes ?? [])],
    examplesNo: [...(category.examplesNo ?? [])],
    scope: 'all' as const,
  }));
}

/**
 * The default `include` each built-in shipped with before structured `exclude`
 * and examples were added. Kept only so migration can recognize a stored
 * built-in the user never edited; the check also compares the default label,
 * kind, scope, threshold and empty exclude/examples, so any stored edit is left
 * exactly as-is instead of being refreshed.
 */
export const LEGACY_BUILT_IN_INCLUDE: Readonly<Record<string, string>> = {
  ads: '',
  bait: 'Is this post engagement bait — primarily asking people to reply, follow, like, comment a keyword, or introduce themselves, in order to farm interactions?',
  promo:
    'Is this post a promotion — selling or advertising a product, course, template, service, or newsletter?',
  platitude:
    'Is this post a platitude — a generic motivational or self-evident statement with no specific information?',
  hate: 'Is this post hateful, abusive, or insulting — hate speech, slurs, dehumanizing language, personal attacks, name-calling, profanity aimed at people, or crude sexual harassment, in any language?',
  politics:
    'Is this post about politics — governments, parties, politicians, elections, political ideology, nationalism, geopolitics, or political outrage and culture-war arguments, in any language?',
  nsfw: 'Is this post NSFW — sexually explicit or pornographic content, nudity, sexual acts described in text, links to adult content, or gore, in any language?',
  porn: 'Is this sexual or porn spam, or a porn-bot lure — sexual solicitation, adult content bait, innuendo obfuscated with emoji, or slang inviting people to view adult content, in any language? Typical bot lines: English "link in bio", "check my profile", "DM me", "my OF is free", "I\'m 19 dm me"; Chinese 比我好看的没我骚, 比我骚的没我好看, 我福不黑不信你看, 我果然太涩了, 应该没人比我玩的更开了吧, 有人想锐评一下我的福嘛, 看主页, 私信; Japanese 裏垢, 裏アカ女子, セフレ, オフパコ, 見せ合い, P活, やりもく, プロフ見てね; Korean 조건만남, 오픈채팅, #조건 #ㅈㄱ, 바로 만날사람; Spanish "estoy aburrida", "busco amigos", "mira mi perfil"; Portuguese "conteúdo +18", "olha meu perfil"; French "je m\'ennuie, je peux te dm?", "coucou 🥵"; German "schreib mir direkt ❤️"; Russian интим, фото в профиле, хочешь в лс?; Arabic خاص, للتواصل, صباح الجمال يا ست الكل; Thai แอดไลน์, สาวอวบ, เจอจ่าย; Vietnamese kết bạn zalo, tìm gái xinh hẹn hò.',
  spam: 'Is this an automated or off-topic spam reply — a bot pushing links, follow-me or DM-me bait, asking an AI to verify, a canned or copy-pasted message, or anything unrelated to the post it replies to, in any language? Typical bot lines: "follow me back", "let\'s grow together", "DM me", "join my telegram"; 繋がりましょう, フォロバ, DMください; 맞팔해요, 디엠 확인, 디엠 보내줘; "mándame dm", "te sigo", "sígueme"; "segue de volta", "me chama na dm"; ممكن خاص, راسلني, تابعني; напиши в лс, глянь лс, подпишись; takipleşelim, dm at, yaz bana; follback dong, dm aku; "DM karo", "follow back karo"; ทักมา, ทักไลน์, ฟอลแบค; inbox em, follow mình; "je peux te dm?", "mp moi", "suis-moi"; "schreib mir", "folge mir zurück".',
  crypto: 'Is this post shilling a cryptocurrency, token, presale, airdrop, or trading signal?',
};

/** True when every default-owned field still equals the previous shipped default,
 * i.e. the user never touched this built-in rule. A stored edit in any of these
 * fields makes the rule ineligible for refresh. */
function isUneditedLegacyBuiltIn(rule: Rule): boolean {
  if (rule.source !== 'builtin') return false;
  if (builtInKindOf(rule.id) !== rule.kind) return false;
  const legacyInclude = LEGACY_BUILT_IN_INCLUDE[rule.id];
  if (legacyInclude === undefined) return false;
  const category = BUILT_IN_CATEGORIES.find((candidate) => candidate.id === rule.id);
  if (!category) return false;
  return (
    rule.label === category.label &&
    rule.include === legacyInclude &&
    rule.exclude === '' &&
    rule.examplesYes.length === 0 &&
    rule.examplesNo.length === 0 &&
    rule.scope === 'all' &&
    rule.threshold === undefined
  );
}

/** Refreshes stored built-in rules that still match the previous defaults to the
 * current defaults, preserving each rule's on/off state. Edited rules and rules
 * the user disabled are otherwise returned untouched. */
export function refreshUneditedBuiltIns(stored: readonly Rule[]): Rule[] {
  const defaults = new Map(builtInRules().map((rule) => [rule.id, rule]));
  return stored.map((rule) => {
    const next = defaults.get(rule.id);
    if (!next || !isUneditedLegacyBuiltIn(rule)) return rule;
    return { ...next, enabled: rule.enabled };
  });
}

export function isBuiltInId(id: string): boolean {
  return BUILT_IN_CATEGORIES.some((category) => category.id === id);
}

/** Deterministic, migration-stable id for a custom rule. Deleting or reordering
 * other rules never changes it; renaming keeps the id generated here only when
 * there is no existing rule to reuse (see `legacyCustomRule`). */
export function customRuleIdFor(label: string, existing: readonly Rule[]): string {
  const reused = existing.find((rule) => rule.source === 'custom' && rule.label === label);
  if (reused) return reused.id;
  const base = `custom:${hashString(label.toLowerCase())}`;
  const taken = new Set(existing.map((rule) => rule.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Builds a custom rule from a legacy name-only custom rule, keeping the exact
 * legacy instruction text so behaviour does not change silently on migration. */
export function legacyCustomRule(label: string, existing: readonly Rule[]): Rule {
  return {
    id: customRuleIdFor(label, existing),
    label,
    source: 'custom',
    kind: 'semantic',
    enabled: true,
    include: `Should this post be filtered out under the user's rule "${label}"? Answer yes if the post matches what the rule describes.`,
    exclude: '',
    examplesYes: [],
    examplesNo: [],
    scope: 'all',
  };
}

type ParsedRule = { ok: true; rule: Rule } | { ok: false; detail: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function bounded(value: string, max: number, what: string): string | null {
  return value.length > max ? `${what} must be at most ${max} characters` : null;
}

function examples(value: unknown, what: string): string[] | string {
  const items = stringArray(value);
  if (!items) return `${what} must be an array of strings`;
  if (items.length > MAX_EXAMPLES_PER_SIDE) {
    return `at most ${MAX_EXAMPLES_PER_SIDE} ${what} are allowed`;
  }
  for (const item of items) {
    const error = bounded(item, MAX_EXAMPLE_LENGTH, 'each example');
    if (error) return error;
    if (hasUnsafeChars(item)) return `each example must not contain control characters`;
  }
  return items;
}

/** The instruction kind a built-in id is allowed to have. The ads category is a
 * page-signal detector, so it can never be turned into a model question. */
export function builtInKindOf(id: string): RuleKind | null {
  const category = BUILT_IN_CATEGORIES.find((candidate) => candidate.id === id);
  if (!category) return null;
  return category.rule === 'promoted' ? 'local' : 'semantic';
}

export function parseRule(value: unknown): ParsedRule {
  const record = asRecord(value);
  if (!record) return { ok: false, detail: 'each rule must be an object' };
  if (!nonEmpty(record.id)) return { ok: false, detail: 'rule id must be a non-empty string' };
  const id = record.id.trim();
  if (!ID_PATTERN.test(id) || RESERVED_IDS.includes(id)) {
    return { ok: false, detail: `rule id ${JSON.stringify(id)} is not a safe identifier` };
  }
  if (!nonEmpty(record.label)) return { ok: false, detail: `rule ${id} needs a label` };
  const label = record.label.trim();
  const labelError = bounded(label, MAX_LABEL_LENGTH, 'label');
  if (labelError) return { ok: false, detail: labelError };
  if (hasUnsafeChars(label)) {
    return { ok: false, detail: `rule ${id} label must not contain control characters` };
  }
  if (record.source !== 'builtin' && record.source !== 'custom') {
    return { ok: false, detail: `rule ${id} needs source builtin or custom` };
  }
  if (record.kind !== 'local' && record.kind !== 'semantic') {
    return { ok: false, detail: `rule ${id} needs kind local or semantic` };
  }
  // Identity cannot be forged: a built-in id keeps its built-in source and kind,
  // and no custom rule may squat on a built-in or local detector id.
  const builtInKind = builtInKindOf(id);
  if (builtInKind !== null) {
    if (record.source !== 'builtin') {
      return { ok: false, detail: `rule ${id} is a built-in rule and cannot be saved as custom` };
    }
    if (record.kind !== builtInKind) {
      return { ok: false, detail: `rule ${id} must stay ${builtInKind}` };
    }
  } else if (record.source === 'builtin') {
    return { ok: false, detail: `rule ${id} is not a built-in rule id` };
  }
  if (typeof record.enabled !== 'boolean') return { ok: false, detail: `rule ${id} needs enabled` };
  if (typeof record.include !== 'string') return { ok: false, detail: `rule ${id} needs include text` };
  if (typeof record.exclude !== 'string') return { ok: false, detail: `rule ${id} needs exclude text` };
  const includeError = bounded(record.include, MAX_INCLUDE_LENGTH, 'include text');
  if (includeError) return { ok: false, detail: includeError };
  const excludeError = bounded(record.exclude, MAX_EXCLUDE_LENGTH, 'exclude text');
  if (excludeError) return { ok: false, detail: excludeError };
  if (hasUnsafeChars(record.include, true) || hasUnsafeChars(record.exclude, true)) {
    return { ok: false, detail: `rule ${id} text must not contain control characters` };
  }
  if (record.kind === 'semantic' && record.include.trim() === '') {
    return { ok: false, detail: `rule ${id} needs include text` };
  }
  const yes = examples(record.examplesYes, 'include examples');
  if (typeof yes === 'string') return { ok: false, detail: yes };
  const no = examples(record.examplesNo, 'exclude examples');
  if (typeof no === 'string') return { ok: false, detail: no };
  if (record.scope !== 'all' && record.scope !== 'replies') {
    return { ok: false, detail: `rule ${id} needs scope all or replies` };
  }
  if (
    record.threshold !== undefined &&
    !(typeof record.threshold === 'number' && record.threshold > 0 && record.threshold <= 1)
  ) {
    return { ok: false, detail: `rule ${id} threshold must be between 0 and 1` };
  }
  const rule: Rule = {
    id,
    label,
    source: record.source,
    kind: record.kind,
    enabled: record.enabled,
    include: record.include,
    exclude: record.exclude,
    examplesYes: yes,
    examplesNo: no,
    scope: record.scope,
  };
  if (record.threshold !== undefined) rule.threshold = record.threshold as number;
  return { ok: true, rule };
}

export function isRule(value: unknown): value is Rule {
  return parseRule(value).ok;
}

/** Lenient parse used for reading stored settings; keeps unknown fields' defaults. */
export function coerceRule(value: unknown): Rule | null {
  const record = asRecord(value);
  if (!record || !nonEmpty(record.id)) return null;
  const id = record.id.trim();
  const builtin = BUILT_IN_CATEGORIES.find((category) => category.id === id);
  const source: RuleSource =
    record.source === 'builtin' || record.source === 'custom'
      ? record.source
      : builtin
        ? 'builtin'
        : 'custom';
  const kind: RuleKind =
    record.kind === 'local' || record.kind === 'semantic'
      ? record.kind
      : builtin?.rule === 'promoted'
        ? 'local'
        : 'semantic';
  const label = nonEmpty(record.label) ? record.label.trim() : (builtin?.label ?? id);
  const include = typeof record.include === 'string' ? record.include : (builtin?.question ?? '');
  const rule: Rule = {
    id,
    label,
    source,
    kind,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    include,
    exclude: typeof record.exclude === 'string' ? record.exclude : '',
    examplesYes: stringArray(record.examplesYes) ?? [],
    examplesNo: stringArray(record.examplesNo) ?? [],
    scope: record.scope === 'replies' ? 'replies' : 'all',
  };
  if (typeof record.threshold === 'number' && record.threshold > 0 && record.threshold <= 1) {
    rule.threshold = record.threshold;
  }
  return rule;
}

export function coerceRules(value: unknown): Rule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: Rule[] = [];
  for (const item of value) {
    const rule = coerceRule(item);
    if (rule) rules.push(rule);
  }
  return rules.length > 0 ? rules : null;
}

export type RulesValidation = { ok: true; rules: Rule[] } | { ok: false; detail: string };

export function validateRules(value: unknown): RulesValidation {
  if (!Array.isArray(value)) return { ok: false, detail: 'rules must be an array' };
  if (value.length === 0) return { ok: false, detail: 'rules must not be empty' };
  if (value.length > MAX_RULES) return { ok: false, detail: `at most ${MAX_RULES} rules are allowed` };
  const rules: Rule[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const item of value) {
    const parsed = parseRule(item);
    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    if (ids.has(parsed.rule.id)) return { ok: false, detail: `duplicate rule id: ${parsed.rule.id}` };
    ids.add(parsed.rule.id);
    const labelKey = parsed.rule.label.toLowerCase();
    if (labels.has(labelKey)) return { ok: false, detail: `duplicate rule label: ${parsed.rule.label}` };
    labels.add(labelKey);
    rules.push(parsed.rule);
  }
  for (const category of BUILT_IN_CATEGORIES) {
    if (!ids.has(category.id)) return { ok: false, detail: `missing built-in rule: ${category.id}` };
  }
  return { ok: true, rules };
}

export interface PreviewInput {
  text: string;
  name?: string;
  handle?: string;
  quotedText?: string;
  parentText?: string;
  rules: Rule[];
  threshold: number;
}

export type PreviewRuleStatus = 'match' | 'no-match' | 'unavailable' | 'not-applicable';

export interface PreviewRuleResult {
  id: string;
  label: string;
  score?: number;
  threshold: number;
  status: PreviewRuleStatus;
}

export type PreviewResult =
  | { ok: true; results: PreviewRuleResult[]; tokens: number; model?: string }
  | { ok: false; error: string; detail: string };

function isRuleList(value: unknown): value is Rule[] {
  return Array.isArray(value) && value.every(isRule);
}

export function isPreviewInput(value: unknown): value is PreviewInput {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.text !== 'string') return false;
  if (record.name !== undefined && typeof record.name !== 'string') return false;
  if (record.handle !== undefined && typeof record.handle !== 'string') return false;
  if (record.quotedText !== undefined && typeof record.quotedText !== 'string') return false;
  if (record.parentText !== undefined && typeof record.parentText !== 'string') return false;
  if (typeof record.threshold !== 'number') return false;
  return isRuleList(record.rules);
}

function isPreviewRuleResult(value: unknown): value is PreviewRuleResult {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.id !== 'string' || typeof record.label !== 'string') return false;
  if (record.score !== undefined && typeof record.score !== 'number') return false;
  if (typeof record.threshold !== 'number') return false;
  return (
    record.status === 'match' ||
    record.status === 'no-match' ||
    record.status === 'unavailable' ||
    record.status === 'not-applicable'
  );
}

export function isPreviewResult(value: unknown): value is PreviewResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) {
    return (
      Array.isArray(record.results) &&
      record.results.every(isPreviewRuleResult) &&
      typeof record.tokens === 'number' &&
      (record.model === undefined || typeof record.model === 'string')
    );
  }
  return record.ok === false && typeof record.error === 'string' && typeof record.detail === 'string';
}

export type SaveRulesResult =
  | { ok: true; settings: Settings }
  | { ok: false; error: 'conflict' | 'invalid'; detail: string };

function looksLikeSettings(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== null &&
    Array.isArray(record.rules) &&
    record.rules.every(isRule) &&
    typeof record.revision === 'number' &&
    typeof record.filterOn === 'boolean' &&
    typeof record.threshold === 'number'
  );
}

export function isSaveRulesResult(value: unknown): value is SaveRulesResult {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) return looksLikeSettings(record.settings);
  return (
    record.ok === false &&
    (record.error === 'conflict' || record.error === 'invalid') &&
    typeof record.detail === 'string'
  );
}