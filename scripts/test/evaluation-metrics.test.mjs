/**
 * Offline tests for the pure evaluation-statistics layer. Every record here is
 * synthetic: no provider, account, key or real sample is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MIN_SAMPLES,
  WILSON_Z_95,
  summariseEvaluation,
  wilsonInterval,
} from '../../src/features/evaluation-metrics';

const baseConfig = { rulesFingerprint: 'rf-a', model: 'jev', threshold: 0.7 };

let counter = 0;
function record(overrides = {}) {
  counter += 1;
  const id = `s${counter}`;
  return {
    sampleId: id,
    postId: `p${id}`,
    threadId: `t${id}`,
    source: 'random',
    split: 'dev',
    config: baseConfig,
    ruleId: 'bait',
    input: { stateJson: '{}', question: 'q', inputHash: 'h', truncated: false },
    jev: jevMatch(),
    human: human('match'),
    machine: [],
    ...overrides,
  };
}

const human = (state, reason = 'checked the text') => ({ source: 'human', state, reason });
const jevMatch = (score = 0.9) => ({ status: 'match', score, model: 'jev', tokens: 5 });
const jevNoMatch = (score = 0.1) => ({ status: 'no-match', score, model: 'jev', tokens: 5 });
const jevUndecided = () => ({ status: 'undecided', model: 'jev', tokens: 5 });
const jevError = () => ({ status: 'error', detail: 'timeout', model: 'jev', tokens: 0 });
const machine = (state, modelId = 'other-a') => ({
  source: 'machine',
  modelId,
  state,
  reason: 'keyword',
});

function sumExcluded(group) {
  const e = group.excluded;
  return (
    e.undecidedPositives +
    e.undecidedNegatives +
    e.errorPositives +
    e.errorNegatives +
    e.humanUndecided +
    e.unreviewed
  );
}

test('decided tp/fp/fn and rates come from countEvaluation with effective denominators', () => {
  const groups = summariseEvaluation([
    record({ human: human('match'), jev: jevMatch() }), // tp
    record({ human: human('match'), jev: jevNoMatch() }), // fn
    record({ human: human('no-match'), jev: jevMatch() }), // fp
  ]);

  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.deepEqual([group.counts.tp, group.counts.fn, group.counts.fp], [1, 1, 1]);
  assert.equal(group.precision.denominator, 2); // tp + fp
  assert.equal(group.recall.denominator, 2); // tp + fn
  assert.equal(group.precision.point, 0.5);
  assert.equal(group.recall.point, 0.5);
  assert.equal(group.total, 3);
  assert.equal(sumExcluded(group), 0);
});

test('a failed or undecided positive is a recall miss, never a negative', () => {
  const groups = summariseEvaluation([
    record({ human: human('match'), jev: jevMatch() }),
    record({ human: human('match'), jev: jevError() }),
    record({ human: human('match'), jev: jevUndecided() }),
    record({ human: human('no-match'), jev: jevNoMatch() }),
  ]);

  const group = groups[0];
  assert.equal(group.counts.tp, 1);
  assert.equal(group.counts.fn, 0);
  assert.equal(group.counts.tn, 1);
  assert.equal(group.counts.fp, 0);
  assert.equal(group.excluded.errorPositives, 1);
  assert.equal(group.excluded.undecidedPositives, 1);
  // Unrecovered positives still sit in the recall denominator.
  assert.equal(group.recall.denominator, 3);
  assert.equal(group.recall.point, 1 / 3);
  assert.equal(group.precision.denominator, 1);
  assert.equal(group.precision.point, 1);
});

test('human-undecided and unreviewed records are listed, not forced into a rate', () => {
  const groups = summariseEvaluation([
    record({ human: human('undecided', 'quoted context missing') }),
    record({ human: null }),
    record({ human: human('match'), jev: jevMatch() }),
  ]);

  const group = groups[0];
  assert.equal(group.excluded.humanUndecided, 1);
  assert.equal(group.excluded.unreviewed, 1);
  assert.equal(group.total, 3);
  assert.equal(group.counts.tp, 1);
  assert.equal(group.precision.denominator, 1);
  assert.equal(group.recall.denominator, 1);
  // Nothing is dropped without being named: rate records + excluded == total.
  const raterecords =
    group.counts.tp + group.counts.fp + group.counts.tn + group.counts.fn;
  assert.equal(raterecords + sumExcluded(group), group.total);
});

test('random and hard samples are reported separately and never averaged', () => {
  const groups = summariseEvaluation([
    record({ source: 'random', human: human('match'), jev: jevMatch() }),
    record({ source: 'random', human: human('no-match'), jev: jevNoMatch() }),
    record({ source: 'hard', human: human('match'), jev: jevMatch() }),
  ]);

  assert.equal(groups.length, 2);
  const random = groups.find((group) => group.key.source === 'random');
  const hard = groups.find((group) => group.key.source === 'hard');
  assert.ok(random);
  assert.ok(hard);
  assert.equal(random.total, 2);
  assert.equal(hard.total, 1);
  assert.equal(random.counts.tp, 1);
  assert.equal(random.counts.tn, 1);
  assert.equal(hard.counts.tp, 1);
  // The hard group measures only its own record, not the random ones.
  assert.equal(hard.recall.denominator, 1);
});

test('dev, holdout and different configs never share a group', () => {
  const groups = summariseEvaluation([
    record({ split: 'dev', human: human('match'), jev: jevMatch() }),
    record({ split: 'holdout', human: human('no-match'), jev: jevNoMatch() }),
    record({
      config: { ...baseConfig, model: 'other' },
      human: human('match'),
      jev: jevMatch(),
    }),
  ]);

  assert.equal(groups.length, 3);
  const keyStrings = new Set(
    groups.map((g) => `${g.key.ruleId}|${g.key.source}|${g.key.split}|${g.key.configFingerprint}`),
  );
  assert.equal(keyStrings.size, 3);
  assert.ok(groups.every((group) => group.total === 1));
  // Splits are isolated: the holdout group has no positive of its own.
  const holdout = groups.find((group) => group.key.split === 'holdout');
  assert.ok(holdout);
  assert.equal(holdout.recall.denominator, 0);
  assert.equal(holdout.recall.point, null);
});

test('machine candidates without a human label contribute nothing to a rate', () => {
  const groups = summariseEvaluation([
    record({ human: null, machine: [machine('match'), machine('no-match', 'b')] }),
    record({ human: null, machine: [machine('match')] }),
  ]);

  const group = groups[0];
  assert.equal(group.excluded.unreviewed, 2);
  assert.equal(group.excluded.machineOnly, 2);
  assert.equal(group.precision.denominator, 0);
  assert.equal(group.recall.denominator, 0);
  assert.equal(group.precision.point, null);
  assert.equal(group.recall.point, null);
  assert.equal(group.precision.interval, null);
  assert.equal(group.evidence, 'insufficient');
  assert.match(group.reasons.join(' '), /no human-confirmed/);
});

test('a small sample is marked insufficient instead of claiming a target', () => {
  const groups = summariseEvaluation([
    record({ human: human('match'), jev: jevMatch() }),
    record({ human: human('no-match'), jev: jevNoMatch() }),
  ]);

  const group = groups[0];
  assert.equal(group.precision.point, 1);
  assert.equal(group.recall.point, 1);
  assert.equal(group.precision.sufficient, false);
  assert.equal(group.recall.sufficient, false);
  assert.equal(group.evidence, 'insufficient');
  assert.match(group.precision.reasons.join(' '), /below minimum/);
  assert.match(group.recall.reasons.join(' '), /below minimum/);
  // The interval exists but its lower bound is far from 1, so no pass is implied.
  assert.ok(group.recall.interval.low < 1);
});

test('no positives or no negatives is explicit evidence insufficiency', () => {
  const positivesOnly = summariseEvaluation([
    record({ human: human('match'), jev: jevMatch() }),
    record({ human: human('match'), jev: jevMatch() }),
  ])[0];
  assert.equal(positivesOnly.recall.denominator, 2);
  assert.equal(positivesOnly.precision.sufficient, false);
  assert.match(positivesOnly.precision.reasons.join(' '), /no human-confirmed negative/);

  const negativesOnly = summariseEvaluation([
    record({ human: human('no-match'), jev: jevNoMatch() }),
    record({ human: human('no-match'), jev: jevNoMatch() }),
  ])[0];
  assert.equal(negativesOnly.precision.denominator, 0);
  assert.equal(negativesOnly.recall.denominator, 0);
  assert.equal(negativesOnly.precision.point, null);
  assert.equal(negativesOnly.recall.point, null);
  assert.match(negativesOnly.recall.reasons.join(' '), /no human-confirmed positive/);
});

test('a repeated sampleId inside one group is dropped, not counted twice', () => {
  const groups = summariseEvaluation([
    record({ sampleId: 'dup', human: human('match'), jev: jevMatch() }),
    record({ sampleId: 'dup', human: human('no-match'), jev: jevMatch() }),
  ]);

  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.total, 1);
  assert.equal(group.duplicatesDropped, 1);
  assert.equal(group.counts.tp, 1);
  assert.equal(group.counts.fp, 0);
});

test('the same sampleId under different rules stays a separate record', () => {
  const groups = summariseEvaluation([
    record({ sampleId: 'same', ruleId: 'bait', human: human('match'), jev: jevMatch() }),
    record({ sampleId: 'same', ruleId: 'spam', human: human('match'), jev: jevMatch() }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.key.ruleId).sort(),
    ['bait', 'spam'],
  );
  assert.ok(groups.every((group) => group.total === 1 && group.counts.tp === 1));
});

test('a group large enough to be reportable is marked present', () => {
  const records = [];
  for (let i = 0; i < DEFAULT_MIN_SAMPLES; i += 1) {
    records.push(record({ human: human('match'), jev: jevMatch() }));
    records.push(record({ human: human('no-match'), jev: jevNoMatch() }));
  }

  const group = summariseEvaluation(records)[0];
  assert.equal(group.total, DEFAULT_MIN_SAMPLES * 2);
  assert.equal(group.precision.denominator, DEFAULT_MIN_SAMPLES);
  assert.equal(group.recall.denominator, DEFAULT_MIN_SAMPLES);
  assert.equal(group.precision.sufficient, true);
  assert.equal(group.recall.sufficient, true);
  assert.equal(group.evidence, 'present');
  assert.equal(group.reasons.length, 0);
  // Still only a description, never a "meets 95%" verdict.
  assert.ok(group.precision.interval.low < group.precision.point);
});

test('the Wilson interval matches published 95% bounds and rejects bad input', () => {
  assert.equal(wilsonInterval(0, 0), null);
  assert.equal(wilsonInterval(5, 0), null);
  assert.equal(wilsonInterval(-1, 10), null);
  assert.equal(wilsonInterval(11, 10), null);

  const certain = wilsonInterval(1, 1);
  assert.ok(Math.abs(certain.low - 0.2065) < 0.001);
  assert.equal(certain.high, 1);

  const half = wilsonInterval(50, 100);
  assert.ok(Math.abs(half.low - 0.4038) < 0.002);
  assert.ok(Math.abs(half.high - 0.5962) < 0.002);

  assert.equal(WILSON_Z_95, 1.96);
});

test('minSamples must be a positive integer', () => {
  assert.throws(() => summariseEvaluation([], { minSamples: 0 }), /positive integer/);
  assert.throws(() => summariseEvaluation([], { minSamples: 1.5 }), /positive integer/);
  assert.deepEqual(summariseEvaluation([]), []);
});