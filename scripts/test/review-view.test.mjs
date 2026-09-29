/**
 * The toolbar's view filter: pure decisions about which decorated posts stay on
 * screen, and the counts shown next to them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewSnapshot } from '../../src/domain/review';
import { builtInRules } from '../../src/domain/rule';
import {
  DEFAULT_VIEW_FILTER,
  isDefaultFilter,
  matchesFilter,
  rulesOf,
  sliderApplies,
  summarizeView,
} from '../../src/domain/review-view';
import { makePost } from './harness.mjs';

const rules = builtInRules();

function item(id, scores, { promoted = false, record } = {}) {
  const snapshot = buildReviewSnapshot({
    post: makePost({ id, promoted }),
    judgement: promoted ? { status: 'rule-only' } : { status: 'scored', scores, answered: true },
    rules,
    globalThreshold: 0.7,
    putBack: false,
    threadFlagged: false,
    rulesFingerprint: 'fp',
    at: 1,
  });
  return { snapshot, record };
}

const label = (overall, valuable = false) => ({ overall, valuable });

const items = [
  item('1', { hate: 0.98, politics: 0.4 }),
  item('2', { hate: 0.55 }),
  item('3', { hate: 0.1 }, { record: label('keep') }),
  item('4', {}, { promoted: true }),
  item('5', { politics: 0.9 }, { record: label(null, true) }),
];
const ids = (filter) => items.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.snapshot.postId);

test('the default filter keeps everything', () => {
  assert.equal(isDefaultFilter(DEFAULT_VIEW_FILTER), true);
  assert.deepEqual(ids(DEFAULT_VIEW_FILTER), ['1', '2', '3', '4', '5']);
});

test('each scope selects by state, worth-reading flag or label', () => {
  assert.deepEqual(ids({ ...DEFAULT_VIEW_FILTER, scope: 'flagged' }), ['1', '4', '5']);
  assert.deepEqual(ids({ ...DEFAULT_VIEW_FILTER, scope: 'kept' }), ['2', '3']);
  assert.deepEqual(ids({ ...DEFAULT_VIEW_FILTER, scope: 'valuable' }), ['5']);
  assert.deepEqual(ids({ ...DEFAULT_VIEW_FILTER, scope: 'labeled' }), ['3'], 'a flag alone is not a label');
  assert.deepEqual(ids({ ...DEFAULT_VIEW_FILTER, scope: 'undecided' }), []);
});

test('choosing a rule keeps the posts that carry a score for it, and the slider narrows them', () => {
  assert.deepEqual(ids({ scope: 'all', ruleId: 'hate', minScore: 0 }), ['1', '2', '3']);
  assert.deepEqual(ids({ scope: 'all', ruleId: 'hate', minScore: 0.5 }), ['1', '2'], 'a below-threshold score still counts for the slider');
  assert.deepEqual(ids({ scope: 'all', ruleId: 'hate', minScore: 0.9 }), ['1']);
  assert.deepEqual(ids({ scope: 'flagged', ruleId: 'hate', minScore: 0.5 }), ['1']);
});

test('a local rule has no score: it passes when it fired and ignores the slider', () => {
  assert.deepEqual(ids({ scope: 'all', ruleId: 'ads', minScore: 0.99 }), ['4']);
  assert.equal(sliderApplies(items, 'ads'), false);
  assert.equal(sliderApplies(items, 'hate'), true);
  assert.equal(sliderApplies(items, null), false);
});

test('counts describe the loaded posts, the ones filtered out and the labelled ones', () => {
  assert.deepEqual(summarizeView(items, DEFAULT_VIEW_FILTER), { loaded: 5, filteredOut: 0, labeled: 1 });
  assert.deepEqual(summarizeView(items, { scope: 'flagged', ruleId: null, minScore: 0 }), { loaded: 5, filteredOut: 2, labeled: 1 });
  assert.deepEqual(summarizeView(items, { scope: 'all', ruleId: 'hate', minScore: 0.9 }), { loaded: 5, filteredOut: 4, labeled: 1 });
});

test('the rule list is the distinct rules on the loaded posts', () => {
  const list = rulesOf(items);
  assert.ok(list.some((rule) => rule.ruleId === 'hate' && !rule.local));
  assert.ok(list.some((rule) => rule.ruleId === 'ads' && rule.local));
  assert.equal(new Set(list.map((rule) => rule.ruleId)).size, list.length);
});
