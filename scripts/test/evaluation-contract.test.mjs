/**
 * Phase 1 contract tests for the evaluation vocabulary. All synthetic and
 * offline: no provider, account, key or real sample is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  configFingerprint,
  countEvaluation,
  fingerprintInput,
  isHumanLabel,
} from '../../src/domain/evaluation';

const config = { rulesFingerprint: 'rf1', model: 'jev', threshold: 0.7 };
const stateJson = JSON.stringify({
  author: { handle: '@ada', name: 'Ada Lovelace' },
  text: 'a post about compilers',
  quoted: 'the quoted post',
  replyingTo: { author: '@parent', text: 'the thread parent' },
});
const question = 'Is this engagement bait?';

let n = 0;
function record(overrides = {}) {
  n += 1;
  return {
    sampleId: `s${n}`,
    postId: `p${n}`,
    threadId: `t${n}`,
    source: 'random',
    split: 'dev',
    config,
    ruleId: 'bait',
    input: { stateJson, question, inputHash: fingerprintInput(stateJson, question), truncated: false },
    jev: { status: 'match', score: 0.9, model: 'jev', tokens: 10 },
    human: { source: 'human', state: 'match', reason: 'checked the text' },
    machine: [],
    ...overrides,
  };
}

const human = (state, reason = 'checked the text') => ({ source: 'human', state, reason });
const machine = (state, modelId = 'other-a') => ({ source: 'machine', modelId, state, reason: 'keyword' });

test('decided human label and decided Jev give tp/fp/tn/fn for one rule', () => {
  const counts = countEvaluation([
    record({ human: human('match'), jev: { status: 'match', score: 0.9, model: 'm', tokens: 1 } }),
    record({ human: human('match'), jev: { status: 'no-match', score: 0.1, model: 'm', tokens: 1 } }),
    record({ human: human('no-match'), jev: { status: 'match', score: 0.8, model: 'm', tokens: 1 } }),
    record({ human: human('no-match'), jev: { status: 'no-match', score: 0.2, model: 'm', tokens: 1 } }),
  ]);

  assert.deepEqual(
    [counts.tp, counts.fp, counts.tn, counts.fn],
    [1, 1, 1, 1],
  );
  assert.equal(counts.precisionDenominator, 2);
  assert.equal(counts.recallDenominator, 2);
  assert.equal(counts.precision, 0.5);
  assert.equal(counts.recall, 0.5);
});

test('Jev undecided and error are never counted as a negative', () => {
  const counts = countEvaluation([
    // No score at all is a valid undecided and must not be read as a zero.
    record({ human: human('match'), jev: { status: 'undecided', model: 'm', tokens: 1 } }),
    record({ human: human('match'), jev: { status: 'error', detail: 'timeout', model: 'm', tokens: 0 } }),
    record({ human: human('no-match'), jev: { status: 'undecided', score: 0.5, model: 'm', tokens: 1 } }),
  ]);

  assert.equal(counts.fn, 0);
  assert.equal(counts.tn, 0);
  assert.equal(counts.undecidedPositives, 1);
  assert.equal(counts.errorPositives, 1);
  assert.equal(counts.undecidedNegatives, 1);
  // Unrecovered positives keep their place in the recall denominator.
  assert.equal(counts.recallDenominator, 2);
  assert.equal(counts.recall, 0);
  // Nothing was positively claimed, so precision is undefined, not zero.
  assert.equal(counts.precisionDenominator, 0);
  assert.equal(counts.precision, null);
});

test('a match with an out-of-range or NaN score is undecided, not a hit', () => {
  const counts = countEvaluation([
    // Negative score for a positive label must not become a true positive.
    record({ human: human('match'), jev: { status: 'match', score: -1, model: 'm', tokens: 1 } }),
    // Above 1 for a negative label must not become a true negative.
    record({ human: human('no-match'), jev: { status: 'no-match', score: 1.5, model: 'm', tokens: 1 } }),
    // NaN is a usable-status claim with an unusable number.
    record({ human: human('match'), jev: { status: 'match', score: Number.NaN, model: 'm', tokens: 1 } }),
  ]);

  assert.equal(counts.tp, 0);
  assert.equal(counts.tn, 0);
  assert.equal(counts.fp, 0);
  assert.equal(counts.fn, 0);
  assert.equal(counts.undecidedPositives, 2);
  assert.equal(counts.undecidedNegatives, 1);
  // Bad positive scores still count against recall.
  assert.equal(counts.recallDenominator, 2);
  assert.equal(counts.precisionDenominator, 0);
});

test('boundary scores 0 and 1 are accepted as decided', () => {
  const counts = countEvaluation([
    record({ human: human('match'), jev: { status: 'match', score: 1, model: 'm', tokens: 1 } }),
    record({ human: human('no-match'), jev: { status: 'no-match', score: 0, model: 'm', tokens: 1 } }),
  ]);

  assert.equal(counts.tp, 1);
  assert.equal(counts.tn, 1);
  assert.equal(counts.undecidedPositives + counts.undecidedNegatives, 0);
});

test('a human undecided label is listed but never forced into a rate', () => {
  const counts = countEvaluation([
    record({ human: human('undecided', 'quoted context missing') }),
    record({ human: human('undecided', 'language not understood') }),
  ]);

  assert.equal(counts.humanUndecided, 2);
  assert.equal(counts.tp + counts.fp + counts.tn + counts.fn, 0);
  assert.equal(counts.precisionDenominator, 0);
  assert.equal(counts.recallDenominator, 0);
});

test('an unreviewed sample or a bare machine candidate never becomes human truth', () => {
  const counts = countEvaluation([
    record({ human: null, machine: [machine('match'), machine('no-match', 'b')] }),
    record({ human: { source: 'machine', modelId: 'a', state: 'match', reason: 'keyword' } }),
  ]);

  assert.equal(counts.unreviewed, 2);
  assert.equal(counts.precisionDenominator, 0);
  assert.equal(counts.recallDenominator, 0);
});

test('overlapping rules stay separate and mixing rules in one call is rejected', () => {
  const bait = countEvaluation([record({ ruleId: 'bait' })]);
  const spam = countEvaluation([record({ ruleId: 'spam' })]);

  assert.equal(bait.tp, 1);
  assert.equal(spam.tp, 1);

  assert.throws(
    () => countEvaluation([record({ ruleId: 'bait' }), record({ ruleId: 'spam' })]),
    /more than one group/,
  );
});

test('mixing source, split or config in one call is rejected', () => {
  assert.throws(
    () => countEvaluation([record({ source: 'random' }), record({ source: 'hard' })]),
    /more than one group/,
  );
  assert.throws(
    () => countEvaluation([record({ split: 'dev' }), record({ split: 'holdout' })]),
    /more than one group/,
  );
  assert.throws(
    () =>
      countEvaluation([
        record({ config }),
        record({ config: { ...config, model: 'other' } }),
      ]),
    /more than one group/,
  );
});

test('the input fingerprint covers the serialized state and the question', () => {
  const rec = record();
  assert.equal(fingerprintInput(rec.input.stateJson, rec.input.question), rec.input.inputHash);

  // Changing the author, the question, the quote or the replyingTo parent from
  // the same serialized state must invalidate the recorded fingerprint.
  const state = JSON.parse(stateJson);
  const mutated = (patch) => fingerprintInput(JSON.stringify({ ...state, ...patch }), question);

  assert.notEqual(mutated({ author: { handle: '@eve', name: 'Eve' } }), rec.input.inputHash);
  assert.notEqual(mutated({ quoted: 'a different quoted post' }), rec.input.inputHash);
  assert.notEqual(mutated({ replyingTo: { author: '@other', text: 'another parent' } }), rec.input.inputHash);
  assert.notEqual(fingerprintInput(stateJson, 'changed question'), rec.input.inputHash);
});

test('config fingerprint changes with rules, model and threshold', () => {
  assert.equal(configFingerprint(config), configFingerprint({ ...config }));
  assert.notEqual(configFingerprint(config), configFingerprint({ ...config, rulesFingerprint: 'rf2' }));
  assert.notEqual(configFingerprint(config), configFingerprint({ ...config, model: 'other' }));
  assert.notEqual(configFingerprint(config), configFingerprint({ ...config, threshold: 0.8 }));
});

test('decided status must agree with its score and saved threshold', () => {
  assert.throws(
    () => countEvaluation([record({ jev: { status: 'match', score: 0.1, model: 'jev', tokens: 1 } })]),
    /decision does not match/,
  );
  assert.throws(
    () => countEvaluation([record({ jev: { status: 'no-match', score: 0.9, model: 'jev', tokens: 1 } })]),
    /decision does not match/,
  );
});

test('isHumanLabel accepts a human label and rejects a machine candidate', () => {
  assert.equal(isHumanLabel(human('match')), true);
  assert.equal(isHumanLabel(machine('match')), false);
  assert.equal(isHumanLabel({ state: 'match', reason: 'no discriminator' }), false);
  assert.equal(isHumanLabel(null), false);
});