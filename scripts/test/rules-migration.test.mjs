/**
 * Rule migration, stable ids and validation. These lock in the promise that old
 * user semantics are preserved verbatim instead of being silently rewritten.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUILT_IN_CATEGORIES } from '../../src/domain/category';
import {
  builtInRules,
  customRuleIdFor,
  hashString,
  LEGACY_BUILT_IN_INCLUDE,
  legacyCustomRule,
  validateRules,
} from '../../src/domain/rule';
import { compileRuleQuestion, compileRules } from '../../src/domain/rule-compiler';
import { enabledCategories, normalizeSettings, withRules } from '../../src/domain/settings';

const LEGACY = {
  filterOn: false,
  threshold: 0.8,
  disabled: ['politics', 'hate'],
  custom: ['horoscopes'],
  provider: 'typesafe',
  keys: { vercel: 'vck_keep_me', typesafe: 'ts_keep_me' },
};

const LEGACY_CUSTOM_INSTRUCTION =
  'Should this post be filtered out under the user\'s rule "horoscopes"? Answer yes if the post matches what the rule describes.';

/** A stored rule set from before built-ins gained structured exclude/examples:
 * every default-owned field still holds the previous shipped value. */
function legacyStoredRules() {
  return builtInRules().map((rule) => ({
    ...rule,
    include: LEGACY_BUILT_IN_INCLUDE[rule.id],
    exclude: '',
    examplesYes: [],
    examplesNo: [],
  }));
}

test('a fresh install enables all ten built-in rules', () => {
  const settings = normalizeSettings(undefined);

  assert.equal(BUILT_IN_CATEGORIES.length, 10);
  assert.equal(settings.rules.length, 10);
  assert.ok(settings.rules.every((rule) => rule.enabled));
  assert.ok(settings.rules.every((rule) => rule.source === 'builtin'));
  assert.equal(settings.rules.filter((rule) => rule.kind === 'semantic').length, 9);
  assert.equal(settings.rules.find((rule) => rule.id === 'ads').kind, 'local');
  assert.deepEqual(settings.disabled, []);
  assert.deepEqual(settings.custom, []);
  assert.equal(enabledCategories(settings).size, 10);
});

test('legacy disabled/custom/threshold/keys migrate without changing meaning', () => {
  const settings = normalizeSettings(LEGACY);
  const byId = new Map(settings.rules.map((rule) => [rule.id, rule]));

  assert.equal(settings.filterOn, false);
  assert.equal(settings.threshold, 0.8);
  assert.equal(settings.provider, 'typesafe');
  assert.deepEqual(settings.keys, { vercel: 'vck_keep_me', typesafe: 'ts_keep_me' });
  // Derived from the built-in rule order, so `hate` precedes `politics`.
  assert.deepEqual(settings.disabled, ['hate', 'politics']);
  assert.deepEqual(settings.custom, ['horoscopes']);
  assert.equal(byId.get('politics').enabled, false);
  assert.equal(byId.get('hate').enabled, false);
  assert.equal(byId.get('bait').enabled, true);

  const custom = settings.rules.filter((rule) => rule.source === 'custom');
  assert.equal(custom.length, 1);
  assert.equal(custom[0].label, 'horoscopes');
  assert.equal(custom[0].kind, 'semantic');
  assert.equal(custom[0].id, `custom:${hashString('horoscopes')}`);
});

test('a migrated legacy custom rule keeps its exact original instruction', () => {
  const settings = normalizeSettings(LEGACY);
  const custom = settings.rules.find((rule) => rule.source === 'custom');
  const compiled = compileRules(settings.rules);

  assert.equal(custom.include, LEGACY_CUSTOM_INSTRUCTION);
  assert.equal(compiled.questions[custom.id], LEGACY_CUSTOM_INSTRUCTION);
});

test('migrating built-in rules carries the current compiled default prompts', () => {
  const settings = normalizeSettings({ custom: ['horoscopes'] });
  const compiled = compileRules(settings.rules);
  const defaults = new Map(
    builtInRules().map((rule) => [rule.id, compileRuleQuestion(rule)]),
  );

  assert.equal(compiled.questions.ads, undefined);
  for (const category of BUILT_IN_CATEGORIES) {
    if (category.id === 'ads') continue;
    assert.equal(compiled.questions[category.id], defaults.get(category.id));
    // The condition stays the first line; exclude and examples are appended.
    assert.ok(compiled.questions[category.id].startsWith(category.question));
  }
});

test('an un-edited legacy built-in is refreshed to the new defaults, keeping its on/off state', () => {
  const settings = normalizeSettings({ rules: legacyStoredRules(), disabled: ['hate'] });
  const byId = new Map(settings.rules.map((rule) => [rule.id, rule]));
  const defaults = new Map(builtInRules().map((rule) => [rule.id, rule]));

  for (const id of ['bait', 'promo', 'platitude', 'politics', 'nsfw', 'porn', 'spam', 'crypto']) {
    assert.equal(byId.get(id).include, defaults.get(id).include);
    assert.equal(byId.get(id).exclude, defaults.get(id).exclude);
    assert.deepEqual(byId.get(id).examplesYes, defaults.get(id).examplesYes);
    assert.deepEqual(byId.get(id).examplesNo, defaults.get(id).examplesNo);
  }
  // A rule disabled before the upgrade is refreshed in content but stays disabled.
  assert.equal(byId.get('hate').enabled, false);
  assert.equal(byId.get('hate').include, defaults.get('hate').include);
  assert.deepEqual(settings.disabled, ['hate']);
});

test('an edited legacy built-in is preserved exactly and never overwritten', () => {
  const edited = legacyStoredRules().map((rule) =>
    rule.id === 'bait'
      ? { ...rule, label: 'My bait', include: 'my own bait rule', exclude: 'my own exclude' }
      : rule,
  );
  const settings = normalizeSettings({ rules: edited });
  const bait = settings.rules.find((rule) => rule.id === 'bait');
  const crypto = settings.rules.find((rule) => rule.id === 'crypto');

  assert.equal(bait.label, 'My bait');
  assert.equal(bait.include, 'my own bait rule');
  assert.equal(bait.exclude, 'my own exclude');
  // A sibling the user never touched is still upgraded.
  assert.equal(crypto.include, builtInRules().find((rule) => rule.id === 'crypto').include);
  assert.notEqual(crypto.include, LEGACY_BUILT_IN_INCLUDE.crypto);
});

test('adding only an exclude or example counts as an edit and blocks the refresh', () => {
  const tweaked = legacyStoredRules().map((rule) =>
    rule.id === 'promo'
      ? { ...rule, exclude: 'never for a friend recommendation' }
      : rule.id === 'crypto'
        ? { ...rule, examplesYes: ['bag it now'] }
        : rule,
  );
  const settings = normalizeSettings({ rules: tweaked });

  assert.equal(settings.rules.find((rule) => rule.id === 'promo').include, LEGACY_BUILT_IN_INCLUDE.promo);
  assert.equal(settings.rules.find((rule) => rule.id === 'promo').exclude, 'never for a friend recommendation');
  assert.equal(settings.rules.find((rule) => rule.id === 'crypto').include, LEGACY_BUILT_IN_INCLUDE.crypto);
  assert.deepEqual(settings.rules.find((rule) => rule.id === 'crypto').examplesYes, ['bag it now']);
});

test('the refresh is idempotent and does not rewrite rules it already upgraded', () => {
  const once = normalizeSettings({ rules: legacyStoredRules() });
  const twice = normalizeSettings(once);

  assert.deepEqual(twice, once);
});

test('a disabled built-in rule keeps its prompt on the rule but asks nothing', () => {
  const settings = normalizeSettings(LEGACY);
  const hate = settings.rules.find((rule) => rule.id === 'hate');

  assert.equal(hate.enabled, false);
  assert.equal(hate.include, BUILT_IN_CATEGORIES.find((category) => category.id === 'hate').question);
  assert.equal(compileRules(settings.rules).questions.hate, undefined);
});

test('migration is idempotent across repeated startups', () => {
  const once = normalizeSettings(LEGACY);
  const twice = normalizeSettings(once);
  const thrice = normalizeSettings(twice);

  assert.deepEqual(twice, once);
  assert.deepEqual(thrice, once);
});

test('stored rule edits survive a reload while legacy mirrors stay consistent', () => {
  const base = normalizeSettings(LEGACY);
  const edited = base.rules.map((rule) =>
    rule.id === 'bait' ? { ...rule, include: 'edited bait text' } : rule,
  );
  const saved = withRules(base, edited, 1);
  const reloaded = normalizeSettings(saved);

  assert.equal(reloaded.revision, 1);
  assert.equal(reloaded.rules.find((rule) => rule.id === 'bait').include, 'edited bait text');
  assert.deepEqual(reloaded.disabled, ['hate', 'politics']);
  assert.deepEqual(reloaded.custom, ['horoscopes']);
  assert.deepEqual(reloaded.keys, base.keys);
});

test('re-enabling a built-in rule is not silently undone by the legacy mirror', () => {
  const base = normalizeSettings(LEGACY);
  const edited = base.rules.map((rule) =>
    rule.id === 'politics' ? { ...rule, enabled: true } : rule,
  );
  const saved = withRules(base, edited, 1);
  const reloaded = normalizeSettings(saved);

  assert.deepEqual(saved.disabled, ['hate']);
  assert.deepEqual(reloaded.disabled, ['hate']);
  assert.equal(reloaded.rules.find((rule) => rule.id === 'politics').enabled, true);
});

test('custom rule ids are stable and independent of position', () => {
  const seeded = normalizeSettings({ custom: ['alpha', 'beta', 'gamma'] });
  const idOf = (label) => seeded.rules.find((rule) => rule.label === label).id;

  assert.equal(idOf('alpha'), `custom:${hashString('alpha')}`);
  assert.equal(idOf('beta'), `custom:${hashString('beta')}`);
  assert.equal(idOf('gamma'), `custom:${hashString('gamma')}`);

  const withoutBeta = seeded.rules.filter((rule) => rule.label !== 'beta');
  const rebuilt = normalizeSettings({ rules: [...withoutBeta].reverse(), custom: ['gamma', 'alpha'] });

  assert.equal(rebuilt.rules.find((rule) => rule.label === 'alpha').id, idOf('alpha'));
  assert.equal(rebuilt.rules.find((rule) => rule.label === 'gamma').id, idOf('gamma'));
  assert.equal(rebuilt.rules.some((rule) => rule.label === 'beta'), false);
});

test('customRuleIdFor reuses an existing label and only suffixes on collision', () => {
  const existing = [legacyCustomRule('alpha', [])];
  assert.equal(customRuleIdFor('alpha', existing), existing[0].id);
  assert.equal(customRuleIdFor('alpha', []), `custom:${hashString('alpha')}`);

  // The id hash is case-insensitive, but label reuse matches exactly, so a
  // case-only rename is currently treated as a different rule. Documented as a
  // known limitation rather than a silent id change.
  assert.equal(customRuleIdFor('ALPHA', existing), `custom:${hashString('alpha')}-2`);

  const betaId = `custom:${hashString('beta')}`;
  const squatting = [{ ...legacyCustomRule('other', []), id: betaId }];
  assert.equal(customRuleIdFor('beta', squatting), `${betaId}-2`);
  assert.equal(
    customRuleIdFor('beta', [...squatting, { ...legacyCustomRule('third', []), id: `${betaId}-2` }]),
    `${betaId}-3`,
  );
});

test('validateRules rejects empty lists, duplicates and missing built-ins', () => {
  assert.equal(validateRules([]).ok, false);
  assert.equal(validateRules(builtInRules()).ok, true);

  const duplicated = [...builtInRules(), { ...builtInRules()[0] }];
  assert.equal(validateRules(duplicated).ok, false);

  const duplicateLabel = builtInRules().map((rule) =>
    rule.id === 'bait' ? { ...rule, label: 'Ads' } : rule,
  );
  assert.equal(validateRules(duplicateLabel).ok, false);

  const missing = builtInRules().filter((rule) => rule.id !== 'crypto');
  const result = validateRules(missing);
  assert.equal(result.ok, false);
  assert.match(result.detail, /missing built-in rule: crypto/);
});

test('a semantic rule with no instruction is rejected before it can be saved', () => {
  const rules = builtInRules().map((rule) => (rule.id === 'bait' ? { ...rule, include: '   ' } : rule));
  const result = validateRules(rules);

  assert.equal(result.ok, false);
  assert.match(result.detail, /needs include text/);
});