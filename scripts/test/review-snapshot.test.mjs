/**
 * Judgement snapshot of the in-timeline review mode: a pure function of what the
 * feed already knows. These tests pin the rule that matters most: "nothing
 * matched" is not the same as "kept". Only a fully answered, unmatched judgement
 * is green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureInputHash, observedStateJson, sampleIdFor } from '../../src/domain/capture';
import { buildReviewSnapshot } from '../../src/domain/review';
import { builtInRules } from '../../src/domain/rule';
import { makePost } from './harness.mjs';

const rules = builtInRules();

function semantic(id, over = {}) {
  return {
    id, label: id, source: 'custom', kind: 'semantic', enabled: true, include: `Is this about ${id}?`,
    exclude: '', examplesYes: [], examplesNo: [], scope: 'all', ...over,
  };
}

function input(over = {}) {
  return {
    post: makePost({ id: '1' }),
    judgement: { status: 'scored', scores: {}, answered: true },
    rules,
    globalThreshold: 0.7,
    putBack: false,
    threadFlagged: false,
    rulesFingerprint: 'fp',
    at: 1,
    ...over,
  };
}

test('an unmatched, fully answered judgement is kept', () => {
  const snapshot = buildReviewSnapshot(input());
  assert.equal(snapshot.state, 'kept');
  assert.equal(snapshot.direct, false);
  assert.equal(snapshot.putBack, false);
});

test('a judgement missing one answer is never green', () => {
  const snapshot = buildReviewSnapshot(input({ judgement: { status: 'scored', scores: { promo: 0.1 }, answered: false } }));
  assert.equal(snapshot.state, 'undecided');
  assert.equal(snapshot.undecidedReason, 'missing-answer');
});

test('pending and failed judgements are undecided with a concrete reason', () => {
  const pending = buildReviewSnapshot(input({ judgement: { status: 'pending' } }));
  assert.deepEqual([pending.state, pending.undecidedReason], ['undecided', 'pending']);
  const failed = buildReviewSnapshot(input({ judgement: { status: 'failed', error: 'network' } }));
  assert.deepEqual([failed.state, failed.undecidedReason], ['undecided', 'failed']);
});

test('every rule is compared with its own threshold, falling back to the global one', () => {
  const custom = [semantic('a', { threshold: 0.5 }), semantic('b'), semantic('c', { threshold: 0.95 })];
  const snapshot = buildReviewSnapshot(
    input({ rules: custom, judgement: { status: 'scored', scores: { a: 0.6, b: 0.6, c: 0.9 }, answered: true } }),
  );
  const byId = Object.fromEntries(snapshot.rules.map((rule) => [rule.ruleId, rule]));
  assert.equal(snapshot.state, 'flagged');
  assert.equal(snapshot.direct, true);
  assert.deepEqual([byId.a.hit, byId.a.threshold], [true, 0.5]);
  assert.deepEqual([byId.b.hit, byId.b.threshold], [false, 0.7]);
  assert.deepEqual([byId.c.hit, byId.c.threshold], [false, 0.95]);
});

test('the page promoted marker is a local hit without a score', () => {
  const snapshot = buildReviewSnapshot(
    input({ post: makePost({ id: '2', promoted: true }), judgement: { status: 'rule-only' } }),
  );
  assert.equal(snapshot.state, 'flagged');
  const ad = snapshot.rules.find((rule) => rule.local);
  assert.deepEqual([ad.score, ad.threshold, ad.hit], [null, null, true]);
});

test('posts the feed never judged are not decorated', () => {
  assert.equal(buildReviewSnapshot(input({ post: makePost({ own: true }) })), null);
  assert.equal(buildReviewSnapshot(input({ post: makePost({ text: '' }), judgement: { status: 'rule-only' } })), null);
  assert.equal(buildReviewSnapshot(input({ judgement: { status: 'rule-only' } })), null);
});

test('a post whose thread is flagged is flagged without being a direct hit', () => {
  const snapshot = buildReviewSnapshot(input({ threadFlagged: true }));
  assert.deepEqual([snapshot.state, snapshot.direct], ['flagged', false]);
});

test('putting a hit back turns it into a kept post that still shows its hit', () => {
  const judgement = { status: 'scored', scores: { promo: 0.95 }, answered: true };
  const snapshot = buildReviewSnapshot(input({ judgement, putBack: true }));
  assert.deepEqual([snapshot.state, snapshot.putBack], ['kept', true]);
  assert.equal(snapshot.rules.find((rule) => rule.ruleId === 'promo').hit, true);
  // While another post of the thread is still flagged, the thread stays hidden.
  const stillFlagged = buildReviewSnapshot(input({ judgement, putBack: true, threadFlagged: true }));
  assert.equal(stillFlagged.state, 'flagged');
});

test('a reply whose parent text is not loaded cannot be green, but a hit still wins', () => {
  const custom = [semantic('spam', { scope: 'replies' })];
  const reply = makePost({ id: '3', kind: 'reply', parent: null });
  const undecided = buildReviewSnapshot(
    input({ post: reply, rules: custom, judgement: { status: 'scored', scores: { spam: 0.1 }, answered: true } }),
  );
  assert.deepEqual([undecided.state, undecided.undecidedReason], ['undecided', 'no-context']);
  const hit = buildReviewSnapshot(
    input({ post: reply, rules: custom, judgement: { status: 'scored', scores: { spam: 0.9 }, answered: true } }),
  );
  assert.equal(hit.state, 'flagged');
});

test('identity is the shared sample id and input hash, and follows the text', () => {
  const post = makePost({ id: '4', text: 'first' });
  const snapshot = buildReviewSnapshot(input({ post }));
  assert.equal(snapshot.sampleId, sampleIdFor(post));
  assert.equal(snapshot.inputHash, captureInputHash(observedStateJson(post)));
  const edited = buildReviewSnapshot(input({ post: { ...post, text: 'second' } }));
  assert.notEqual(edited.sampleId, snapshot.sampleId);
  assert.notEqual(edited.inputHash, snapshot.inputHash);
});
