/**
 * The minimal in-extension manual verification entry point: the projection the
 * panel may see, the pinned configuration, the sender gate, and the guarantee
 * that deleting a sample can never be rewritten by a late response.
 *
 * Everything is offline. `chrome.storage` is in-memory, `fetch` is a recorder,
 * and the rates are the real published ones only so the arithmetic can be
 * asserted: no account, key or provider is ever contacted. Every refused path is
 * asserted to make exactly zero network calls and to leave storage untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleOf, senderKind } from '../../src/domain/capture';
import { JEV_1_13_MAX_INPUT_TOKENS, MICRO_PER_UNIT, formatMicro } from '../../src/domain/evaluation-budget';
import {
  budgetStatusOf,
  candidatesOf,
  enabledSemanticRuleOptions,
  isVerificationCandidates,
  isVerificationDetailResult,
  isVerificationEnableResult,
  isVerificationRunResult,
  isVerificationStopResult,
  sampleDetailOf,
  verificationDetailFlags,
  verificationDisclosure,
} from '../../src/domain/evaluation-verification';
import { isRuntimeMessage } from '../../src/domain/messages';
import { normalizeSettings } from '../../src/domain/settings';
import { clearCaptureSamples, loadCaptureSamples, loadCaptureState, recordObservations, setCaptureRunState } from '../../src/infrastructure/capture-store';
import { JEV_LIMIT, JEV_MODEL, JEV_PRICE, JEV_REQUEST_URL } from '../../src/infrastructure/evaluation-jev';
import {
  EVALUATION_JOBS_KEY,
  loadEvaluationJobs,
  startEvaluationJob,
} from '../../src/infrastructure/evaluation-jobs';
import {
  disableVerificationBudget,
  enableVerificationBudget,
  loadVerificationCandidates,
  loadVerificationSampleDetail,
  loadVerificationStatus,
  runVerificationSample,
} from '../../src/infrastructure/evaluation-verification';
import {
  extensionPageSender,
  installChrome,
  installFetch,
  jsonResponse,
  makePost,
  TEST_EXTENSION_ID,
  webPageSender,
  xContentSender,
} from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const PANEL_KEY = 'anyfilter.panel';
const SAMPLES_KEY = 'anyfilter.capture.samples';
const KEYS = { vercel: 'vck_vercel', typesafe: 'ts_typesafe' };
const RULE_ID = 'bait';

function eligibleSample(overrides = {}) {
  return sampleOf(
    makePost({ handle: 'ada', name: 'Ada Lovelace', text: 'a post about compilers', ...overrides }),
    { page: 'home', pageUrl: 'https://x.com/home', capturedAt: Date.now() },
  );
}

function localWith(samples, overrides = {}) {
  const local = {
    [SETTINGS_KEY]: normalizeSettings({ keys: KEYS, ...overrides }),
    [PANEL_KEY]: { tokens: 12, seen: {}, hidden: {}, lastFailure: null },
  };
  if (samples.length > 0) local[SAMPLES_KEY] = samples;
  return local;
}

/** The TypeSafe answer shape, with both token counts under the provider names. */
function typesafeAnswer({ scores = {}, model = JEV_MODEL, usage } = {}) {
  const answers = {};
  for (const [id, value] of Object.entries(scores)) {
    answers[id] = { type: 'boolean', noul: value };
  }
  const data = { answers, model };
  if (usage !== null) data.usage = usage ?? { input_tokens: 300, output_tokens: 5 };
  return jsonResponse(data);
}

/** Fails any test that reaches the network. */
function banFetch() {
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(String(url));
    throw new Error(`unexpected network call to ${url}`);
  };
  return calls;
}

async function active(sample, overrides = {}) {
  const handle = installChrome({ local: localWith([sample], overrides) });
  const started = await setCaptureRunState('active');
  assert.equal(started.runState, 'active');
  return handle;
}

const run = (sender, sampleId, ruleId = RULE_ID) =>
  runVerificationSample(sender, TEST_EXTENSION_ID, sampleId, ruleId);

// ------------------------------------------------------------ what the panel sees

test('a candidate exposes only an excerpt, the truncation flag and a source', () => {
  const post = makePost({
    id: '777',
    handle: 'ada',
    name: 'Ada Lovelace',
    text: 'x'.repeat(400),
    quotedText: 'a quoted post',
    parent: { id: '900', name: 'Grace', handle: 'grace', text: 'the post above', avatarUrl: '' },
    promoted: true,
    truncated: true,
  });
  const sample = sampleOf(post, {
    page: 'status',
    pageUrl: 'https://x.com/ada/status/777',
    capturedAt: 4242,
  });
  const candidates = candidatesOf([sample]);

  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.deepEqual(Object.keys(candidate).sort(), [
    'capturedAt',
    'excerpt',
    'hasParent',
    'page',
    'pageUrl',
    'postId',
    'promoted',
    'sampleId',
    'truncated',
  ]);
  assert.equal(candidate.excerpt, sample.excerpt);
  assert.equal(candidate.excerpt.length, 141);
  assert.equal(candidate.truncated, true);
  assert.equal(candidate.promoted, true);
  assert.equal(candidate.page, 'status');
  assert.equal(candidate.pageUrl, 'https://x.com/ada/status/777');
  assert.equal(candidate.hasParent, true);
  assert.equal(candidate.capturedAt, 4242);
  // The stored snapshot, the handle and the content key never leave the projection.
  const serialized = JSON.stringify(candidates);
  assert.equal(serialized.includes('stateJson'), false);
  assert.equal(serialized.includes('quoted post'.slice(0, 5)), false);
  assert.equal(serialized.includes('contentKey'), false);
  assert.equal(serialized.includes('"handle"'), false);

  assert.equal(candidatesOf([eligibleSample()])[0].hasParent, false);
  assert.equal(isVerificationCandidates(candidates), true);
  assert.equal(isVerificationCandidates([{ sampleId: 'x' }]), false);
});

test('only enabled semantic rules are offerable, with an effective threshold', () => {
  const settings = normalizeSettings({ threshold: 0.7, keys: KEYS, disabled: ['bait'] });
  const options = enabledSemanticRuleOptions(settings);

  assert.equal(options.some((option) => option.id === 'ads'), false, 'a local detector is never a question');
  assert.equal(options.some((option) => option.id === 'bait'), false, 'a disabled rule asks nothing');
  assert.equal(options.length, 8);
  assert.deepEqual(
    options.map((option) => option.id),
    ['promo', 'platitude', 'hate', 'politics', 'nsfw', 'porn', 'spam', 'crypto'],
  );
  assert.ok(options.every((option) => option.threshold === 0.7 && option.label !== ''));

  const withOverride = normalizeSettings({
    keys: KEYS,
    rules: normalizeSettings({ keys: KEYS }).rules.map((rule) =>
      rule.id === 'spam' ? { ...rule, scope: 'replies', threshold: 0.9 } : rule,
    ),
  });
  const spam = enabledSemanticRuleOptions(withOverride).find((option) => option.id === 'spam');
  assert.equal(spam.scope, 'replies');
  assert.equal(spam.threshold, 0.9);
});

test('the spending picture is derived from the stored budget only', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith([sample]) });

  const before = await loadVerificationStatus();
  assert.equal(before.enabled, false);
  assert.equal(before.capMicro, null);
  assert.equal(before.availableMicro, null, 'no cap is never read as unlimited money');
  assert.equal(before.model, JEV_MODEL);
  assert.equal(formatMicro(before.spentMicro, before.currency), 'USD 0.000000');

  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  const after = await loadVerificationStatus();
  assert.equal(after.enabled, true);
  assert.equal(after.capMicro, MICRO_PER_UNIT);
  assert.equal(after.spentMicro, 0);
  assert.equal(after.reservedMicro, 0);
  assert.equal(after.availableMicro, MICRO_PER_UNIT);
  assert.equal(after.openJobs, 0);

  // The derivation itself, on a synthetic state, keeps the three amounts apart.
  const status = budgetStatusOf(
    {
      enabled: true,
      epoch: 0,
      prices: [JEV_PRICE],
      limits: [JEV_LIMIT],
      spentMicro: { [JEV_MODEL]: 13 },
      jobs: [{ model: JEV_MODEL, status: 'unknown', reservedMicro: 2753 }],
      updatedAt: 0,
    },
    JEV_MODEL,
  );
  assert.equal(status.spentMicro, 13);
  assert.equal(status.reservedMicro, 2753);
  assert.equal(status.openJobs, 1);
  assert.equal(status.availableMicro, MICRO_PER_UNIT - 13 - 2753);
});

test('the disclosure states the pinned model, the cap, the irreversibility and the limits', () => {
  const status = {
    enabled: true,
    model: JEV_MODEL,
    currency: 'USD',
    capMicro: MICRO_PER_UNIT,
    spentMicro: 0,
    reservedMicro: 0,
    availableMicro: MICRO_PER_UNIT,
    openJobs: 0,
    updatedAt: 0,
  };
  const text = verificationDisclosure(status).join('\n');

  assert.ok(text.includes('TypeSafe Jev 1.13'));
  assert.ok(text.includes(JEV_MODEL));
  assert.ok(text.includes('USD 1.000000'), 'the real cap is stated, not a rounded slogan');
  assert.ok(text.includes('may be charged'));
  assert.ok(text.includes('cannot be recalled or refunded'));
  assert.ok(text.includes('third-party content'));
  assert.ok(text.includes('Confirm that this one post may be sent'));
  assert.ok(text.includes('not an accuracy rate'));
  assert.ok(text.includes('held as unknown'));
  // A budget that was never enabled still states a cap rather than showing "null".
  assert.ok(verificationDisclosure({ ...status, capMicro: null }).join(' ').includes('USD 1'));
});

// ------------------------------------------------------------- wire contracts

test('the two verification messages are accepted only in their exact shape', () => {
  assert.equal(isRuntimeMessage({ type: 'jev-enable-budget' }), true);
  assert.equal(isRuntimeMessage({ type: 'jev-disable-budget' }), true);
  // A stop carries nothing; any extra field is accepted as a message but read as
  // nothing, exactly like the enable message.
  assert.equal(isRuntimeMessage({ type: 'jev-disable-budget', capMicro: 999_999 }), true);
  assert.equal(isRuntimeMessage({ type: 'jev-run-sample', sampleId: 'a', ruleId: 'bait' }), true);
  // Only the two identifiers may be named; nothing else is required or honoured.
  assert.equal(
    isRuntimeMessage({ type: 'jev-run-sample', sampleId: 'a', ruleId: 'bait', model: 'x', key: 'y' }),
    true,
  );
  assert.equal(isRuntimeMessage({ type: 'jev-run-sample', sampleId: 'a' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-run-sample', sampleId: '', ruleId: 'bait' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-run-sample', sampleId: 'a', ruleId: '' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-run-sample', sampleId: 'a'.repeat(129), ruleId: 'bait' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-run-sample', sampleId: 1, ruleId: 'bait' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-run' }), false);
});

test('the result validators reject junk and accept a real skipped result', () => {
  assert.equal(
    isVerificationRunResult({ kind: 'skipped', sampleId: 'a', ruleId: 'b', reason: 'no-key', detail: '' }),
    true,
  );
  assert.equal(
    isVerificationRunResult({ kind: 'skipped', sampleId: 'a', ruleId: 'b', reason: 'made-up', detail: '' }),
    false,
  );
  const trace = {
    sampleId: 'a',
    postId: '1',
    threadId: '1',
    ruleId: 'bait',
    requestedModel: JEV_MODEL,
    answeredModel: JEV_MODEL,
    rulesFingerprint: 'f',
    threshold: 0.7,
    inputHash: 'h',
    truncated: false,
    inputTokens: 300,
    outputTokens: 5,
    costMicro: 13,
    jobId: 'job.1',
  };
  assert.equal(isVerificationRunResult({ kind: 'match', score: 0.9, trace }), true);
  assert.equal(isVerificationRunResult({ kind: 'unknown', detail: 'x', trace: { ...trace, costMicro: null } }), true);
  assert.equal(isVerificationRunResult({ kind: 'match', score: 0.9 }), false);
  assert.equal(isVerificationRunResult({ kind: 'match', score: 0.9, trace: { ...trace, costMicro: 1.5 } }), false);
  assert.equal(isVerificationEnableResult({ ok: true, detail: '', status: null }), false);
  const stoppedStatus = {
    enabled: false,
    model: JEV_MODEL,
    currency: 'USD',
    capMicro: MICRO_PER_UNIT,
    spentMicro: 0,
    reservedMicro: 13,
    availableMicro: MICRO_PER_UNIT - 13,
    openJobs: 1,
    updatedAt: 0,
  };
  assert.equal(isVerificationStopResult({ ok: true, detail: '', status: stoppedStatus }), true);
  assert.equal(isVerificationStopResult({ ok: false, detail: 'x', status: stoppedStatus }), true);
  assert.equal(isVerificationStopResult({ ok: true, detail: '', status: null }), false);
  assert.equal(isVerificationStopResult({ ok: true, status: stoppedStatus }), false);
});

// ------------------------------------------------------------- the sender gate

test('a content script can never run a verification, whatever the message claims', async () => {
  const sample = eligibleSample();
  const handle = await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  const calls = banFetch();
  const before = handle.snapshot();

  const contentResult = await run(xContentSender(), sample.sampleId);
  assert.equal(contentResult.kind, 'skipped');
  assert.equal(contentResult.reason, 'wrong-sender');

  const webResult = await run(webPageSender(), sample.sampleId);
  assert.equal(webResult.kind, 'skipped');
  assert.equal(webResult.reason, 'wrong-sender');

  const foreignResult = await run({ id: 'other-extension', url: 'chrome-extension://other/sidepanel.html' }, sample.sampleId);
  assert.equal(foreignResult.kind, 'skipped');
  assert.equal(foreignResult.reason, 'wrong-sender');

  const anonymousResult = await run({}, sample.sampleId);
  assert.equal(anonymousResult.kind, 'skipped');
  assert.equal(anonymousResult.reason, 'wrong-sender');

  assert.deepEqual(calls, [], 'a refused sender never reaches the network');
  assert.deepEqual(handle.snapshot(), before, 'a refused sender writes nothing at all');
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

test('a content script can never switch the budget on, even with an injected price table', async () => {
  const sample = eligibleSample();
  const handle = installChrome({ local: localWith([sample]) });
  const calls = banFetch();
  const before = handle.snapshot();

  const content = await enableVerificationBudget(xContentSender(), TEST_EXTENSION_ID);
  const web = await enableVerificationBudget(webPageSender(), TEST_EXTENSION_ID);

  assert.equal(content.ok, false);
  assert.equal(content.status.enabled, false);
  assert.equal(web.ok, false);
  assert.equal(web.status.enabled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(handle.snapshot(), before);
  assert.equal(handle.localKeys().includes(EVALUATION_JOBS_KEY), false);
});

test('only an extension page may switch the budget on, with the pinned price and cap', async () => {
  const sample = eligibleSample();
  const handle = await active(sample);
  const calls = banFetch();

  const result = await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);

  assert.equal(result.ok, true);
  assert.equal(result.detail, '');
  assert.equal(result.status.enabled, true);
  assert.equal(result.status.model, JEV_MODEL);
  assert.equal(result.status.capMicro, MICRO_PER_UNIT);
  const state = handle.readLocal(EVALUATION_JOBS_KEY);
  assert.deepEqual(state.prices[0], JEV_PRICE);
  assert.deepEqual(state.limits[0], JEV_LIMIT);
  assert.deepEqual(state.prices.map((row) => row.model), ['jev-1.13.0', 'gpt-6-luna', 'gpt-6-sol', 'deepseek-flash']);
  assert.equal(JEV_LIMIT.maxInputTokens, JEV_1_13_MAX_INPUT_TOKENS);
  assert.deepEqual(calls, []);
});

test('only an extension page may stop the budget; a refused stop writes nothing', async () => {
  const sample = eligibleSample({ id: '7301', text: 'a post kept open across a refused stop' });
  const handle = await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  const calls = banFetch();
  const before = handle.snapshot();

  for (const sender of [
    xContentSender(),
    webPageSender(),
    { id: 'other-extension', url: 'chrome-extension://other/sidepanel.html' },
    {},
  ]) {
    const refused = await disableVerificationBudget(sender, TEST_EXTENSION_ID);
    assert.equal(refused.ok, false);
    assert.equal(refused.status.enabled, true, 'a refused stop leaves the budget on');
  }

  assert.deepEqual(calls, [], 'a refused stop never reaches the network');
  assert.deepEqual(handle.snapshot(), before, 'a refused stop writes nothing at all');
});

test('stopping marks a pending job unknown, keeps its reservation and blocks new requests', async () => {
  const sample = eligibleSample({ id: '7302', text: 'a post reserved but never sent' });
  const handle = await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);

  // Reserve one task without sending anything: a task that was started but whose
  // request had not yet left must be turned `unknown` by the stop, never guessed
  // away.
  const reserved = await startEvaluationJob({
    model: JEV_MODEL,
    rulesFingerprint: 'fp-stop',
    ruleId: RULE_ID,
    inputHash: 'hash-stop',
    maxOutputTokens: 256,
    sampleId: sample.sampleId,
    threshold: 0.7,
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.deduped, false);
  assert.equal(reserved.job.status, 'pending');

  const calls = banFetch();
  const stopped = await disableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.detail, '');
  assert.equal(stopped.status.enabled, false);

  const state = handle.readLocal(EVALUATION_JOBS_KEY);
  assert.equal(state.enabled, false);
  assert.equal(state.epoch, 1, 'the stop bumps the epoch so a late answer is refused');
  assert.equal(state.jobs[0].status, 'unknown');
  const held = state.jobs[0].reservedMicro;
  assert.ok(held > 0, 'an unknown job still holds its reservation');
  assert.equal(stopped.status.reservedMicro, held, 'stopping never refunds the reservation');
  assert.equal(stopped.status.openJobs, 1);
  assert.equal(stopped.status.availableMicro, MICRO_PER_UNIT - held);
  assert.deepEqual(calls, [], 'stopping is entirely local');

  // With the budget off, a new request is refused before anything is reserved or
  // sent, and the settle path is already blocked by the bumped epoch.
  const after = await run(extensionPageSender(), sample.sampleId);
  assert.equal(after.kind, 'skipped');
  assert.equal(after.reason, 'budget-disabled');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);
});

test('a disabled or local rule and an unknown sample are refused without a request', async () => {
  const sample = eligibleSample();
  await active(sample, { disabled: ['bait'] });
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  const calls = banFetch();

  // `bait` is a semantic rule that the user disabled; `ads` is a local detector.
  const disabled = await run(extensionPageSender(), sample.sampleId, 'bait');
  assert.equal(disabled.kind, 'skipped');
  assert.equal(disabled.reason, 'rule-not-compiled');

  const local = await run(extensionPageSender(), sample.sampleId, 'ads');
  assert.equal(local.kind, 'skipped');
  assert.equal(local.reason, 'rule-not-compiled');

  const missing = await run(extensionPageSender(), '999999.deadbeef', 'promo');
  assert.equal(missing.kind, 'skipped');
  assert.equal(missing.reason, 'sample-not-found');

  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

test('the budget must be switched on before an extension page can spend anything', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith([sample]) });
  const calls = banFetch();

  const result = await run(extensionPageSender(), sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'budget-disabled');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

// ---------------------------------------------------------------- the one call

test('one click runs one sample against one rule, pinned to Jev 1.13', async () => {
  const sample = eligibleSample();
  const handle = await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  const calls = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 } }));

  const first = await run(extensionPageSender(), sample.sampleId);
  assert.equal(first.kind, 'match');
  assert.equal(first.score, 0.9);
  assert.equal(first.trace.requestedModel, 'jev-1.13.0');
  assert.equal(first.trace.answeredModel, JEV_MODEL);
  assert.equal(first.trace.inputTokens, 300);
  assert.equal(first.trace.costMicro, 13);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_REQUEST_URL);
  assert.equal(calls[0].body.model, JEV_MODEL);
  assert.notEqual(calls[0].body.model, 'jev-latest');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEYS.typesafe}`);

  const status = await loadVerificationStatus();
  assert.equal(status.spentMicro, 13);
  assert.equal(status.reservedMicro, 0);
  assert.equal(status.availableMicro, MICRO_PER_UNIT - 13);

  // The candidates, the settings, the panel and the score cache are untouched.
  assert.equal((await loadVerificationCandidates()).length, 1);
  assert.equal((await loadCaptureSamples()).length, 1);
  assert.equal(handle.readLocal(PANEL_KEY).tokens, 12);
  assert.deepEqual(handle.sessionKeys(), []);
  assert.deepEqual(handle.readLocal(SETTINGS_KEY).keys, KEYS);
});

// -------------------------------------------- deleting a sample is never undone

test('deleting the sample blocks the run and no late answer can rewrite it', async () => {
  const sample = eligibleSample({ id: '5001', text: 'a post that will be deleted' });
  const handle = await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  const calls = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 } }));

  const first = await run(extensionPageSender(), sample.sampleId);
  assert.equal(first.kind, 'match');
  assert.equal(calls.length, 1);

  // The user deletes the library. The sample record is gone and stays gone.
  const cleared = await clearCaptureSamples();
  assert.equal(cleared.stored, 0);
  assert.deepEqual(handle.readLocal(SAMPLES_KEY), []);

  const afterDelete = await run(extensionPageSender(), sample.sampleId);
  assert.equal(afterDelete.kind, 'skipped');
  assert.equal(afterDelete.reason, 'sample-not-found');
  assert.equal(calls.length, 1, 'the deleted sample is not sent again');
  assert.deepEqual(handle.readLocal(SAMPLES_KEY), [], 'nothing rewrites the deleted record');

  // Re-observing the identical post gives the identical sample id. The already
  // settled task is then recognised and rebuilt from storage: the answer is not
  // lost, and it is never paid for a second time.
  const resumed = await recordObservations({
    epoch: cleared.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [makePost({ id: '5001', handle: 'ada', name: 'Ada Lovelace', text: 'a post that will be deleted' })],
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.stored, 1);
  assert.equal((await loadCaptureSamples()).length, 1);

  const again = await run(extensionPageSender(), sample.sampleId);
  assert.equal(again.kind, 'match');
  assert.equal(again.score, 0.9);
  assert.equal(again.trace.jobId, first.trace.jobId);
  assert.equal(calls.length, 1, 'the repeat is a baseline read, not a second paid call');
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);
  // Reading a baseline writes neither the sample record nor the body.
  assert.equal((await loadCaptureSamples())[0].stateJson, sample.stateJson);
});

test('an answer with no usable usage holds the reservation and is shown as held', async () => {
  const sample = eligibleSample({ id: '6001', text: 'a post with an unreadable usage' });
  await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);
  installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 }, usage: null }));

  const result = await run(extensionPageSender(), sample.sampleId);
  assert.equal(result.kind, 'unknown');
  assert.equal(result.trace.inputTokens, null);
  assert.equal(result.trace.costMicro, null);

  const status = await loadVerificationStatus();
  assert.equal(status.spentMicro, 0);
  assert.ok(status.reservedMicro > 0, 'the worst case stays held');
  assert.equal(status.openJobs, 1);
  assert.equal(status.availableMicro, MICRO_PER_UNIT - status.reservedMicro);
});

// -------------------------------------------------- background dispatch offline

test('the background runtime listener routes by sender and ignores injected fields', async () => {
  const sample = eligibleSample({ id: '7001', text: 'a post dispatched through the listener' });
  const handle = await active(sample);
  const calls = banFetch();

  globalThis.defineBackground = (factory) => factory();
  await import('../../src/entrypoints/background');

  // A content script cannot start a run, cannot authorize one and cannot enable
  // the budget; extra fields claiming otherwise change nothing.
  const refusedRun = await handle.dispatchMessage(
    { type: 'jev-run-sample', sampleId: sample.sampleId, ruleId: RULE_ID, authorized: true },
    xContentSender(),
  );
  assert.equal(refusedRun.kind, 'skipped');
  assert.equal(refusedRun.reason, 'wrong-sender');

  const refusedEnable = await handle.dispatchMessage({ type: 'jev-enable-budget' }, xContentSender());
  assert.equal(refusedEnable.ok, false);
  assert.equal(refusedEnable.status.enabled, false);
  assert.deepEqual(calls, []);

  // A message that tries to name a model, a price, an endpoint and a key is
  // accepted as a message but none of those fields are read: the call still goes
  // to the pinned endpoint with the pinned model and the stored key.
  const injectedEnable = await handle.dispatchMessage({
    type: 'jev-enable-budget',
    prices: [{ model: 'free-model', currency: 'USD', inputMicroPerMTok: 0, outputMicroPerMTok: 0 }],
    limits: [{ model: 'free-model', currency: 'USD', capMicro: 999_999_999, maxInputTokens: 1 }],
    capMicro: 999_999_999,
  });
  assert.equal(injectedEnable.ok, true);
  assert.equal(injectedEnable.status.capMicro, MICRO_PER_UNIT);
  assert.deepEqual(handle.readLocal(EVALUATION_JOBS_KEY).prices[0], JEV_PRICE);
  assert.deepEqual(handle.readLocal(EVALUATION_JOBS_KEY).limits[0], JEV_LIMIT);

  const recorded = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.2 } }));
  const runResult = await handle.dispatchMessage({
    type: 'jev-run-sample',
    sampleId: sample.sampleId,
    ruleId: RULE_ID,
    model: 'gpt-9',
    price: 0,
    endpoint: 'https://evil.test/collect',
    key: 'stolen',
  });
  assert.equal(runResult.kind, 'no-match');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].url, JEV_REQUEST_URL);
  assert.equal(recorded[0].body.model, JEV_MODEL);
  assert.equal(recorded[0].init.headers.Authorization, `Bearer ${KEYS.typesafe}`);

  // The exact-text preview is served to our own page, refused for anyone else, and
  // neither answer leaks the body on a refusal.
  const detail = await handle.dispatchMessage({
    type: 'jev-sample-detail',
    sampleId: sample.sampleId,
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.sample.text, 'a post dispatched through the listener');
  const refusedDetail = await handle.dispatchMessage(
    { type: 'jev-sample-detail', sampleId: sample.sampleId },
    xContentSender(),
  );
  assert.equal(refusedDetail.ok, false);
  assert.equal(refusedDetail.reason, 'wrong-sender');
  assert.equal('sample' in refusedDetail, false);

  // An unrelated message type is never answered by this listener.
  const unknown = await handle.dispatchMessage({ type: 'not-a-real-message' });
  assert.equal(unknown, undefined);

  // The panel-side store helpers still report the truth after the run.
  const status = await loadVerificationStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.openJobs, 0);
  assert.equal(senderKind(extensionPageSender(), TEST_EXTENSION_ID), 'extension-page');
  assert.equal((await loadCaptureState()).stored, 1, 'verification never adds or removes samples');

  // The explicit stop is gated on our own page too, and it makes no request. A
  // content script cannot stop the budget; an extension page can, and the stop is
  // local only.
  const refusedStop = await handle.dispatchMessage(
    { type: 'jev-disable-budget' },
    xContentSender(),
  );
  assert.equal(refusedStop.ok, false);
  assert.equal(refusedStop.status.enabled, true);
  const stopped = await handle.dispatchMessage({ type: 'jev-disable-budget' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status.enabled, false);
  assert.equal(recorded.length, 1, 'stopping the budget makes no request');
  assert.equal((await loadVerificationStatus()).enabled, false);
});

// ---------------------------------------- the exact text a user must see first

test('the exact-text message and the detail validators reject junk', () => {
  assert.equal(isRuntimeMessage({ type: 'jev-sample-detail', sampleId: 'a' }), true);
  assert.equal(isRuntimeMessage({ type: 'jev-sample-detail' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-sample-detail', sampleId: '' }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-sample-detail', sampleId: 'a'.repeat(129) }), false);
  assert.equal(isRuntimeMessage({ type: 'jev-sample-detail', sampleId: 7 }), false);

  const sample = {
    sampleId: 'a',
    postId: '1',
    capturedAt: 0,
    author: { handle: '@a', name: 'A' },
    text: 't',
    quoted: null,
    replyingTo: null,
    truncated: false,
    excerptMatches: true,
  };
  assert.equal(isVerificationDetailResult({ ok: true, sample }), true);
  assert.equal(isVerificationDetailResult({ ok: true, sample: { ...sample, text: 7 } }), false);
  assert.equal(isVerificationDetailResult({ ok: true, sample: { ...sample, author: { handle: '@a' } } }), false);
  assert.equal(isVerificationDetailResult({ ok: true, sample: { ...sample, replyingTo: { author: '@b' } } }), false);
  assert.equal(isVerificationDetailResult({ ok: true, sample: { ...sample, quoted: 3 } }), false);
  assert.equal(isVerificationDetailResult({ ok: false, reason: 'unreadable', message: 'x' }), true);
  assert.equal(isVerificationDetailResult({ ok: false, reason: 'made-up', message: 'x' }), false);
  assert.equal(isVerificationDetailResult({ ok: false, message: 'x' }), false);
});

test('the exact-text projection carries the whole body plus quoted and parent text', () => {
  const post = makePost({
    id: '4242',
    handle: 'ada',
    name: 'Ada Lovelace',
    text: `headline ${'x'.repeat(400)}`,
    quotedText: 'a quoted third-party post',
    parent: { id: '9', name: 'Grace', handle: 'grace', text: 'the parent post', avatarUrl: '' },
    truncated: true,
  });
  const sample = sampleOf(post, {
    page: 'status',
    pageUrl: 'https://x.com/ada/status/4242',
    capturedAt: 1234,
  });
  const detail = sampleDetailOf(sample);

  assert.equal(detail.text, post.text, 'the full body is returned, never the excerpt');
  assert.ok(detail.text.length > 140);
  assert.deepEqual(detail.author, { handle: '@ada', name: 'Ada Lovelace' });
  assert.equal(detail.quoted, 'a quoted third-party post');
  assert.deepEqual(detail.replyingTo, { author: '@grace', text: 'the parent post' });
  assert.equal(detail.truncated, true);
  assert.equal(detail.excerptMatches, true);
  assert.equal(detail.sampleId, sample.sampleId);
  assert.equal(detail.capturedAt, 1234);

  const keys = verificationDetailFlags(detail).map((flag) => flag.key);
  assert.deepEqual(keys, ['exact-state', 'truncated', 'third-party']);
  const text = verificationDetailFlags(detail)
    .map((flag) => flag.text)
    .join('\n');
  assert.ok(text.includes('exact stored state'));
  assert.ok(text.includes('already clipped'));
  assert.ok(text.includes('written by other people'));
});

test('a clipped, mismatched or unreadable snapshot is flagged or refused, never guessed', async () => {
  const post = makePost({
    id: '4300',
    handle: 'ada',
    name: 'Ada Lovelace',
    text: `body ${'y'.repeat(300)}`,
  });
  const sample = sampleOf(post, { page: 'home', pageUrl: 'https://x.com/home', capturedAt: Date.now() });
  const plain = sampleDetailOf(sample);

  // A body that was not clipped and carries no third-party text gets only the
  // "this is the exact state" line.
  assert.deepEqual(verificationDetailFlags(plain).map((flag) => flag.key), ['exact-state']);

  // A tampered excerpt is reported as uncertain rather than silently accepted.
  const mismatched = sampleDetailOf({ ...sample, excerpt: 'a different preview' });
  assert.equal(mismatched.excerptMatches, false);
  assert.ok(verificationDetailFlags(mismatched).some((flag) => flag.key === 'excerpt-mismatch'));
  assert.ok(
    verificationDetailFlags(mismatched)
      .map((flag) => flag.text)
      .join(' ')
      .includes('uncertain'),
  );

  // A snapshot that is not the known shape or has no usable body is refused.
  for (const stateJson of [
    '{oops',
    'null',
    JSON.stringify({ text: 'no author here' }),
    JSON.stringify({ author: { handle: '@a' }, text: 'no name here' }),
    JSON.stringify({ author: { handle: '@a', name: 'A' }, text: '   ' }),
  ]) {
    assert.equal(sampleDetailOf({ ...sample, stateJson }), null, stateJson);
  }

  // Through the read path the same record is reported as unreadable, so a Send
  // button that depends on the detail stays disabled.
  installChrome({ local: localWith([{ ...sample, stateJson: '{oops' }]) });
  const refused = await loadVerificationSampleDetail(
    extensionPageSender(),
    TEST_EXTENSION_ID,
    sample.sampleId,
  );
  assert.deepEqual(refused, {
    ok: false,
    reason: 'unreadable',
    message: 'the stored sample state cannot be read as text',
  });
});

test('the exact-text read is local-only, served to our own pages and logs nothing', async () => {
  const post = makePost({
    id: '4400',
    handle: 'ada',
    name: 'Ada Lovelace',
    text: `headline ${'z'.repeat(400)}`,
    quotedText: 'a quoted third-party post',
    parent: { id: '3', name: 'Grace', handle: 'grace', text: 'the parent post', avatarUrl: '' },
    truncated: true,
  });
  const sample = sampleOf(post, {
    page: 'status',
    pageUrl: 'https://x.com/ada/status/4400',
    capturedAt: Date.now(),
  });
  const handle = installChrome({ local: localWith([sample]) });
  const calls = banFetch();
  const before = handle.snapshot();

  const logged = [];
  const spy = (...args) => logged.push(args.map(String).join(' '));
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = spy;
  console.warn = spy;
  console.error = spy;
  try {
    const own = await loadVerificationSampleDetail(
      extensionPageSender(),
      TEST_EXTENSION_ID,
      sample.sampleId,
    );
    assert.equal(own.ok, true);
    assert.equal(own.sample.text, post.text, 'the full body is returned, not the excerpt');
    assert.equal(own.sample.quoted, 'a quoted third-party post');
    assert.deepEqual(own.sample.replyingTo, { author: '@grace', text: 'the parent post' });
    assert.equal(own.sample.truncated, true);

    for (const sender of [
      xContentSender(),
      webPageSender(),
      { id: 'other-extension', url: 'chrome-extension://other/sidepanel.html' },
      {},
    ]) {
      const refused = await loadVerificationSampleDetail(sender, TEST_EXTENSION_ID, sample.sampleId);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'wrong-sender');
      assert.equal('sample' in refused, false, 'a refusal carries no body');
    }

    const missing = await loadVerificationSampleDetail(
      extensionPageSender(),
      TEST_EXTENSION_ID,
      '999999.deadbeef',
    );
    assert.equal(missing.reason, 'sample-not-found');

    // Only an exact id matches: a prefix of a real id reads nothing.
    const prefix = await loadVerificationSampleDetail(
      extensionPageSender(),
      TEST_EXTENSION_ID,
      sample.sampleId.slice(0, 6),
    );
    assert.equal(prefix.reason, 'sample-not-found');
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.deepEqual(logged, [], 'the body must never reach a log line');
  assert.deepEqual(calls, [], 'the preview reaches no network');
  assert.deepEqual(handle.snapshot(), before, 'the preview writes nothing at all');
});

// ------------------------------------- deleting a sample while a call is in flight

test('a delete during an in-flight call cannot re-write the deleted record', async () => {
  const sample = eligibleSample({ id: '8100', text: 'a post deleted while a call was in flight' });
  const handle = await active(sample);
  await enableVerificationBudget(extensionPageSender(), TEST_EXTENSION_ID);

  // A fetch that only answers once the test decides the request is in flight.
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    markStarted();
    await gate;
    return typesafeAnswer({ scores: { [RULE_ID]: 0.9 } });
  };

  const pending = run(extensionPageSender(), sample.sampleId);
  await started;
  // The user deletes the library while the request is genuinely in flight.
  const cleared = await clearCaptureSamples();
  assert.equal(cleared.stored, 0);
  assert.deepEqual(handle.readLocal(SAMPLES_KEY), []);

  release();
  const result = await pending;

  // The capture library stays deleted: no late write re-adds the record, and no
  // late write carries the body.
  assert.deepEqual(handle.readLocal(SAMPLES_KEY), [], 'the deleted record is never rewritten');
  assert.equal((await loadCaptureSamples()).length, 0);

  // The settle writes only the budget's own identity and outcome, never a body,
  // and only into the budget store.
  const jobs = (await loadEvaluationJobs()).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sampleId, sample.sampleId);
  const storedJobs = JSON.stringify(handle.readLocal(EVALUATION_JOBS_KEY));
  assert.equal(storedJobs.includes('in flight'), false, 'no body text is ever stored with a job');
  assert.equal(result.kind, 'match', 'the call really completed after the delete');

  // Re-observing the byte-identical post reuses the settled baseline rather than
  // paying again: the dangling sample id can never pair an answer with other text.
  const resumed = await recordObservations({
    epoch: cleared.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [makePost({ id: '8100', handle: 'ada', name: 'Ada Lovelace', text: 'a post deleted while a call was in flight' })],
  });
  assert.equal(resumed.stored, 1);
  const again = await run(extensionPageSender(), sample.sampleId);
  assert.equal(again.kind, 'match');
  assert.equal(again.trace.jobId, result.trace.jobId, 'the identical input reuses the settlement');
});