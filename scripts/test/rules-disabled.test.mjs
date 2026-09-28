/**
 * Disabled rules, stable fingerprints and local-only behaviour. Covers the
 * requirement that a disabled rule never mismatches, that a compiled question
 * set with nothing enabled costs zero requests, and that the local ads rule
 * still works without a key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtInRules } from '../../src/domain/rule';
import {
  compileRules,
  matchedRuleScores,
  questionsFingerprint,
} from '../../src/domain/rule-compiler';
import { matchRuleReasons } from '../../src/domain/verdict';
import { makePost } from './harness.mjs';

const QUESTION_COUNT = 9; // ten rules, minus the local ads check

test('a disabled semantic rule is dropped from the compiled questions', () => {
  const all = compileRules(builtInRules());
  assert.equal(Object.keys(all.questions).length, QUESTION_COUNT);

  const rules = builtInRules().map((rule) =>
    rule.id === 'bait' ? { ...rule, enabled: false } : rule,
  );
  const compiled = compileRules(rules);

  assert.equal('bait' in compiled.questions, false);
  assert.equal(Object.keys(compiled.questions).length, QUESTION_COUNT - 1);
  assert.notEqual(compiled.key, all.key);
});

test('disabling every semantic rule compiles to an empty question map', () => {
  const rules = builtInRules().map((rule) =>
    rule.kind === 'semantic' ? { ...rule, enabled: false } : rule,
  );
  const compiled = compileRules(rules);

  assert.deepEqual(compiled.questions, {});
  assert.equal(compiled.key, questionsFingerprint({}));
});

test('the local ads rule still hides promoted posts with no semantic rules on', () => {
  const rules = builtInRules().map((rule) =>
    rule.kind === 'semantic' ? { ...rule, enabled: false } : rule,
  );

  const promoted = matchRuleReasons(makePost({ promoted: true }), {}, rules, 0.7);
  assert.deepEqual(promoted.map((reason) => reason.categoryId), ['ads']);
  assert.equal(promoted[0].probability, 1);

  const kept = matchRuleReasons(
    makePost({ promoted: false }),
    { bait: 0.99, hate: 0.99 },
    rules,
    0.7,
  );
  assert.deepEqual(kept, []);
});

test('a disabled rule never matches even when the provider scores it', () => {
  const rules = builtInRules().map((rule) =>
    rule.id === 'hate' ? { ...rule, enabled: false } : rule,
  );
  const matched = matchedRuleScores(rules, { hate: 0.99 }, 0.7, false);

  assert.equal(matched.has('hate'), false);
  assert.equal(
    matchRuleReasons(makePost(), { hate: 0.99 }, rules, 0.7).some((r) => r.categoryId === 'hate'),
    false,
  );
});

test('renaming a rule or changing only its threshold keeps the fingerprint', () => {
  const base = compileRules(builtInRules());

  const renamed = compileRules(builtInRules().map((rule) => ({ ...rule, label: `${rule.label} v2` })));
  assert.equal(renamed.key, base.key);

  const retuned = compileRules(builtInRules().map((rule) => ({ ...rule, threshold: 0.9 })));
  assert.equal(retuned.key, base.key);

  const rewritten = compileRules(
    builtInRules().map((rule) => (rule.id === 'bait' ? { ...rule, include: 'different text' } : rule)),
  );
  assert.notEqual(rewritten.key, base.key);
});

test('adding exclude text or examples changes the fingerprint', () => {
  const base = compileRules(builtInRules());

  const withExclude = compileRules(
    builtInRules().map((rule) => (rule.id === 'bait' ? { ...rule, exclude: 'never for a real survey' } : rule)),
  );
  assert.notEqual(withExclude.key, base.key);
  assert.match(withExclude.questions.bait, /Answer no if: never for a real survey/);

  const withExample = compileRules(
    builtInRules().map((rule) => (rule.id === 'bait' ? { ...rule, examplesYes: ['name a color'] } : rule)),
  );
  assert.notEqual(withExample.key, base.key);
  assert.match(withExample.questions.bait, /Examples that should be answered yes/);
});

test('a replies-scoped rule only matches when parent context exists', () => {
  const rules = builtInRules().map((rule) =>
    rule.id === 'spam' ? { ...rule, scope: 'replies' } : rule,
  );
  const scores = { spam: 0.95 };

  assert.equal(matchedRuleScores(rules, scores, 0.7, false).has('spam'), false);
  assert.equal(matchedRuleScores(rules, scores, 0.7, true).get('spam'), 0.95);

  const topLevel = makePost();
  const reply = makePost({
    kind: 'reply',
    parent: { id: 'p1', name: 'Parent', handle: 'parent', text: 'the post above', avatarUrl: '' },
  });

  assert.deepEqual(matchRuleReasons(topLevel, scores, rules, 0.7), []);
  assert.deepEqual(matchRuleReasons(reply, scores, rules, 0.7).map((r) => r.categoryId), ['spam']);
});

test('a per-rule threshold overrides the global threshold', () => {
  const rules = builtInRules().map((rule) =>
    rule.id === 'bait' ? { ...rule, threshold: 0.95 } : rule,
  );

  const matched = matchedRuleScores(rules, { bait: 0.9, hate: 0.75 }, 0.7, false);

  assert.equal(matched.has('bait'), false); // 0.9 is below its own 0.95
  assert.equal(matched.get('hate'), 0.75); // still above the global 0.7
});