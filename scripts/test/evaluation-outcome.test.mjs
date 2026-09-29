/**
 * Outcome slice: pairing an already-captured sample with what the production
 * feed actually did, without changing filtering semantics.
 *
 * Everything is offline: an in-memory `chrome.storage`, a fake timeline that
 * records every hide/show and is asserted to stay unchanged by the reporting
 * path, and a fake classifier whose scores are supplied per test. No network, no
 * provider key, no model, no real sample.
 *
 * The load-bearing distinctions these tests pin down:
 * - a reported `no-match` is only a *negative candidate* when the feed really
 *   kept a post for which at least one text-decided rule applied;
 * - a thread-linked hide is recorded as `hidden`, not as a kept negative;
 * - a late outcome for a deleted or paused workflow can never attach;
 * - turning reporting off (or leaving it inactive) leaves filtering identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureInputHash,
  isCaptureOutcome,
  isNegativeCandidate,
  isUncertainOutcome,
  MAX_OUTCOMES_PER_SAMPLE,
  observedStateJson,
  outcomeFingerprint,
  sampleIdFor,
  sampleOf,
  withOutcome,
} from '../../src/domain/capture';
import { isRuntimeMessage } from '../../src/domain/messages';
import { postContentKey } from '../../src/domain/post';
import { normalizeSettings } from '../../src/domain/settings';
import { compileRules } from '../../src/domain/rule-compiler';
import { FeedFilter } from '../../src/features/feed-filter';
import { PassiveOutcomeReporter } from '../../src/features/evaluation-capture';
import {
  loadCaptureSamples,
  loadCaptureState,
  recordCaptureOutcomes,
  recordObservations,
  setCaptureRunState,
} from '../../src/infrastructure/capture-store';
import { installChrome, makePost } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';

function installStorage() {
  return installChrome({
    local: { [SETTINGS_KEY]: normalizeSettings({ keys: { vercel: '', typesafe: '' } }) },
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A valid outcome for `post`, with per-test overrides. */
function outcomeFor(post, overrides = {}) {
  return {
    sampleId: sampleIdFor(post),
    postId: post.id,
    threadId: post.thread,
    inputHash: captureInputHash(observedStateJson(post)),
    contentKey: 'ck-1',
    rulesFingerprint: 'rf-1',
    compilerVersion: 1,
    // The threshold actually applied to this post; part of the configuration
    // identity, because the rule fingerprint does not cover it.
    threshold: 0.7,
    stage: 'scored',
    status: 'no-match',
    detail: 'scored',
    matchedRuleIds: [],
    keepReasons: [],
    hasParent: false,
    textDecidable: true,
    threadAction: 'shown',
    threadSize: 1,
    scoreTruncated: false,
    at: 1,
    ...overrides,
  };
}

// ------------------------------------------------------------ outcome contract

test('a valid outcome is accepted and junk is rejected', () => {
  const post = makePost({ id: '7', text: 'a post about compilers' });
  assert.equal(isCaptureOutcome(outcomeFor(post)), true);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), status: 'maybe' }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), detail: 'guessed' }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), stage: 'somewhere' }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), threadAction: 'vibes' }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), matchedRuleIds: [1] }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), sampleId: '' }), false);
  // The threshold is part of the configuration identity, so an absent or
  // impossible value must never be accepted as a usable record.
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), threshold: 1.5 }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), threshold: -0.1 }), false);
  assert.equal(isCaptureOutcome({ ...outcomeFor(post), threshold: 'high' }), false);
  const noThreshold = { ...outcomeFor(post) };
  delete noThreshold.threshold;
  assert.equal(isCaptureOutcome(noThreshold), false);
  assert.equal(isCaptureOutcome({}), false);
  assert.equal(isCaptureOutcome(null), false);
});

test('a threshold change is a different configuration, not a duplicate', () => {
  const post = makePost({ id: '7' });
  const sample = sampleOf(post, { page: 'home', pageUrl: 'https://x.com/home', capturedAt: 1 });
  const atDefault = outcomeFor(post);
  const atHigher = { ...atDefault, threshold: 0.9 };

  // The rule fingerprint cannot see a threshold change, so the threshold itself
  // has to make the two observations distinguishable.
  assert.equal(atDefault.rulesFingerprint, atHigher.rulesFingerprint);
  assert.notEqual(outcomeFingerprint(atDefault), outcomeFingerprint(atHigher));

  const both = withOutcome(withOutcome(sample, atDefault), atHigher);
  assert.equal(both.outcomes.length, 2);
  assert.deepEqual(
    both.outcomes.map((outcome) => outcome.threshold),
    [0.7, 0.9],
  );
  // Re-reporting an identical snapshot stays idempotent.
  assert.equal(withOutcome(both, atHigher).outcomes.length, 2);
});

test('only a kept, acted-on, text-decided no-match is a negative candidate', () => {
  const post = makePost({ id: '7' });
  const base = outcomeFor(post);
  assert.equal(isNegativeCandidate(base), true);
  assert.equal(isUncertainOutcome(base), false);

  // Thread-linked hidden posts, own posts, prompts with no decidable rule and
  // any decided hit are never negatives.
  assert.equal(isNegativeCandidate({ ...base, threadAction: 'hidden' }), false);
  assert.equal(isNegativeCandidate({ ...base, threadAction: 'none' }), false);
  assert.equal(isNegativeCandidate({ ...base, detail: 'own' }), false);
  assert.equal(isNegativeCandidate({ ...base, textDecidable: false }), false);
  assert.equal(isNegativeCandidate({ ...base, status: 'match' }), false);
  assert.equal(isNegativeCandidate({ ...base, status: 'error' }), false);
  assert.equal(isNegativeCandidate({ ...base, status: 'undecided' }), false);
  for (const rejected of [
    { ...base, threadAction: 'hidden' },
    { ...base, detail: 'own' },
    { ...base, textDecidable: false },
    { ...base, status: 'match' },
  ]) {
    assert.equal(isUncertainOutcome(rejected), true);
  }
});

test('an attached outcome is idempotent and bounded per sample', () => {
  const post = makePost({ id: '7' });
  const sample = sampleOf(post, { page: 'home', pageUrl: 'https://x.com/home', capturedAt: 1 });
  const first = outcomeFor(post);

  const once = withOutcome(sample, first);
  assert.equal(once.outcomes.length, 1);
  assert.deepEqual(once.outcomes[0], first);

  // The same snapshot never inflates the count.
  assert.equal(withOutcome(once, first).outcomes.length, 1);

  // A different observation is kept, and the oldest are shed at the cap.
  let bounded = sample;
  for (let i = 0; i < MAX_OUTCOMES_PER_SAMPLE + 3; i += 1) {
    bounded = withOutcome(bounded, {
      ...first,
      at: 100 + i,
      matchedRuleIds: [`rule-${i}`],
    });
  }
  assert.equal(bounded.outcomes.length, MAX_OUTCOMES_PER_SAMPLE);
  assert.equal(
    bounded.outcomes[bounded.outcomes.length - 1].matchedRuleIds[0],
    `rule-${MAX_OUTCOMES_PER_SAMPLE + 2}`,
  );
});

// ------------------------------------------------------------- offline store

test('a valid outcome for a stored sample attaches; the same snapshot never inflates', async () => {
  const handle = installStorage();
  const started = await setCaptureRunState('active');
  const post = makePost({ id: '1', text: 'a post about compilers' });
  await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [post],
  });
  const sample = (await loadCaptureSamples())[0];
  assert.ok(sample);

  const outcome = {
    ...outcomeFor(post),
    inputHash: sample.inputHash,
    contentKey: sample.contentKey,
  };
  const first = await recordCaptureOutcomes({ epoch: started.epoch, outcomes: [outcome] });
  assert.deepEqual(first, { ok: true, stored: 1, skipped: 0 });

  const repeat = await recordCaptureOutcomes({ epoch: started.epoch, outcomes: [outcome] });
  assert.deepEqual(repeat, { ok: true, stored: 0, skipped: 1 });
  assert.equal((await loadCaptureSamples())[0].outcomes.length, 1);

  // Only the capture keys were touched.
  assert.deepEqual(handle.sessionKeys(), []);
});

test('an outcome can never attach to another post or an edited sample', async () => {
  installStorage();
  const started = await setCaptureRunState('active');
  const post = makePost({ id: '1', text: 'a post about compilers' });
  await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [post],
  });
  const sample = (await loadCaptureSamples())[0];

  const unknown = { ...outcomeFor(makePost({ id: '999' })) };
  const edited = {
    ...outcomeFor(post),
    sampleId: sample.sampleId,
    inputHash: 'different-input',
    contentKey: sample.contentKey,
  };

  const result = await recordCaptureOutcomes({
    epoch: started.epoch,
    outcomes: [unknown, edited],
  });
  assert.deepEqual(result, { ok: true, stored: 0, skipped: 2 });
  assert.equal((await loadCaptureSamples())[0].outcomes, undefined);
});

test('the store validates the recorded threshold instead of trusting the caller', async () => {
  installStorage();
  const started = await setCaptureRunState('active');
  const post = makePost({ id: '1', text: 'a post about compilers' });
  await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [post],
  });
  const sample = (await loadCaptureSamples())[0];
  const base = { ...outcomeFor(post), inputHash: sample.inputHash, contentKey: sample.contentKey };

  // A threshold that is not a probability can never be stored and later read as
  // "the same configuration" as a real judgement.
  const noThreshold = { ...base };
  delete noThreshold.threshold;
  const refused = await recordCaptureOutcomes({
    epoch: started.epoch,
    outcomes: [noThreshold, { ...base, threshold: 1.5 }, { ...base, threshold: 'high' }],
  });
  assert.deepEqual(refused, { ok: true, stored: 0, skipped: 3 });
  assert.equal((await loadCaptureSamples())[0].outcomes, undefined);

  // A real threshold is kept exactly as judged, not silently normalised away.
  const stored = await recordCaptureOutcomes({
    epoch: started.epoch,
    outcomes: [{ ...base, threshold: 0.9 }],
  });
  assert.deepEqual(stored, { ok: true, stored: 1, skipped: 0 });
  assert.equal((await loadCaptureSamples())[0].outcomes[0].threshold, 0.9);
});

test('a paused, cleared or stale outcome batch is refused and never written', async () => {
  installStorage();
  const started = await setCaptureRunState('active');
  const post = makePost({ id: '1', text: 'a post about compilers' });
  await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [post],
  });
  const sample = (await loadCaptureSamples())[0];
  const outcome = {
    ...outcomeFor(post),
    inputHash: sample.inputHash,
    contentKey: sample.contentKey,
  };

  const paused = await setCaptureRunState('paused');
  const whilePaused = await recordCaptureOutcomes({ epoch: paused.epoch, outcomes: [outcome] });
  assert.equal(whilePaused.ok, false);
  assert.equal(whilePaused.error, 'not-active');

  // A batch that started before a delete is stale, not a write.
  const resumed = await setCaptureRunState('active');
  const stale = await recordCaptureOutcomes({ epoch: started.epoch, outcomes: [outcome] });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale-epoch');
  assert.equal(stale.ok === false && stale.detail.includes(String(resumed.epoch)), true);
  assert.equal((await loadCaptureSamples())[0].outcomes, undefined);
});

test('only the outcome message is accepted, and only with a valid shape', () => {
  const post = makePost({ id: '7' });
  const outcome = outcomeFor(post);
  assert.equal(isRuntimeMessage({ type: 'capture-outcome', epoch: 1, outcomes: [outcome] }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-outcome', epoch: 1, outcomes: [] }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-outcome', epoch: -1, outcomes: [outcome] }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-outcome', epoch: 1.5, outcomes: [outcome] }), false);
  assert.equal(
    isRuntimeMessage({ type: 'capture-outcome', epoch: 1, outcomes: [{ sampleId: 'x' }] }),
    false,
  );
  assert.equal(
    isRuntimeMessage({ type: 'capture-outcome', epoch: 1, outcomes: Array(21).fill(outcome) }),
    false,
  );
  assert.equal(isRuntimeMessage({ type: 'capture-outcome', epoch: 1, outcomes: 'x' }), false);
});

// ------------------------------------------------------------ feed reporting

/** A timeline double: records every show/hide and never touches a real DOM. */
class FakeTimeline {
  constructor(posts) {
    this.posts = new Map(posts.map((post) => [post.id, post]));
    this.actions = [];
  }
  scan() {
    return [...this.posts.values()];
  }
  read(postId) {
    return this.posts.get(postId) ?? null;
  }
  unmark() {}
  hide(postId) {
    this.actions.push(['hide', postId]);
  }
  show(postId) {
    this.actions.push(['show', postId]);
  }
  onChange() {
    return () => {};
  }
}

function settingsWith(overrides = {}) {
  return normalizeSettings({ keys: { vercel: 'k', typesafe: '' }, ...overrides });
}

/** Runs one scan and waits for the async judgements to settle. */
async function run(filter) {
  filter.start();
  await settle();
}

test('an active reporter records the real outcome of a kept post', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '11', text: 'a post about compilers' });
  const view = new FakeTimeline([post]);
  const reports = [];
  const reporter = {
    captureEpoch: () => 5,
    reportOutcome: (epoch, outcome) => reports.push({ epoch, outcome }),
  };
  // A real answer covers every question that was asked; here every rule is
  // answered below the threshold, which is what a genuine kept post looks like.
  const classifier = {
    classify: async (_post, questions) => ({
      ok: true,
      scores: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
      tokens: 3,
    }),
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const scored = reports.find((entry) => entry.outcome.stage === 'scored');
  assert.ok(scored, 'a scored outcome was reported');
  assert.equal(scored.epoch, 5);
  assert.equal(scored.outcome.status, 'no-match');
  assert.equal(scored.outcome.threadAction, 'shown');
  assert.equal(scored.outcome.textDecidable, true);
  assert.equal(scored.outcome.sampleId, sampleIdFor(post));
  assert.deepEqual(scored.outcome.matchedRuleIds, []);
  assert.equal(scored.outcome.rulesFingerprint, compileRules(settings.rules).key);
  // The threshold actually applied is recorded, because the rule fingerprint
  // cannot tell two thresholds apart.
  assert.equal(scored.outcome.threshold, settings.threshold);
  assert.equal(isNegativeCandidate(scored.outcome), true);
  // The pending observation precedes the decided one, so an unfinished call is
  // never mistaken for a keep.
  assert.equal(reports[0].outcome.stage, 'pending');
  assert.equal(reports[0].outcome.status, 'undecided');
});

test('a decided hit is recorded as a match with the thread action actually taken', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '20', text: 'buy my course now' });
  const view = new FakeTimeline([post]);
  const reports = [];
  const reporter = {
    captureEpoch: () => 5,
    reportOutcome: (_epoch, outcome) => reports.push(outcome),
  };
  const classifier = {
    classify: async () => ({ ok: true, scores: { promo: 0.95 }, tokens: 3 }),
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const scored = reports.find((outcome) => outcome.stage === 'scored');
  assert.equal(scored.status, 'match');
  assert.equal(scored.threadAction, 'hidden');
  assert.deepEqual(scored.matchedRuleIds, ['promo']);
  assert.equal(isNegativeCandidate(scored), false);
  assert.ok(view.actions.some(([action, id]) => action === 'hide' && id === '20'));
});

test('a thread-linked hide is recorded as hidden, not as a kept negative', async () => {
  installStorage();
  const settings = settingsWith();
  const matching = makePost({ id: '30', thread: 't30', text: 'buy my course now' });
  const sibling = makePost({ id: '31', thread: 't30', text: 'an ordinary reply', kind: 'reply' });
  const view = new FakeTimeline([matching, sibling]);
  const reports = [];
  const reporter = {
    captureEpoch: () => 5,
    reportOutcome: (_epoch, outcome) => reports.push(outcome),
  };
  const classifier = {
    classify: async (post, questions) =>
      post.id === '30'
        ? { ok: true, scores: { promo: 0.95 }, tokens: 3 }
        : {
            ok: true,
            scores: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
            tokens: 3,
          },
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const siblingOutcome = reports.find((outcome) => outcome.postId === '31' && outcome.stage === 'scored');
  assert.ok(siblingOutcome, 'the sibling was judged');
  assert.equal(siblingOutcome.status, 'no-match');
  assert.deepEqual(siblingOutcome.matchedRuleIds, []);
  // It did not match itself, yet the whole thread was hidden, so it is not a
  // negative example of a kept post.
  assert.equal(siblingOutcome.threadAction, 'hidden');
  assert.equal(siblingOutcome.threadSize, 2);
  assert.equal(isNegativeCandidate(siblingOutcome), false);
});

test('an own post and a prompt with no semantic rule are never negatives', async () => {
  installStorage();
  const settings = settingsWith({ rules: settingsWith().rules.map((rule) => ({ ...rule, enabled: false })) });
  const own = makePost({ id: '40', text: 'my own post', own: true });
  const view = new FakeTimeline([own]);
  const reports = [];
  const reporter = { captureEpoch: () => 5, reportOutcome: (_e, outcome) => reports.push(outcome) };
  const classifier = { classify: async () => ({ ok: true, scores: {}, tokens: 0 }) };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const ownOutcome = reports.find((outcome) => outcome.postId === '40');
  assert.equal(ownOutcome.stage, 'rule-only');
  assert.equal(ownOutcome.status, 'no-match');
  assert.equal(ownOutcome.detail, 'own');
  assert.equal(ownOutcome.textDecidable, false);
  assert.equal(isNegativeCandidate(ownOutcome), false);
  // No semantic rule was enabled, so the provider was never called.
  assert.equal(reports.some((outcome) => outcome.stage === 'scored'), false);
});

test('a failed call is recorded as an error, never as a kept negative', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '50', text: 'a post about compilers' });
  const view = new FakeTimeline([post]);
  const reports = [];
  const reporter = { captureEpoch: () => 5, reportOutcome: (_e, outcome) => reports.push(outcome) };
  const classifier = {
    classify: async () => ({ ok: false, error: 'auth', detail: 'rejected' }),
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const failed = reports.find((outcome) => outcome.stage === 'failed');
  assert.equal(failed.status, 'error');
  assert.equal(failed.detail, 'failed-terminal');
  assert.equal(isNegativeCandidate(failed), false);
});

test('with no reporter, or an inactive capture epoch, filtering is unchanged and nothing is reported', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '60', text: 'buy my course now' });
  const reports = [];
  const inactive = { captureEpoch: () => 0, reportOutcome: (_e, outcome) => reports.push(outcome) };

  for (const reporter of [null, inactive, undefined]) {
    const view = new FakeTimeline([post]);
    const classifier = {
      classify: async () => ({ ok: true, scores: { promo: 0.95 }, tokens: 3 }),
    };
    const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter ?? undefined);
    await run(filter);
    // The hit post is still hidden exactly as before.
    assert.ok(view.actions.some(([action, id]) => action === 'hide' && id === '60'));
    assert.deepEqual(reports, []);
    filter.stop();
  }
});

// -------------------------------------------------- reporter buffering safety

test('the reporter collapses repeated observations of one sample into the latest', async () => {
  installStorage();
  const submitted = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const reporter = new PassiveOutcomeReporter(async (epoch, outcomes) => {
    submitted.push({ epoch, outcomes: outcomes.map((outcome) => ({ ...outcome })) });
    if (submitted.length === 1) {
      started();
      return gate;
    }
    return { ok: true, stored: outcomes.length, skipped: 0 };
  });

  reporter.applyState({ runState: 'active', epoch: 4, stored: 0, skipped: 0, updatedAt: 0 });
  const a = makePost({ id: '70' });
  const b = makePost({ id: '71' });
  reporter.reportOutcome(4, outcomeFor(a));
  await firstStarted;

  // Two newer observations arrive while the first batch is still in flight.
  reporter.reportOutcome(4, { ...outcomeFor(a), at: 2 });
  reporter.reportOutcome(4, outcomeFor(b));
  release({ ok: true, stored: 1, skipped: 0 });
  await settle();

  assert.equal(submitted.length, 2);
  assert.deepEqual(
    submitted[1].outcomes.map((outcome) => [outcome.sampleId, outcome.at]),
    [[sampleIdFor(a), 2], [sampleIdFor(b), 1]],
  );
  reporter.stop();
});

test('a delete while a batch is in flight drops the buffer and is never undone', async () => {
  installStorage();
  const submitted = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const reporter = new PassiveOutcomeReporter(async (epoch, outcomes) => {
    submitted.push({ epoch, outcomes });
    started();
    return gate;
  });

  reporter.applyState({ runState: 'active', epoch: 4, stored: 0, skipped: 0, updatedAt: 0 });
  const post = makePost({ id: '70' });
  reporter.reportOutcome(4, outcomeFor(post));
  await firstStarted;

  // A delete bumps the epoch: the buffered work must not be re-sent.
  reporter.applyState({ runState: 'active', epoch: 5, stored: 0, skipped: 0, updatedAt: 0 });
  release({ ok: true, stored: 1, skipped: 0 });
  await settle();
  assert.equal(submitted.length, 1);

  // While paused nothing is even attempted.
  reporter.applyState({ runState: 'paused', epoch: 6, stored: 0, skipped: 0, updatedAt: 0 });
  reporter.reportOutcome(6, outcomeFor(post));
  await settle();
  assert.equal(submitted.length, 1);

  reporter.stop();
});

test('the reporter ignores an outcome for a different epoch and retries a refused batch', async () => {
  installStorage();
  const submitted = [];
  const results = [
    { ok: false, error: 'stale-epoch', detail: 'stale' },
    { ok: true, stored: 0, skipped: 1 },
  ];
  let index = 0;
  const reporter = new PassiveOutcomeReporter(async (epoch, outcomes) => {
    submitted.push({ epoch, outcomes });
    return results[Math.min(index++, results.length - 1)];
  });

  reporter.applyState({ runState: 'active', epoch: 7, stored: 0, skipped: 0, updatedAt: 0 });
  const post = makePost({ id: '80' });
  // An outcome stamped with another epoch is ignored before any submit.
  reporter.reportOutcome(9, outcomeFor(post));
  await settle();
  assert.deepEqual(submitted, []);

  reporter.reportOutcome(7, outcomeFor(post));
  await settle();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].epoch, 7);
  reporter.stop();
});

test('an inactive reporter never asks the feed for an epoch', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '90', text: 'a post about compilers' });
  const view = new FakeTimeline([post]);
  let asked = 0;
  const classifier = { classify: async () => ({ ok: true, scores: {}, tokens: 0 }) };
  const reporter = {
    captureEpoch: () => {
      asked += 1;
      return 0;
    },
    reportOutcome: () => {
      throw new Error('a zero epoch must never report');
    },
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);
  assert.ok(asked > 0);
  assert.equal(view.actions.some(([action]) => action === 'hide'), false);
});

// ------------------------------------- pairing with the input that was judged

test('a mid-flight DOM change cannot make another text claim the judgement', async () => {
  installStorage();
  const settings = settingsWith();
  // The feed judges `judged`; every later re-read returns the re-rendered article,
  // which is what a tweet cell that changed during the call looks like.
  const judged = makePost({ id: '77', text: 'the text that was sent' });
  const rerendered = makePost({ id: '77', text: 'the text the DOM shows later' });
  const view = new FakeTimeline([judged]);
  view.read = () => rerendered;
  const reports = [];
  const reporter = {
    captureEpoch: () => 5,
    reportOutcome: (_epoch, outcome) => reports.push(outcome),
  };
  const classifier = {
    classify: async (_post, questions) => ({
      ok: true,
      scores: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
      tokens: 2,
    }),
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const scored = reports.find((outcome) => outcome.stage === 'scored');
  assert.ok(scored, 'a scored outcome was reported');
  // The identity describes the input that was sent, never the later DOM read.
  assert.equal(scored.sampleId, sampleIdFor(judged));
  assert.equal(scored.inputHash, captureInputHash(observedStateJson(judged)));
  assert.equal(scored.contentKey, postContentKey(judged));
  assert.notEqual(scored.inputHash, captureInputHash(observedStateJson(rerendered)));

  // So it attaches to the sample of the same text and is refused by the sample of
  // the text the page showed afterwards.
  const started = await setCaptureRunState('active');
  const capturedAt = Date.now();
  await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt,
    posts: [judged, rerendered],
  });
  const result = await recordCaptureOutcomes({ epoch: started.epoch, outcomes: [scored] });
  assert.deepEqual(result, { ok: true, stored: 1, skipped: 0 });
  const samples = await loadCaptureSamples();
  const paired = samples.find((sample) => sample.sampleId === sampleIdFor(judged));
  const other = samples.find((sample) => sample.sampleId === sampleIdFor(rerendered));
  assert.ok(paired && other, 'both texts were stored as separate samples');
  assert.equal(paired.outcomes.length, 1);
  assert.equal(other.outcomes, undefined);
});

test('an unanswered rule is undecided, never a kept negative', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '88', text: 'a post about compilers' });
  const view = new FakeTimeline([post]);
  const reports = [];
  const reporter = {
    captureEpoch: () => 5,
    reportOutcome: (_epoch, outcome) => reports.push(outcome),
  };
  // The provider answered one rule and left every other asked question out. The
  // classifier still reports this as a successful, partial answer.
  const classifier = {
    classify: async () => ({ ok: true, scores: { promo: 0.1 }, tokens: 3 }),
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const scored = reports.find((outcome) => outcome.stage === 'scored');
  assert.ok(scored, 'a scored outcome was reported');
  assert.equal(scored.detail, 'scored');
  // "No rule matched" was never decided, so it must not be a negative candidate.
  assert.equal(scored.status, 'undecided');
  assert.deepEqual(scored.matchedRuleIds, []);
  assert.equal(isNegativeCandidate(scored), false);
  assert.equal(isUncertainOutcome(scored), true);
  // The post itself is still kept exactly as before.
  assert.equal(view.actions.some(([action]) => action === 'hide'), false);
});

// ------------------------------------------- capture epoch locked per request

test('a late result is dropped when the run it started in was paused and resumed', async () => {
  installStorage();
  const settings = settingsWith();
  const post = makePost({ id: '95', text: 'a post about compilers' });
  const view = new FakeTimeline([post]);
  const reports = [];
  let epoch = 5;
  const reporter = {
    captureEpoch: () => epoch,
    reportOutcome: (stamped, outcome) => reports.push({ stamped, outcome }),
  };
  // The pause and resume happen while the provider request is in flight, so the
  // answer comes back to a run that is no longer the one that asked.
  const classifier = {
    classify: async (_post, questions) => {
      epoch = 6;
      return {
        ok: true,
        scores: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
        tokens: 3,
      };
    },
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  // Only the observation made while the old epoch was still current is reported;
  // the late scored result is not restamped with the new epoch.
  assert.deepEqual(reports.map(({ outcome }) => outcome.stage), ['pending']);
  assert.equal(reports.every(({ stamped }) => stamped === 5), true);
  assert.equal(reports.some(({ outcome }) => outcome.stage === 'scored'), false);
  // Filtering is untouched: the kept post is not hidden either way.
  assert.equal(view.actions.some(([action]) => action === 'hide'), false);
});

test('a new judgement after a resume reports again under the new epoch', async () => {
  installStorage();
  const settings = settingsWith();
  const first = makePost({ id: '96', text: 'a post about compilers' });
  const second = makePost({ id: '97', text: 'another post about compilers' });
  const view = new FakeTimeline([first, second]);
  const reports = [];
  let epoch = 5;
  const reporter = {
    captureEpoch: () => epoch,
    reportOutcome: (stamped, outcome) => reports.push({ stamped, outcome }),
  };
  // The pause and resume land while the first request is in flight. The epoch is
  // locked per judgement, not per feed, so the second judgement — started after
  // the resume — is still reported under the new epoch.
  const classifier = {
    classify: async (post, questions) => {
      if (post.id === '96') epoch = 6;
      return {
        ok: true,
        scores: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
        tokens: 3,
      };
    },
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings, reporter);
  await run(filter);

  const staged = (postId) =>
    reports.filter(({ outcome }) => outcome.postId === postId).map(({ outcome }) => outcome.stage);
  // The first judgement's late result is dropped; the second one is recorded.
  assert.deepEqual(staged('96'), ['pending']);
  assert.deepEqual(staged('97'), ['pending', 'scored']);
  assert.equal(
    reports.filter(({ outcome }) => outcome.postId === '97').every(({ stamped }) => stamped === 6),
    true,
  );
  assert.equal(view.actions.some(([action]) => action === 'hide'), false);
});