/**
 * Review annotations: validation, the draft rules, the store (epoch guard,
 * eviction), the page-side controller and the background's sender checks.
 * Offline: an in-memory chrome.storage and no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRuntimeMessage } from '../../src/domain/messages';
import { buildReviewSnapshot } from '../../src/domain/review';
import {
  applyRecord,
  draftProblem,
  inputFromDraft,
  inputWithValuable,
  inputWithoutLabel,
  isReviewSaveInput,
  removeRecord,
} from '../../src/domain/review-record';
import { builtInRules } from '../../src/domain/rule';
import { ReviewAnnotations } from '../../src/features/review-annotations';
import {
  clearReviewRecords,
  loadReviewStore,
  removeReviewRecord,
  saveReviewRecord,
} from '../../src/infrastructure/review-store';
import { installChrome, makePost, webPageSender, xContentSender } from './harness.mjs';

const rules = builtInRules();

function snapshotOf(post = makePost({ id: '5' }), scores = { promo: 0.9 }) {
  return buildReviewSnapshot({
    post,
    judgement: { status: 'scored', scores, answered: true },
    rules,
    globalThreshold: 0.7,
    putBack: false,
    threadFlagged: false,
    rulesFingerprint: 'fp',
    at: 1,
  });
}

const hideDraft = (ruleIds) => ({ overall: 'hide', ruleIds, noRuleCovers: false, reason: '' });

test('a hide verdict needs a ticked rule, or "no rule covers it" with a reason', () => {
  assert.equal(draftProblem({ overall: null, ruleIds: [], noRuleCovers: false, reason: '' }), 'no-overall');
  assert.equal(draftProblem(hideDraft([])), 'no-rule-or-reason');
  assert.equal(draftProblem(hideDraft(['promo'])), null);
  assert.equal(draftProblem({ overall: 'hide', ruleIds: [], noRuleCovers: true, reason: '  ' }), 'reason-empty');
  assert.equal(draftProblem({ overall: 'hide', ruleIds: [], noRuleCovers: true, reason: 'x'.repeat(281) }), 'reason-too-long');
  assert.equal(draftProblem({ overall: 'hide', ruleIds: [], noRuleCovers: true, reason: 'a joke thread' }), null);
  assert.equal(draftProblem({ overall: 'keep', ruleIds: [], noRuleCovers: false, reason: '' }), null);
});

test('only the rules the person ticked are labelled, and the label follows the verdict', () => {
  const snapshot = snapshotOf();
  const hide = inputFromDraft(snapshot, hideDraft(['promo']), false);
  assert.deepEqual(hide.rules, [{ ruleId: 'promo', label: 'match' }]);
  const keep = inputFromDraft(snapshot, { overall: 'keep', ruleIds: ['promo'], noRuleCovers: false, reason: '' }, false);
  assert.deepEqual(keep.rules, [{ ruleId: 'promo', label: 'no-match' }], 'other rules are not recorded as "did not match"');
  const plainKeep = inputFromDraft(snapshot, { overall: 'keep', ruleIds: [], noRuleCovers: false, reason: '' }, false);
  assert.deepEqual(plainKeep.rules, []);
  const noRule = inputFromDraft(snapshot, { overall: 'hide', ruleIds: ['promo'], noRuleCovers: true, reason: ' new kind of spam ' }, false);
  assert.deepEqual(noRule.rules, []);
  assert.equal(noRule.noRuleCovers, 'new kind of spam');
  assert.equal(hide.stateJson, snapshot.stateJson);
  assert.equal(hide.snapshot.rulesFingerprint, 'fp');
  assert.equal(inputFromDraft(snapshot, hideDraft([]), false), null);
});

test('the store input guard rejects malformed or inconsistent annotations', () => {
  const snapshot = snapshotOf();
  const good = inputFromDraft(snapshot, hideDraft(['promo']), false);
  assert.equal(isReviewSaveInput(good), true);
  assert.equal(isReviewSaveInput({ ...good, rules: [{ ruleId: 'promo', label: 'no-match' }] }), false, 'label must follow the verdict');
  assert.equal(isReviewSaveInput({ ...good, rules: [{ ruleId: 'not-in-snapshot', label: 'match' }] }), false);
  assert.equal(isReviewSaveInput({ ...good, rules: [] }), false, 'hide without a rule or reason');
  assert.equal(isReviewSaveInput({ ...good, noRuleCovers: 'x' }), false, 'a rule and "none covers it" cannot both be set');
  assert.equal(isReviewSaveInput({ ...good, overall: null, rules: [], valuable: false }), false, 'nothing to store');
  assert.equal(isReviewSaveInput({ ...good, overall: null, rules: [], valuable: true }), true);
  assert.equal(isReviewSaveInput({ ...good, stateJson: 'x'.repeat(20000) }), false);
  assert.equal(isReviewSaveInput({ ...good, overall: 'maybe' }), false);
  assert.equal(isReviewSaveInput({ ...good, snapshot: { ...good.snapshot, state: 'blue' } }), false);
  assert.equal(isReviewSaveInput(null), false);
  assert.equal(isRuntimeMessage({ type: 'review-save', epoch: 0, input: { ...good, overall: 'x' } }), false);
  assert.equal(isRuntimeMessage({ type: 'review-save', epoch: -1, input: good }), false);
  assert.equal(isRuntimeMessage({ type: 'review-save', epoch: 0, input: good }), true);
});

test('a correction bumps the revision; an undo removes the annotation', () => {
  const snapshot = snapshotOf();
  const first = applyRecord([], inputFromDraft(snapshot, hideDraft(['promo']), false), 10);
  assert.equal(first.record.revision, 1);
  assert.equal(first.record.source, 'in-timeline-assisted');
  const second = applyRecord(first.records, inputFromDraft(snapshot, { overall: 'keep', ruleIds: [], noRuleCovers: false, reason: '' }, false), 20);
  assert.equal(second.records.length, 1);
  assert.equal(second.record.revision, 2);
  assert.equal(second.record.overall, 'keep');
  assert.deepEqual(removeRecord(second.records, snapshot.sampleId, snapshot.inputHash, 'fp'), []);
  assert.equal(removeRecord(second.records, snapshot.sampleId, snapshot.inputHash, 'other').length, 1, 'another rule set is another annotation');
});

test('eviction drops the oldest annotation that is not worth reading', () => {
  const posts = [1, 2, 3].map((n) => makePost({ id: String(100 + n) }));
  let list = [];
  const valuable = (post) => inputWithValuable(snapshotOf(post), undefined, true);
  list = applyRecord(list, valuable(posts[0]), 1, 2).records;
  list = applyRecord(list, inputFromDraft(snapshotOf(posts[1]), { overall: 'keep', ruleIds: [], noRuleCovers: false, reason: '' }, false), 2, 2).records;
  const third = applyRecord(list, inputFromDraft(snapshotOf(posts[2]), { overall: 'keep', ruleIds: [], noRuleCovers: false, reason: '' }, false), 3, 2);
  assert.equal(third.ok, true);
  assert.deepEqual(third.records.map((item) => item.postId), ['101', '103'], 'the valuable one survived, the plain one was evicted');
  const allValuable = applyRecord(
    applyRecord([], valuable(posts[0]), 1, 1).records,
    valuable(posts[1]),
    2,
    1,
  );
  assert.equal(allValuable.ok, false, 'a full list of protected annotations refuses instead of deleting');
});

test('undoing the label keeps the worth-reading flag; without the flag it is a removal', () => {
  const snapshot = snapshotOf();
  const labelled = applyRecord([], inputFromDraft(snapshot, hideDraft(['promo']), true), 1).record;
  const kept = inputWithoutLabel(labelled);
  assert.equal(kept.overall, null);
  assert.equal(kept.valuable, true);
  assert.deepEqual(kept.rules, []);
  assert.equal(inputWithoutLabel({ ...labelled, valuable: false }), null);
});

test('the store refuses a save from before a delete and never brings data back', async () => {
  installChrome({ local: {} });
  const snapshot = snapshotOf();
  const input = inputFromDraft(snapshot, hideDraft(['promo']), false);
  const before = await loadReviewStore();
  const saved = await saveReviewRecord(before.epoch, input, 5);
  assert.equal(saved.ok, true);
  assert.equal((await loadReviewStore()).records.length, 1);

  const epoch = await clearReviewRecords();
  assert.equal((await loadReviewStore()).records.length, 0);
  const late = await saveReviewRecord(before.epoch, input, 6);
  assert.deepEqual([late.ok, late.error], [false, 'stale-epoch']);
  assert.equal((await loadReviewStore()).records.length, 0, 'the late write did not come back');
  assert.equal((await saveReviewRecord(epoch, input, 7)).ok, true);
  const lateRemove = await removeReviewRecord(before.epoch, snapshot.sampleId, snapshot.inputHash, 'fp');
  assert.equal(lateRemove.ok, false);
  assert.equal((await loadReviewStore()).records.length, 1);
});

test('concurrent saves are serialized without losing an annotation', async () => {
  installChrome({ local: {} });
  const posts = Array.from({ length: 5 }, (_, i) => makePost({ id: String(200 + i) }));
  const results = await Promise.all(
    posts.map((post, i) => saveReviewRecord(0, inputWithValuable(snapshotOf(post), undefined, true), i)),
  );
  assert.ok(results.every((result) => result.ok));
  assert.equal((await loadReviewStore()).records.length, 5);
});

test('the page controller shows a label only after the background stored it', async () => {
  installChrome({ local: {} });
  let epoch = 0;
  let failNext = null;
  const backend = {
    load: async () => ({ ok: true, ...(await loadReviewStore()) }),
    save: async (e, input) => (failNext ? { ok: false, error: failNext } : saveReviewRecord(e, input, 1)),
    remove: async (e, key) => removeReviewRecord(e, key.sampleId, key.inputHash, key.rulesFingerprint),
  };
  let changes = 0;
  const annotations = new ReviewAnnotations(backend, () => { changes += 1; });
  assert.equal(await annotations.load(), true);
  epoch = (await loadReviewStore()).epoch;
  const snapshot = snapshotOf();

  failNext = 'storage';
  assert.deepEqual(await annotations.saveDraft(snapshot, hideDraft(['promo'])), { ok: false, error: 'storage' });
  assert.equal(annotations.recordFor(snapshot), undefined, 'a failed save shows no label');
  failNext = null;
  assert.deepEqual(await annotations.saveDraft(snapshot, hideDraft(['promo'])), { ok: true });
  assert.equal(annotations.recordFor(snapshot).overall, 'hide');
  assert.equal(annotations.labeledCount(), 1, 'the toolbar counts stored verdicts, not posts on the page');

  assert.deepEqual(await annotations.setValuable(snapshot, true), { ok: true });
  assert.equal(annotations.recordFor(snapshot).valuable, true);
  assert.equal(annotations.recordFor(snapshot).overall, 'hide', 'the flag does not touch the verdict');
  assert.deepEqual(await annotations.removeLabel(snapshot), { ok: true });
  assert.equal(annotations.recordFor(snapshot).overall, null);
  assert.equal(annotations.recordFor(snapshot).valuable, true);
  assert.equal(annotations.labeledCount(), 0, 'a flag alone is not a verdict');
  assert.deepEqual(await annotations.setValuable(snapshot, false), { ok: true });
  assert.equal(annotations.recordFor(snapshot), undefined);
  assert.equal((await loadReviewStore()).records.length, 0);
  assert.ok(changes > 0);

  // A different text or a different rule set is another annotation.
  await annotations.saveDraft(snapshot, hideDraft(['promo']));
  const edited = snapshotOf(makePost({ id: '5', text: 'a different body' }));
  assert.equal(annotations.recordFor(edited), undefined, 'an edited post does not inherit the label');
  assert.equal(epoch, 0);
});

test('a save after the store was cleared elsewhere fails once, keeps the input and then works', async () => {
  installChrome({ local: {} });
  const backend = {
    load: async () => ({ ok: true, ...(await loadReviewStore()) }),
    save: (e, input) => saveReviewRecord(e, input, 1),
    remove: (e, key) => removeReviewRecord(e, key.sampleId, key.inputHash, key.rulesFingerprint),
  };
  const annotations = new ReviewAnnotations(backend, () => {});
  await annotations.load();
  await clearReviewRecords();
  const snapshot = snapshotOf();
  assert.deepEqual(await annotations.saveDraft(snapshot, hideDraft(['promo'])), { ok: false, error: 'stale-epoch' });
  assert.deepEqual(await annotations.saveDraft(snapshot, hideDraft(['promo'])), { ok: true });
});

test('the background accepts annotations only from the X content script', async () => {
  const handle = installChrome({ local: {} });
  globalThis.defineBackground = (factory) => factory();
  await import('../../src/entrypoints/background');
  const snapshot = snapshotOf();
  const input = inputFromDraft(snapshot, hideDraft(['promo']), false);
  const message = { type: 'review-save', epoch: 0, input, source: 'blind', at: 1 };

  const fromPage = await handle.dispatchMessage(message, webPageSender());
  assert.deepEqual([fromPage.ok, fromPage.error], [false, 'wrong-sender']);
  const fromExtensionPage = await handle.dispatchMessage(message);
  assert.deepEqual([fromExtensionPage.ok, fromExtensionPage.error], [false, 'wrong-sender']);
  assert.equal((await loadReviewStore()).records.length, 0);

  const saved = await handle.dispatchMessage(message, xContentSender());
  assert.equal(saved.ok, true);
  assert.equal(saved.record.source, 'in-timeline-assisted', 'a claimed source is ignored');
  const loaded = await handle.dispatchMessage({ type: 'review-load' }, xContentSender());
  assert.equal(loaded.records.length, 1);
  assert.equal((await handle.dispatchMessage({ type: 'review-load' }, webPageSender())).ok, false);

  // Only an extension page may delete everything.
  await handle.dispatchMessage({ type: 'review-clear' }, xContentSender());
  assert.equal((await loadReviewStore()).records.length, 1);
  await handle.dispatchMessage({ type: 'review-clear' });
  assert.equal((await loadReviewStore()).records.length, 0);

  // Clearing the panel data clears the annotations as well.
  await handle.dispatchMessage({ type: 'review-save', epoch: (await loadReviewStore()).epoch, input }, xContentSender());
  assert.equal((await loadReviewStore()).records.length, 1);
  await handle.dispatchMessage({ type: 'clear-data' });
  assert.equal((await loadReviewStore()).records.length, 0);
});
