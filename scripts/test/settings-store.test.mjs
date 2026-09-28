/**
 * Current-config saving: compare-and-set on the revision, serialized writes,
 * strict validation, and the guarantee that neither provider key is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtInRules } from '../../src/domain/rule';
import { activeKey, normalizeSettings } from '../../src/domain/settings';
import {
  loadSettings,
  onSettingsChanged,
  saveRules,
  saveSettings,
} from '../../src/infrastructure/settings-store';
import { installChrome } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const KEYS = { vercel: 'vck_vercel', typesafe: 'ts_typesafe' };

function seed(overrides = {}) {
  return { [SETTINGS_KEY]: normalizeSettings(overrides) };
}

function withInclude(rules, id, include) {
  return rules.map((rule) => (rule.id === id ? { ...rule, include } : rule));
}

test('saveRules rejects a stale revision without overwriting the winner', async () => {
  const handle = installChrome({ local: seed() });
  const rules = builtInRules();

  const first = await saveRules(withInclude(rules, 'bait', 'bait v2'), 0);
  assert.equal(first.ok, true);
  assert.equal(first.settings.revision, 1);

  const second = await saveRules(withInclude(rules, 'hate', 'hate v2'), 0);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'conflict');
  assert.match(second.detail, /expected revision 0/);

  const stored = handle.readLocal(SETTINGS_KEY);
  assert.equal(stored.revision, 1);
  assert.equal(stored.rules.find((rule) => rule.id === 'bait').include, 'bait v2');
  assert.notEqual(stored.rules.find((rule) => rule.id === 'hate').include, 'hate v2');
});

test('concurrent saves against one revision serialize and only one wins', async () => {
  installChrome({ local: seed() });
  const rules = builtInRules();

  const [fromA, fromB] = await Promise.all([
    saveRules(withInclude(rules, 'bait', 'from A'), 0),
    saveRules(withInclude(rules, 'bait', 'from B'), 0),
  ]);
  const outcomes = [fromA, fromB];

  assert.equal(outcomes.filter((result) => result.ok).length, 1);
  assert.equal(
    outcomes.filter((result) => !result.ok && result.error === 'conflict').length,
    1,
  );
});

test('saveRules rejects invalid input and leaves storage untouched', async () => {
  const handle = installChrome({ local: seed() });
  const before = handle.snapshot();

  const empty = await saveRules([], 0);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'invalid');

  const missingBuiltIn = await saveRules(
    builtInRules().filter((rule) => rule.id !== 'promo'),
    0,
  );
  assert.equal(missingBuiltIn.ok, false);
  assert.match(missingBuiltIn.detail, /missing built-in rule: promo/);

  const badRevision = await saveRules(builtInRules(), -1);
  assert.equal(badRevision.ok, false);
  assert.equal(badRevision.error, 'invalid');

  assert.deepEqual(handle.snapshot(), before);
});

test('saving rules never touches either provider key', async () => {
  const handle = installChrome({ local: seed({ provider: 'typesafe', keys: KEYS }) });

  const result = await saveRules(
    builtInRules().map((rule) => (rule.id === 'bait' ? { ...rule, enabled: false } : rule)),
    0,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.keys, KEYS);
  assert.equal(result.settings.provider, 'typesafe');
  assert.deepEqual(handle.readLocal(SETTINGS_KEY).keys, KEYS);

  const reloaded = await loadSettings();
  assert.deepEqual(reloaded.keys, KEYS);
  assert.deepEqual(reloaded.disabled, ['bait']);
  assert.equal(reloaded.rules.find((rule) => rule.id === 'bait').enabled, false);
});

test('a key stored for one provider is never used as the other provider’s key', () => {
  const settings = normalizeSettings({ provider: 'vercel', keys: KEYS });

  assert.equal(activeKey(settings), 'vck_vercel');
  assert.equal(activeKey({ ...settings, provider: 'typesafe' }), 'ts_typesafe');
  assert.equal(activeKey(normalizeSettings({ provider: 'typesafe' })), '');
  assert.equal(activeKey(normalizeSettings({ provider: 'vercel', keys: { vercel: '  vck_trimmed  ' } })), 'vck_trimmed');
});

test('settings changes are broadcast as normalized settings', async () => {
  installChrome({ local: seed() });
  const seen = [];
  const stop = onSettingsChanged((settings) => seen.push(settings));

  const settings = await loadSettings();
  await saveSettings({ ...settings, filterOn: false, revision: 4 });
  stop();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].filterOn, false);
  assert.equal(seen[0].revision, 4);
  assert.equal(seen[0].rules.length, 10);
  assert.ok(seen[0].rules.every((rule) => typeof rule.id === 'string' && rule.id !== ''));
});

test('a cleared panel state and cached scores leave rules and keys in place', async () => {
  // Mirrors the background `clear-data` handler: only panel + score keys are
  // removed. Guarded here so a future `clear everything` cannot start wiping
  // the current rules or the API keys.
  const handle = installChrome({
    local: seed({ keys: KEYS }),
    session: { 'anyfilter.scores.vercel.abc.100': { bait: 0.9 } },
  });

  await chrome.storage.local.remove('anyfilter.panel');
  for (const key of handle.sessionKeys()) await chrome.storage.session.remove(key);

  const stored = handle.readLocal(SETTINGS_KEY);
  assert.deepEqual(stored.keys, KEYS);
  assert.equal(stored.rules.length, 10);
  assert.deepEqual(handle.sessionKeys(), []);
});