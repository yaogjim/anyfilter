/**
 * Phase 3 execution slice: the default-off single-sample TypeSafe Jev call.
 *
 * Everything is offline and synthetic. An in-memory `chrome.storage` stands in
 * for the extension stores, `fetch` is replaced by a recorded fake response, and
 * the rates are the real published ones only so the arithmetic can be asserted;
 * no account, key or provider is ever contacted. Every skip path is asserted to
 * make zero network calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleOf } from '../../src/domain/capture';
import { fingerprintInput } from '../../src/domain/evaluation';
import { JEV_1_13_MAX_INPUT_TOKENS, MICRO_PER_UNIT, outstandingMicroOf } from '../../src/domain/evaluation-budget';
import { compileRules } from '../../src/domain/rule-compiler';
import { normalizeSettings } from '../../src/domain/settings';
import { enableEvaluationBudget, loadEvaluationJobs, disableEvaluationBudget, clearEvaluationJobs, loadSettledEvaluationBaselines, settleEvaluationJob, startEvaluationJob, EVALUATION_JOBS_KEY } from '../../src/infrastructure/evaluation-jobs';
import {
  enableJevEvaluationBudget,
  JEV_LIMIT,
  JEV_MAX_OUTPUT_TOKENS,
  JEV_MODEL,
  JEV_PRICE,
  JEV_REQUEST_URL,
  runSingleSampleEvaluation,
} from '../../src/infrastructure/evaluation-jev';
import { installChrome, installFetch, jsonResponse, makePost } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const PANEL_KEY = 'anyfilter.panel';
const SAMPLES_KEY = 'anyfilter.capture.samples';
const KEYS = { vercel: 'vck_vercel', typesafe: 'ts_typesafe' };
const RULE_ID = 'bait';

/** The compiled question for the default `bait` rule with no parent context. */
const compiled = compileRules(normalizeSettings({}).rules, { hasParent: false });
const BAIT_QUESTION = compiled.questions[RULE_ID];
const RULES_FINGERPRINT = compiled.key;

function eligibleSample(overrides = {}) {
  return sampleOf(
    makePost({
      handle: 'ada',
      name: 'Ada Lovelace',
      text: 'a post about compilers',
      ...overrides,
    }),
    { page: 'home', pageUrl: 'https://x.com/home', capturedAt: Date.now() },
  );
}

function localWith(sampleOrSamples, keys = KEYS) {
  const local = {
    [SETTINGS_KEY]: normalizeSettings({ keys }),
    [PANEL_KEY]: { tokens: 12, seen: {}, hidden: {}, lastFailure: null },
  };
  const samples = Array.isArray(sampleOrSamples)
    ? sampleOrSamples
    : sampleOrSamples
      ? [sampleOrSamples]
      : [];
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
  if (usage !== null) {
    data.usage = usage ?? { input_tokens: 300, output_tokens: 5 };
  }
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

const run = (sampleId, overrides = {}) =>
  runSingleSampleEvaluation({ sampleId, ruleId: RULE_ID, authorized: true, ...overrides });

// --------------------------------------------------------------- fixed config

test('the slice pins a versioned model, its verified price and the USD 1 cap', () => {
  assert.equal(JEV_MODEL, 'jev-1.13.0');
  assert.notEqual(JEV_MODEL, 'jev-latest');
  assert.deepEqual(JEV_PRICE, {
    model: 'jev-1.13.0',
    currency: 'USD',
    inputMicroPerMTok: 42_000,
    outputMicroPerMTok: 0,
  });
  assert.equal(JEV_LIMIT.capMicro, MICRO_PER_UNIT);
  assert.equal(JEV_LIMIT.maxInputTokens, JEV_1_13_MAX_INPUT_TOKENS);
  assert.equal(JEV_1_13_MAX_INPUT_TOKENS, 65_536);
  assert.equal(JEV_REQUEST_URL, 'https://api.typesafe.ai/v1/systemone');
  assert.ok(JEV_MAX_OUTPUT_TOKENS > 0);
});

// ------------------------------------------------------------------ skip gate

test('an unauthorized call makes zero network requests and records nothing', async () => {
  const sample = eligibleSample();
  const handle = installChrome({ local: localWith(sample) });
  const calls = banFetch();
  await enableJevEvaluationBudget(0);

  const before = handle.snapshot();
  const result = await runSingleSampleEvaluation({ sampleId: sample.sampleId, ruleId: RULE_ID, authorized: false });

  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'not-authorized');
  assert.deepEqual(calls, []);
  assert.deepEqual(handle.snapshot(), before);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

test('a call with the budget still off makes zero requests', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  const calls = banFetch();

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'budget-disabled');
  assert.deepEqual(calls, []);
});

test('no stored TypeSafe key stops the call before any request', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample, { vercel: 'vck_only', typesafe: '' }) });
  const calls = banFetch();
  await enableJevEvaluationBudget(0);

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'no-key');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

test('a rule that compiles to no question is skipped without a request', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  const calls = banFetch();
  await enableJevEvaluationBudget(0);

  // `ads` is a local page-signal rule: it never becomes a model question.
  const result = await runSingleSampleEvaluation({ sampleId: sample.sampleId, ruleId: 'ads', authorized: true });
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'rule-not-compiled');
  assert.deepEqual(calls, []);
});

test('an unknown sample and a protected sample are both refused locally', async () => {
  const protectedSample = eligibleSample({ text: 'These posts are protected' });
  installChrome({ local: localWith(protectedSample) });
  const calls = banFetch();
  await enableJevEvaluationBudget(0);

  const missing = await run('999999.deadbeef');
  assert.equal(missing.kind, 'skipped');
  assert.equal(missing.reason, 'sample-not-found');

  const protectedResult = await run(protectedSample.sampleId);
  assert.equal(protectedResult.kind, 'skipped');
  assert.equal(protectedResult.reason, 'not-sendable');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

// ------------------------------------------------------------------ execution

test('an authorized match reserves first, sends the pinned model and settles', async () => {
  const sample = eligibleSample();
  const handle = installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 } }));

  const result = await run(sample.sampleId);

  assert.equal(result.kind, 'match');
  assert.equal(result.score, 0.9);
  assert.equal(result.trace.requestedModel, JEV_MODEL);
  assert.equal(result.trace.answeredModel, JEV_MODEL);
  assert.equal(result.trace.rulesFingerprint, RULES_FINGERPRINT);
  assert.equal(result.trace.threshold, 0.7);
  assert.equal(result.trace.inputHash, fingerprintInput(sample.stateJson, BAIT_QUESTION));
  assert.equal(result.trace.inputTokens, 300);
  assert.equal(result.trace.outputTokens, 5);
  // 300 input tokens at 42,000 micro per million, rounded up: 13 micro, output free.
  assert.equal(result.trace.costMicro, 13);

  // Exactly one request, to the fixed endpoint, with the versioned model.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_REQUEST_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ts_typesafe');
  assert.equal(calls[0].body.model, JEV_MODEL);
  assert.notEqual(calls[0].body.model, 'jev-latest');
  assert.deepEqual(calls[0].body.questions, { [RULE_ID]: { type: 'noul', instructions: BAIT_QUESTION } });
  assert.deepEqual(calls[0].body.state, JSON.parse(sample.stateJson));
  // The input sent is byte-identical to the captured snapshot, not a rebuilt one.
  assert.equal(JSON.stringify(calls[0].body.state), sample.stateJson);

  const state = await loadEvaluationJobs();
  assert.equal(state.enabled, true);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'settled');
  assert.equal(state.jobs[0].model, JEV_MODEL);
  assert.equal(state.jobs[0].inputMicroPerMTok, 42_000);
  assert.equal(state.jobs[0].outputMicroPerMTok, 0);
  assert.equal(state.spentMicro[JEV_MODEL], 13);
  assert.equal(outstandingMicroOf(state), 0);
  // The production stores are untouched and the session score cache is not used.
  assert.deepEqual(handle.readLocal(PANEL_KEY).tokens, 12);
  assert.deepEqual(handle.sessionKeys(), []);
  assert.deepEqual(handle.readLocal(SETTINGS_KEY).keys, KEYS);
});

test('a score below the threshold is a no-match and is still settled', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.1 } }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'no-match');
  assert.equal(result.score, 0.1);
  assert.equal((await loadEvaluationJobs()).jobs[0].status, 'settled');
  assert.equal(calls.length, 1);
});

test('a score exactly at the threshold is a match', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.7 } }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'match');
  assert.equal(result.score, 0.7);
});

test('a usable usage with an unusable answer is undecided, not a negative', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  // The answer for the asked rule is a string, so it can never be a confident 0.
  installFetch(() => typesafeAnswer({ scores: {}, usage: { input_tokens: 310, output_tokens: 4 } }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'undecided');
  assert.equal(result.trace.inputTokens, 310);
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs[0].status, 'settled');
  assert.equal(state.spentMicro[JEV_MODEL], Math.ceil((310 * 42_000) / 1_000_000));
});

test('an out-of-range probability is undecided, never a hit', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 1.5 } }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'undecided');
});

// ------------------------------------------------------- no blind retry / held

test('a network failure after send keeps the reservation and is never retried', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = installFetch(() => {
    throw new Error('socket hang up');
  });

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'unknown');
  assert.equal(calls.length, 1);

  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'unknown');
  assert.equal(state.spentMicro[JEV_MODEL], undefined);
  // The whole-request ceiling is still held: 65,536 * 42,000 / 1,000,000 rounded up.
  assert.equal(outstandingMicroOf(state), Math.ceil((65_536 * 42_000) / 1_000_000));

  // A repeat is deduped, so the possibly-charged call is never sent again.
  const again = await run(sample.sampleId);
  assert.equal(again.kind, 'skipped');
  assert.equal(again.reason, 'already-recorded');
  assert.equal(calls.length, 1);
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);
});

test('an aborted request counts as sent and keeps its money', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  installFetch(() => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'unknown');
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs[0].status, 'unknown');
  assert.ok(outstandingMicroOf(state) > 0);
});

test('an HTTP error response is treated as sent and keeps its money', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  installFetch(() => jsonResponse({ error: 'server' }, { status: 500 }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'unknown');
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs[0].status, 'unknown');
  assert.equal(state.spentMicro[JEV_MODEL], undefined);
  assert.ok(outstandingMicroOf(state) > 0);
});

test('a response with no usage, or only half of it, is unknown and never settled', async () => {
  const missingUsageSample = eligibleSample();
  const partialUsageSample = eligibleSample({ text: 'a different compiler post' });
  const handle = installChrome({
    local: localWith([missingUsageSample, partialUsageSample]),
  });
  await enableJevEvaluationBudget(0);
  const responses = [
    () => typesafeAnswer({ scores: { [RULE_ID]: 0.9 }, usage: null }),
    () => typesafeAnswer({ scores: { [RULE_ID]: 0.9 }, usage: { input_tokens: 300 } }),
  ];
  installFetch(() => responses.shift()());

  const missingUsage = await run(missingUsageSample.sampleId);
  assert.equal(missingUsage.kind, 'unknown');

  const partialUsage = await run(partialUsageSample.sampleId);
  assert.equal(partialUsage.kind, 'unknown');

  const state = await loadEvaluationJobs();
  assert.equal(state.spentMicro[JEV_MODEL], undefined);
  assert.equal(handle.readLocal(PANEL_KEY).tokens, 12);
});

// ----------------------------------------------------------------- reporting

test('the answered model is recorded verbatim while the request stays pinned', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 }, model: 'jev-1.13.1' }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'match');
  assert.equal(result.trace.requestedModel, 'jev-1.13.0');
  assert.equal(result.trace.answeredModel, 'jev-1.13.1');
  assert.equal(calls[0].body.model, 'jev-1.13.0');
});

test('a missing response model is reported as unknown, never as the request id', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  installFetch(() => jsonResponse({ answers: { [RULE_ID]: { type: 'boolean', noul: 0.9 } }, usage: { input_tokens: 300, output_tokens: 5 } }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'match');
  assert.equal(result.trace.answeredModel, 'unknown');
});

// -------------------------------------------------------------------- dedupe

test('an identical task is never sent twice: the repeat restores the settled baseline', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 } }));

  const first = await run(sample.sampleId);
  const second = await run(sample.sampleId);

  assert.equal(first.kind, 'match');
  // The repeat is not a call: it is rebuilt from the verdict persisted with the
  // money, so the real baseline survives a restart instead of being lost.
  assert.equal(second.kind, 'match');
  assert.equal(second.score, 0.9);
  assert.equal(second.trace.jobId, first.trace.jobId);
  assert.equal(second.trace.answeredModel, JEV_MODEL);
  assert.equal(second.trace.threshold, 0.7);
  assert.equal(second.trace.inputTokens, 300);
  assert.equal(second.trace.outputTokens, 5);
  assert.equal(second.trace.costMicro, 13);
  assert.equal(calls.length, 1);
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.spentMicro[JEV_MODEL], 13);
});

test('the settled job persists the real verdict, and a restart restores it offline', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  installFetch(() => typesafeAnswer({ scores: { [RULE_ID]: 0.9 } }));

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'match');

  // Everything the baseline needs is in the stored job: sample identity, rule,
  // input and rules fingerprints, threshold, score, response model and real
  // usage. The body and the key are not stored.
  const state = await loadEvaluationJobs();
  const job = state.jobs[0];
  assert.equal(job.sampleId, sample.sampleId);
  assert.equal(job.ruleId, RULE_ID);
  assert.equal(job.rulesFingerprint, RULES_FINGERPRINT);
  assert.equal(job.inputHash, fingerprintInput(sample.stateJson, BAIT_QUESTION));
  assert.equal(job.threshold, 0.7);
  assert.deepEqual(job.verdict, { status: 'decided', score: 0.9 });
  assert.equal(job.answeredModel, JEV_MODEL);
  assert.equal(job.settledInputTokens, 300);
  assert.equal(job.settledOutputTokens, 5);
  assert.equal(JSON.stringify(job).includes('a post about compilers'), false);

  // A restarted worker reads the baseline from storage with zero network.
  const calls = banFetch();
  const baselines = await loadSettledEvaluationBaselines();
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].sampleId, sample.sampleId);
  assert.deepEqual(baselines[0].verdict, { status: 'decided', score: 0.9 });
  assert.equal(baselines[0].threshold, 0.7);
  assert.equal(baselines[0].answeredModel, JEV_MODEL);
  assert.deepEqual(calls, []);
});

test('a settled-without-result job is a held cost, never a baseline', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = banFetch();

  // Reserve and then settle with spend only, as a spend reconciliation may.
  const started = await startEvaluationJob({
    model: JEV_MODEL,
    rulesFingerprint: RULES_FINGERPRINT,
    ruleId: RULE_ID,
    inputHash: fingerprintInput(sample.stateJson, BAIT_QUESTION),
    maxOutputTokens: JEV_MAX_OUTPUT_TOKENS,
    sampleId: sample.sampleId,
    threshold: 0.7,
  });
  assert.equal(started.ok, true);
  const settled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 300,
    actualOutputTokens: 5,
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.job.verdict, null);
  assert.deepEqual(await loadSettledEvaluationBaselines(), []);

  // A repeat cannot be sent again, and it does not invent a baseline.
  const again = await run(sample.sampleId);
  assert.equal(again.kind, 'skipped');
  assert.equal(again.reason, 'already-recorded');
  assert.deepEqual(calls, []);
});

test('a stop landing after the reservation blocks the send: zero requests, money held', async () => {
  const sample = eligibleSample();
  const handle = installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = banFetch();

  // Stop as soon as the reservation is written, before the run can fetch.
  let stopped = false;
  handle.storageChanged.addListener((changes, area) => {
    if (area !== 'local' || stopped) return;
    const next = changes[EVALUATION_JOBS_KEY]?.newValue;
    if (next && Array.isArray(next.jobs) && next.jobs.some((job) => job.status === 'pending')) {
      stopped = true;
      void disableEvaluationBudget(5);
    }
  });

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'job-inactive');
  assert.deepEqual(calls, []);

  const state = await loadEvaluationJobs();
  assert.equal(state.enabled, false);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'unknown');
  assert.ok(outstandingMicroOf(state) > 0);
});

test('a delete landing after the reservation blocks the send and keeps the held money', async () => {
  const sample = eligibleSample();
  const handle = installChrome({ local: localWith(sample) });
  await enableJevEvaluationBudget(0);
  const calls = banFetch();

  let cleared = false;
  handle.storageChanged.addListener((changes, area) => {
    if (area !== 'local' || cleared) return;
    const next = changes[EVALUATION_JOBS_KEY]?.newValue;
    if (next && Array.isArray(next.jobs) && next.jobs.some((job) => job.status === 'pending')) {
      cleared = true;
      void clearEvaluationJobs(5);
    }
  });

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'job-inactive');
  assert.deepEqual(calls, []);
  const state = await loadEvaluationJobs();
  assert.ok(outstandingMicroOf(state) > 0);
});

// ------------------------------------------------------- budget configuration

test('a budget priced only for jev-latest refuses the pinned task before any request', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  const calls = banFetch();
  await enableEvaluationBudget({
    prices: [{ model: 'jev-latest', currency: 'USD', inputMicroPerMTok: 42_000, outputMicroPerMTok: 0 }],
    limits: [{ model: 'jev-latest', currency: 'USD', capMicro: MICRO_PER_UNIT, maxInputTokens: JEV_1_13_MAX_INPUT_TOKENS }],
    now: 0,
  });

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'budget-refused');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

test('the fixed USD 1 cap is enforced: the reservation holds and the cap cannot be exceeded', async () => {
  const sample = eligibleSample();
  installChrome({ local: localWith(sample) });
  const calls = banFetch();
  // A one-micro cap cannot cover the 2,753-micro worst case, so nothing is sent.
  await enableEvaluationBudget({
    prices: [JEV_PRICE],
    limits: [{ ...JEV_LIMIT, capMicro: 1 }],
    now: 0,
  });

  const result = await run(sample.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'cap-exceeded');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});