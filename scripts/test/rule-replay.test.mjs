/** The rule replay: label merging, post-level comparison and the ship gates. Offline. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { builtInRules } from '../../src/domain/rule';
import {
  DEFAULT_GATES,
  builtinPack,
  compareRuleSets,
  judge,
  mergeLabels,
  overlayPack,
  parseRulePack,
  scoreRules,
} from '../rule-replay-core.mjs';

const rule = (id, extra = {}) => ({
  id, label: id, source: 'custom', kind: 'semantic', enabled: true,
  include: `Is this ${id}?`, exclude: '', examplesYes: [], examplesNo: [], scope: 'all', ...extra,
});
const label = (n, overall) => ({ stateJson: JSON.stringify({ text: `post ${n}` }), overall, snapshot: { rules: [] } });
const pack = (rules) => ({ name: 'p', note: '', rules });

test('a post labelled twice keeps its label only when both agree', () => {
  const { labels, conflicts } = mergeLabels([
    [label(1, 'hide'), label(2, 'keep'), label(3, 'keep'), { ...label(4, 'hide'), overall: 'uncertain' }],
    [label(1, 'hide'), label(2, 'hide')],
  ]);
  assert.deepEqual(labels.map((l) => l.overall), ['hide', 'keep']);
  assert.equal(conflicts, 1);
});

test('a candidate is compared with the base per post, and the gates read that', async () => {
  const labels = [label(1, 'hide'), label(2, 'hide'), label(3, 'keep'), label(4, 'keep'), label(5, 'keep')];
  // The new rule fires on posts 1 and 2 (hide) and never on a keep.
  const score = (id, text) => (id === 'low' && /post [12]"/.test(text) ? 0.9 : 0.1);
  const scorer = async (stateJson, id) => score(id, stateJson);
  const base = pack([rule('promo')]);
  const candidate = pack([rule('promo'), rule('low')]);
  const comparison = compareRuleSets({
    base, candidate, labels,
    baseScores: await scoreRules(base.rules, labels, scorer),
    candidateScores: await scoreRules(candidate.rules, labels, scorer),
    threshold: 0.8,
  });
  assert.deepEqual([comparison.gained, comparison.lost, comparison.newFalseHide], [2, 0, 0]);
  assert.deepEqual(comparison.newRuleIds, ['low']);
  assert.equal(comparison.candidate.caught, 2);

  const small = judge(comparison);
  assert.equal(small.verdict, 'insufficient-data', 'a good result on five labels is not enough to pass');
  const enough = judge(comparison, { ...DEFAULT_GATES, minPerClass: 2, minTotalNewRule: 5 });
  assert.equal(enough.verdict, 'pass');
});

test('a rule that hides posts the person wanted to keep fails, and so does one that changes nothing', async () => {
  const labels = [label(1, 'hide'), ...[2, 3, 4, 5, 6].map((n) => label(n, 'keep'))];
  const scorer = async (stateJson, id) => (id === 'low' ? 0.95 : 0.1); // fires on everything
  const base = pack([rule('promo')]);
  const noisy = pack([rule('promo'), rule('low')]);
  const comparison = compareRuleSets({
    base, candidate: noisy, labels,
    baseScores: await scoreRules(base.rules, labels, scorer),
    candidateScores: await scoreRules(noisy.rules, labels, scorer),
    threshold: 0.8,
  });
  assert.equal(comparison.newFalseHide, 5);
  const verdict = judge(comparison, { ...DEFAULT_GATES, minPerClass: 1, minTotalNewRule: 1 });
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.results.find((r) => r.name === 'false-hide').status, 'fail');

  const same = compareRuleSets({ base, candidate: base, labels, baseScores: await scoreRules(base.rules, labels, scorer), candidateScores: await scoreRules(base.rules, labels, scorer), threshold: 0.8 });
  assert.equal(judge(same).results.find((r) => r.name === 'has-change').status, 'fail');
});

test('a pack is laid over the base: same id replaces, a new id is appended, the rest stay', () => {
  const base = pack([rule('a'), rule('b')]);
  const overlaid = overlayPack(base, pack([rule('b', { include: 'changed' }), rule('c')]));
  assert.deepEqual(overlaid.rules.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(overlaid.rules[1].include, 'changed');
});

test('a local rule is read from what the page recorded, and packs are validated', async () => {
  const ads = builtInRules().find((r) => r.id === 'ads');
  const flagged = { ...label(1, 'hide'), snapshot: { rules: [{ ruleId: 'ads', hit: true }] } };
  const [scores] = await scoreRules([ads], [flagged], async () => { throw new Error('a local rule must not call a model'); });
  assert.equal(scores.ads, 1);
  assert.equal(builtinPack().rules.length, 10);
  assert.throws(() => parseRulePack({ kind: 'nope', version: 1, rules: [] }));
  assert.throws(() => parseRulePack({ kind: 'anyfilter-rule-pack', version: 1, rules: [{ id: 'x' }] }));
  const shipped = parseRulePack(JSON.parse(readFileSync(new URL('../../rule-packs/low-value-2026-09.json', import.meta.url), 'utf8')));
  assert.equal(shipped.rules.length, 1);
});
