/**
 * Rule categories: default grouping, migration of settings saved before they
 * existed, strict validation on save, the atomic rules-and-categories write and
 * the guarantee that a category never reaches a compiled question.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRuntimeMessage } from '../../src/domain/messages';
import { builtInRules, coerceRule, parseRule, validateRules } from '../../src/domain/rule';
import { compileRules } from '../../src/domain/rule-compiler';
import {
  BUILT_IN_GROUP,
  DEFAULT_GROUP_IDS,
  MAX_GROUPS,
  MAX_GROUP_NAME_LENGTH,
  coerceGroups,
  defaultGroups,
  groupIdSet,
  validateGroups,
} from '../../src/domain/rule-group';
import { normalizeSettings, withRules } from '../../src/domain/settings';
import { loadSettings, saveRules, saveSettings } from '../../src/infrastructure/settings-store';
import { installChrome } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';

function custom(overrides = {}) {
  return {
    id: 'custom:one',
    label: 'Mine',
    source: 'custom',
    kind: 'semantic',
    enabled: true,
    include: 'Is this mine?',
    exclude: '',
    examplesYes: [],
    examplesNo: [],
    scope: 'all',
    ...overrides,
  };
}

test('every built-in rule starts in a default category that exists', () => {
  const ids = groupIdSet(defaultGroups());
  assert.deepEqual([...ids], [...DEFAULT_GROUP_IDS]);
  for (const rule of builtInRules()) {
    assert.equal(rule.group, BUILT_IN_GROUP[rule.id], rule.id);
    assert.ok(ids.has(rule.group), `${rule.id} points at a default category`);
  }
  assert.deepEqual(
    Object.fromEntries(builtInRules().map((rule) => [rule.id, rule.group])),
    {
      ads: 'marketing',
      promo: 'marketing',
      crypto: 'marketing',
      bait: 'engagement',
      platitude: 'engagement',
      spam: 'engagement',
      hate: 'harmful',
      nsfw: 'harmful',
      porn: 'harmful',
      politics: 'politics',
    },
  );
  assert.ok(defaultGroups().every((group) => group.name === ''));
});

test('settings saved before categories existed get the default categories and groupings', () => {
  const legacyRules = builtInRules().map(({ group: _group, ...rest }) => rest);
  const settings = normalizeSettings({ rules: [...legacyRules, custom()], revision: 3 });

  assert.deepEqual(settings.ruleGroups, defaultGroups());
  assert.equal(settings.rules.find((rule) => rule.id === 'bait').group, 'engagement');
  assert.equal(settings.rules.find((rule) => rule.id === 'politics').group, 'politics');
  assert.equal(settings.rules.find((rule) => rule.id === 'custom:one').group, undefined);
  assert.equal(settings.revision, 3);
  // Nothing at all stored gives the same defaults.
  assert.deepEqual(normalizeSettings(undefined).ruleGroups, defaultGroups());
  assert.equal(normalizeSettings(undefined).rules.find((rule) => rule.id === 'hate').group, 'harmful');
});

test('once categories are stored, a rule without one stays uncategorised', () => {
  const rules = builtInRules().map((rule) => {
    if (rule.id !== 'bait') return rule;
    const { group: _group, ...rest } = rule;
    return rest;
  });
  const settings = normalizeSettings({ rules, ruleGroups: defaultGroups() });
  assert.equal(settings.rules.find((rule) => rule.id === 'bait').group, undefined);
  assert.equal(settings.rules.find((rule) => rule.id === 'promo').group, 'marketing');
});

test('deleting every stored category is respected, and dangling references fall back to uncategorised', () => {
  const none = normalizeSettings({ rules: builtInRules(), ruleGroups: [] });
  assert.deepEqual(none.ruleGroups, []);
  assert.ok(none.rules.every((rule) => rule.group === undefined));

  const dangling = normalizeSettings({
    rules: [...builtInRules(), custom({ group: 'group:gone' })],
    ruleGroups: [{ id: 'marketing', name: '' }],
  });
  assert.equal(dangling.rules.find((rule) => rule.id === 'custom:one').group, undefined);
  assert.equal(dangling.rules.find((rule) => rule.id === 'promo').group, 'marketing');
  assert.equal(dangling.rules.find((rule) => rule.id === 'bait').group, undefined);
});

test('coerceGroups keeps what is usable, and null means nothing was stored', () => {
  assert.equal(coerceGroups(undefined), null);
  assert.equal(coerceGroups('nope'), null);
  assert.deepEqual(
    coerceGroups([
      { id: 'group:a', name: ' Alpha ' },
      { id: 'group:a', name: 'Again' },
      { id: 'group:b', name: 'alpha' },
      { id: '__proto__', name: 'Bad' },
      { id: 'group:c', name: '' },
      { id: 'politics', name: '' },
      7,
    ]),
    [
      { id: 'group:a', name: 'Alpha' },
      { id: 'politics', name: '' },
    ],
  );
  const many = Array.from({ length: MAX_GROUPS + 5 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}` }));
  assert.equal(coerceGroups(many).length, MAX_GROUPS);
});

test('validateGroups enforces count, length, characters and unique names', () => {
  assert.equal(validateGroups(defaultGroups()).ok, true);
  assert.equal(validateGroups([]).ok, true);
  assert.equal(validateGroups('x').ok, false);
  assert.equal(validateGroups([{ id: 'g1', name: 'A' }, { id: 'g1', name: 'B' }]).ok, false);
  assert.match(validateGroups([{ id: 'g1', name: 'Same' }, { id: 'g2', name: ' SAME ' }]).detail, /duplicate category name/);
  assert.equal(validateGroups([{ id: 'g1', name: '' }]).ok, false, 'a custom category needs a name');
  assert.equal(validateGroups([{ id: 'politics', name: '' }]).ok, true, 'a default one may keep its built-in name');
  assert.equal(validateGroups([{ id: 'g1', name: 'x'.repeat(MAX_GROUP_NAME_LENGTH) }]).ok, true);
  assert.equal(validateGroups([{ id: 'g1', name: 'x'.repeat(MAX_GROUP_NAME_LENGTH + 1) }]).ok, false);
  assert.equal(validateGroups([{ id: 'g1', name: 'bad\nname' }]).ok, false);
  assert.equal(validateGroups([{ id: 'g1', name: 'zero\u200bwidth' }]).ok, false);
  assert.equal(validateGroups([{ id: 'bad id', name: 'A' }]).ok, false);
  assert.equal(validateGroups([{ id: 'constructor', name: 'A' }]).ok, false);
  assert.equal(validateGroups(Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }))).ok, false);
  assert.equal(validateGroups(Array.from({ length: MAX_GROUPS }, (_, i) => ({ id: `g${i}`, name: `G${i}` }))).ok, true);
});

test('a rule carries its category through parse and coerce, and a bad one is refused', () => {
  assert.equal(parseRule(custom({ group: 'marketing' })).rule.group, 'marketing');
  assert.equal('group' in parseRule(custom()).rule, false);
  assert.equal(parseRule(custom({ group: 'bad id' })).ok, false);
  assert.equal(parseRule(custom({ group: 5 })).ok, false);
  assert.equal(coerceRule(custom({ group: 'marketing' })).group, 'marketing');
  assert.equal('group' in coerceRule(custom({ group: 'bad id' })), false);
});

test('validateRules rejects a reference to a category that does not exist', () => {
  const ids = groupIdSet(defaultGroups());
  assert.equal(validateRules([...builtInRules(), custom({ group: 'marketing' })], ids).ok, true);
  const unknown = validateRules([...builtInRules(), custom({ group: 'group:new' })], ids);
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /unknown category: group:new/);
  assert.equal(validateRules([...builtInRules(), custom()], ids).ok, true, 'uncategorised is always valid');
  assert.equal(validateRules([...builtInRules(), custom({ group: 'group:new' })]).ok, true, 'no set means no reference check');
});

test('changing a rule category never changes the compiled questions or their fingerprint', () => {
  const rules = [...builtInRules(), custom({ group: 'marketing' })];
  const before = compileRules(rules);
  const regrouped = rules.map((rule) => ({ ...rule, group: rule.group === undefined ? 'politics' : undefined }));
  const after = compileRules(regrouped);
  assert.equal(after.key, before.key);
  assert.deepEqual(after.questions, before.questions);
});

test('saveRules writes rules and categories together and they survive a reload', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: normalizeSettings(undefined) } });
  const groups = [...defaultGroups(), { id: 'group:new', name: 'Newsletters' }];
  const rules = [...builtInRules(), custom({ group: 'group:new' })];

  const result = await saveRules(rules, 0, groups);
  assert.equal(result.ok, true);
  assert.equal(result.settings.revision, 1);
  assert.deepEqual(result.settings.ruleGroups, groups);

  const stored = handle.readLocal(SETTINGS_KEY);
  assert.deepEqual(stored.ruleGroups, groups);
  assert.equal(stored.rules.find((rule) => rule.id === 'custom:one').group, 'group:new');

  const reloaded = await loadSettings();
  assert.deepEqual(reloaded.ruleGroups, groups);
  assert.equal(reloaded.rules.find((rule) => rule.id === 'custom:one').group, 'group:new');
});

test('deleting a category and uncategorising its rules is one write; a dangling reference writes nothing', async () => {
  const seeded = withRules(
    normalizeSettings(undefined),
    [...builtInRules(), custom({ group: 'marketing' })],
    0,
  );
  const handle = installChrome({ local: { [SETTINGS_KEY]: seeded } });
  const before = handle.snapshot();

  const dangling = await saveRules(
    [...builtInRules(), custom({ group: 'marketing' })],
    0,
    defaultGroups().filter((group) => group.id !== 'marketing'),
  );
  assert.equal(dangling.ok, false);
  assert.equal(dangling.error, 'invalid');
  assert.match(dangling.detail, /unknown category: marketing/);
  assert.deepEqual(handle.snapshot(), before);

  const moved = await saveRules(
    [...builtInRules().map(({ group: _g, ...rest }) => (rest.id === 'ads' || rest.id === 'promo' || rest.id === 'crypto' ? rest : { ...rest, group: BUILT_IN_GROUP[rest.id] })), custom()],
    0,
    defaultGroups().filter((group) => group.id !== 'marketing'),
  );
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.settings.ruleGroups.map((group) => group.id), ['engagement', 'harmful', 'politics']);
  assert.equal(moved.settings.rules.find((rule) => rule.id === 'custom:one').group, undefined);
  // Deleted for good: a later read does not bring the default category back.
  assert.deepEqual((await loadSettings()).ruleGroups.map((group) => group.id), ['engagement', 'harmful', 'politics']);
});

test('saveRules refuses an invalid category list and leaves storage untouched', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: normalizeSettings(undefined) } });
  const before = handle.snapshot();
  const duplicate = await saveRules(builtInRules(), 0, [
    { id: 'group:a', name: 'Same' },
    { id: 'group:b', name: 'same' },
  ]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'invalid');
  assert.deepEqual(handle.snapshot(), before);
});

test('saveRules without categories keeps the stored ones and still checks references', async () => {
  const groups = [...defaultGroups(), { id: 'group:keep', name: 'Keep' }];
  installChrome({ local: { [SETTINGS_KEY]: withRules(normalizeSettings(undefined), builtInRules(), 0, groups) } });

  const ok = await saveRules([...builtInRules(), custom({ group: 'group:keep' })], 0);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.settings.ruleGroups, groups);

  const bad = await saveRules([...builtInRules(), custom({ group: 'group:missing' })], 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid');
});

test('panel settings saves never touch categories', async () => {
  const groups = [...defaultGroups(), { id: 'group:keep', name: 'Keep' }];
  const handle = installChrome({ local: { [SETTINGS_KEY]: withRules(normalizeSettings(undefined), builtInRules(), 0, groups) } });
  await saveSettings({ ...(await loadSettings()), threshold: 0.9, ruleGroups: [] });
  assert.deepEqual(handle.readLocal(SETTINGS_KEY).ruleGroups, groups);
});

test('the save-rules message must carry valid categories', () => {
  const base = { type: 'save-rules', rules: builtInRules(), expectedRevision: 0 };
  assert.equal(isRuntimeMessage({ ...base, groups: defaultGroups() }), true);
  assert.equal(isRuntimeMessage(base), false);
  assert.equal(isRuntimeMessage({ ...base, groups: [{ id: 'g', name: '' }] }), false);
  assert.equal(isRuntimeMessage({ ...base, groups: 'x' }), false);
});
