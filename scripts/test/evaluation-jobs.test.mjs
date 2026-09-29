/**
 * Phase 3 budget slice: the offline, persistent spending path for verification
 * tasks.
 *
 * Everything is offline: an in-memory `chrome.storage.local` stands in for the
 * extension store, and `fetch` throws if it is ever reached. The rates below are
 * synthetic test rates in micro-units per million tokens, not real provider
 * prices — this suite proves the arithmetic (including the ceiling), the
 * ceiling-based input reservation, the cap, the dedupe and the restart/
 * late-arrival rules, and it makes no paid call of any kind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyJobState,
  isJobState,
  JEV_1_13_MAX_INPUT_TOKENS,
  normalizeJobState,
  outstandingMicroOf,
  reservationMicro,
  settledBaselines,
} from '../../src/domain/evaluation-budget';
import { normalizeSettings } from '../../src/domain/settings';
import {
  abandonEvaluationJob,
  clearEvaluationJobs,
  disableEvaluationBudget,
  enableEvaluationBudget,
  EVALUATION_JOBS_KEY,
  loadEvaluationJobs,
  loadSettledEvaluationBaselines,
  recoverUnsettledEvaluationJobs,
  recheckActiveEvaluationJob,
  settleEvaluationJob,
  startEvaluationJob,
} from '../../src/infrastructure/evaluation-jobs';
import { installChrome } from './harness.mjs';
import { loadArchiveCounts, loadEvaluationJobsWithArchive } from '../../src/infrastructure/evaluation-archive';

const SETTINGS_KEY = 'anyfilter.settings';
const PANEL_KEY = 'anyfilter.panel';
const KEYS = { vercel: 'vck_vercel', typesafe: 'ts_typesafe' };
const CAP = 1_000_000;

/** Synthetic whole-request input ceiling, kept tiny so the arithmetic in these
 * tests still reads clearly. Not a real model limit. */
const MAX_INPUT_TOKENS = 2;

/** Synthetic rates in micro-units per million tokens; deliberately not real
 * prices. `1_000_000` here means one micro-unit per token. */
const RATES = {
  'jev-a': { model: 'jev-a', currency: 'USD', inputMicroPerMTok: 1_000_000, outputMicroPerMTok: 2_000_000 },
  'model-b': { model: 'model-b', currency: 'USD', inputMicroPerMTok: 500_000, outputMicroPerMTok: 400_000 },
  'model-c': { model: 'model-c', currency: 'USD', inputMicroPerMTok: 1, outputMicroPerMTok: 1 },
};

/** Micro owed for `tokens` at a rate in micro per million tokens, rounded up to
 * a whole micro-unit — the same ceiling the budget applies. */
function microFor(tokens, microPerMTok) {
  return Math.ceil((tokens * microPerMTok) / 1_000_000);
}

/** Reservation of {@link request} for one model, at that model's own rates. */
function reservedFor(model) {
  const rate = RATES[model];
  return microFor(MAX_INPUT_TOKENS, rate.inputMicroPerMTok) + microFor(10, rate.outputMicroPerMTok);
}

/** Settled cost of real usage at one model's rates. */
function microUsed(model, inputTokens, outputTokens) {
  const rate = RATES[model];
  return microFor(inputTokens, rate.inputMicroPerMTok) + microFor(outputTokens, rate.outputMicroPerMTok);
}

const LIMITS = [
  { model: 'jev-a', currency: 'USD', capMicro: CAP, maxInputTokens: MAX_INPUT_TOKENS },
  { model: 'model-b', currency: 'USD', capMicro: CAP, maxInputTokens: MAX_INPUT_TOKENS },
];

function seedLocal() {
  return {
    [SETTINGS_KEY]: normalizeSettings({ keys: KEYS }),
    [PANEL_KEY]: { tokens: 12, seen: {}, hidden: {}, lastFailure: null },
  };
}

/** One job request; the input side reserves the model's ceiling, not the text. */
function request(overrides = {}) {
  return {
    model: 'jev-a',
    rulesFingerprint: 'rules-1',
    ruleId: 'bait',
    inputHash: 'in-1',
    maxOutputTokens: 10,
    ...overrides,
  };
}

/** Reservation of {@link request} for its default model `jev-a`. */
const RESERVED = reservedFor('jev-a');

function enableAll(extra = {}) {
  return enableEvaluationBudget({
    prices: Object.values(RATES),
    limits: LIMITS,
    now: 0,
    ...extra,
  });
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

test('the budget is off by default and records nothing at all', async () => {
  const handle = installChrome({ local: seedLocal() });
  const before = handle.snapshot();

  const state = await loadEvaluationJobs();
  assert.equal(state.enabled, false);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.prices, []);
  assert.deepEqual(state.limits, []);

  const refused = await startEvaluationJob({ ...request(), now: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'disabled');
  assert.deepEqual(handle.snapshot(), before);
  assert.equal(handle.localKeys().includes(EVALUATION_JOBS_KEY), false);
});

test('enabling refuses an unknown price, a missing cap, a mixed currency or junk', async () => {
  installChrome({ local: seedLocal() });

  const noPrice = await enableEvaluationBudget({ prices: [], limits: [LIMITS[0]], now: 1 });
  assert.equal(noPrice.ok, false);
  assert.equal(noPrice.error, 'price-unknown');

  const otherModel = await enableEvaluationBudget({
    prices: [RATES['model-b']],
    limits: [LIMITS[0]],
    now: 1,
  });
  assert.equal(otherModel.error, 'price-unknown');

  const mixedCurrency = await enableEvaluationBudget({
    prices: [{ ...RATES['jev-a'], currency: 'EUR' }],
    limits: [LIMITS[0]],
    now: 1,
  });
  assert.equal(mixedCurrency.error, 'currency-mismatch');

  const halfPrice = await enableEvaluationBudget({
    prices: [{ model: 'jev-a', currency: 'USD', inputMicroPerMTok: 1_000_000 }],
    limits: [LIMITS[0]],
    now: 1,
  });
  assert.equal(halfPrice.error, 'invalid');

  const zeroCap = await enableEvaluationBudget({
    prices: [RATES['jev-a']],
    limits: [{ model: 'jev-a', currency: 'USD', capMicro: 0, maxInputTokens: MAX_INPUT_TOKENS }],
    now: 1,
  });
  assert.equal(zeroCap.error, 'invalid');

  const noLimits = await enableEvaluationBudget({ prices: Object.values(RATES), limits: [], now: 1 });
  assert.equal(noLimits.error, 'invalid');

  // None of the refusals switched anything on or wrote a usable budget.
  const stillOff = await loadEvaluationJobs();
  assert.equal(stillOff.enabled, false);
  assert.deepEqual(stillOff.prices, []);
  assert.equal((await startEvaluationJob({ ...request(), now: 1 })).error, 'disabled');

  const enabled = await enableAll({ now: 2 });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.state.enabled, true);
  assert.equal(enabled.state.prices.length, 3);
  assert.equal((await loadEvaluationJobs()).enabled, true);
});

test('one job reserves the whole-request input ceiling plus the declared output bound', async () => {
  installChrome({ local: seedLocal() });
  assert.equal((await enableAll()).ok, true);

  const started = await startEvaluationJob({ ...request(), now: 5 });
  assert.equal(started.ok, true);
  assert.equal(started.deduped, false);
  assert.equal(started.job.status, 'pending');
  assert.equal(started.job.currency, 'USD');
  assert.equal(started.job.epoch, 0);
  assert.equal(started.job.reservedInputTokens, MAX_INPUT_TOKENS);
  assert.equal(started.job.reservedMicro, RESERVED);
  assert.equal(started.job.settledMicro, null);

  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 1);
  assert.equal(outstandingMicroOf(state), RESERVED);

  // A non-positive output bound can never be reserved as "free".
  const zeroOutput = await startEvaluationJob({
    ...request({ inputHash: 'in-zero', maxOutputTokens: 0 }),
    now: 6,
  });
  assert.equal(zeroOutput.ok, false);
  assert.equal(zeroOutput.error, 'invalid');
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);
});

test('the worst-case reservation is enforced per model against its currency cap', async () => {
  installChrome({ local: seedLocal() });
  await enableEvaluationBudget({
    prices: Object.values(RATES),
    limits: [
      { model: 'jev-a', currency: 'USD', capMicro: RESERVED, maxInputTokens: MAX_INPUT_TOKENS },
      { model: 'model-b', currency: 'USD', capMicro: 100_000, maxInputTokens: MAX_INPUT_TOKENS },
    ],
    now: 0,
  });

  // Exactly one job fits in the cap.
  assert.equal((await startEvaluationJob({ ...request(), now: 1 })).ok, true);
  const overCap = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 2 });
  assert.equal(overCap.ok, false);
  assert.equal(overCap.error, 'cap-exceeded');

  // The other model has its own cap and its own rates, so it is unaffected.
  const other = await startEvaluationJob({
    ...request({ model: 'model-b', inputHash: 'in-3' }),
    now: 3,
  });
  assert.equal(other.ok, true);
  assert.equal(other.job.reservedMicro, reservedFor('model-b'));

  // A known price without a cap is still refused: an uncapped call is unbounded.
  const uncapped = await startEvaluationJob({
    ...request({ model: 'model-c', inputHash: 'in-4' }),
    now: 4,
  });
  assert.equal(uncapped.ok, false);
  assert.equal(uncapped.error, 'limit-unknown');

  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 2);
  assert.equal(outstandingMicroOf(state), RESERVED + reservedFor('model-b'));
});

test('the identical task is deduped and never reserves twice', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();

  const first = await startEvaluationJob({ ...request(), now: 1 });
  const again = await startEvaluationJob({ ...request(), now: 2 });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
  assert.equal(again.job.jobId, first.job.jobId);
  assert.equal(again.job.createdAt, first.job.createdAt);

  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 1);
  assert.equal(outstandingMicroOf(state), RESERVED);

  // A changed input, rule set or model is a different task, not a duplicate.
  const otherInput = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 3 });
  assert.equal(otherInput.deduped, false);
  const otherRules = await startEvaluationJob({ ...request({ rulesFingerprint: 'rules-2' }), now: 4 });
  assert.equal(otherRules.deduped, false);
  const otherRule = await startEvaluationJob({ ...request({ ruleId: 'hate' }), now: 5 });
  assert.equal(otherRule.deduped, false);
  const otherModel = await startEvaluationJob({ ...request({ model: 'model-b' }), now: 6 });
  assert.equal(otherModel.deduped, false);
  assert.equal((await loadEvaluationJobs()).jobs.length, 5);
});

test('settling releases the reservation and records the real cost, overruns included', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();

  const started = await startEvaluationJob({ ...request(), now: 1 });
  const settled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 2,
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.released, true);
  assert.equal(settled.job.status, 'settled');
  assert.equal(settled.job.settledMicro, microUsed('jev-a', 2, 1));
  assert.equal(settled.job.reservedMicro, RESERVED);

  const state = await loadEvaluationJobs();
  assert.equal(state.spentMicro['jev-a'], microUsed('jev-a', 2, 1));
  assert.equal(outstandingMicroOf(state), 0);

  const repeat = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 3,
  });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.deduped, true);
  assert.equal((await loadEvaluationJobs()).spentMicro['jev-a'], microUsed('jev-a', 2, 1));

  const stale = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 7,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 4,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale-epoch');

  // Real usage above the reservation is recorded as it happened, not clamped.
  const second = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 5 });
  const overrun = await settleEvaluationJob({
    jobId: second.job.jobId,
    epoch: 0,
    actualInputTokens: 100,
    actualOutputTokens: 100,
    now: 6,
  });
  assert.equal(overrun.ok, true);
  assert.equal(overrun.job.settledMicro, microUsed('jev-a', 100, 100));
  assert.ok(overrun.job.settledMicro > overrun.job.reservedMicro);
  assert.equal(
    (await loadEvaluationJobs()).spentMicro['jev-a'],
    microUsed('jev-a', 2, 1) + microUsed('jev-a', 100, 100),
  );
});

test('a restart marks unsettled jobs unknown, keeps their money and never retries', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });

  // A new worker finds one open job.
  const recovered = await recoverUnsettledEvaluationJobs(7);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.state.jobs[0].status, 'unknown');

  const after = await loadEvaluationJobs();
  assert.equal(after.jobs[0].status, 'unknown');
  assert.equal(after.spentMicro['jev-a'], undefined);
  assert.equal(outstandingMicroOf(after), RESERVED);

  // Starting the same task again is deduped and stays unknown: no blind retry,
  // no second reservation.
  const again = await startEvaluationJob({ ...request(), now: 8 });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
  assert.equal(again.job.status, 'unknown');
  const afterRetry = await loadEvaluationJobs();
  assert.equal(afterRetry.jobs.length, 1);
  assert.equal(outstandingMicroOf(afterRetry), RESERVED);

  // Recovery is idempotent.
  assert.equal((await recoverUnsettledEvaluationJobs(9)).recovered, 0);

  // A later, explicit reconciliation is still possible under the current epoch.
  const reconciled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 10,
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.job.status, 'settled');
  assert.equal(outstandingMicroOf(await loadEvaluationJobs()), 0);
});

test('a job that was never sent releases its reservation; a sent job never does', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();

  const unsent = await startEvaluationJob({ ...request(), now: 1 });
  const abandoned = await abandonEvaluationJob({
    jobId: unsent.job.jobId,
    epoch: 0,
    sent: false,
    now: 2,
  });
  assert.equal(abandoned.ok, true);
  assert.equal(abandoned.released, true);
  assert.deepEqual((await loadEvaluationJobs()).jobs, []);

  const sent = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 3 });
  const kept = await abandonEvaluationJob({ jobId: sent.job.jobId, epoch: 0, sent: true, now: 4 });
  assert.equal(kept.ok, true);
  assert.equal(kept.released, false);
  assert.equal(kept.job.status, 'unknown');
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs[0].status, 'unknown');
  assert.equal(outstandingMicroOf(state), RESERVED);

  const staleAbandon = await abandonEvaluationJob({
    jobId: sent.job.jobId,
    epoch: 3,
    sent: false,
    now: 5,
  });
  assert.equal(staleAbandon.ok, false);
  assert.equal(staleAbandon.error, 'stale-epoch');
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);
});

test('an already-unknown job is never refunded by an unsent abandon', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });

  // A restart turns the open job unknown; its money stays held.
  assert.equal((await recoverUnsettledEvaluationJobs(2)).recovered, 1);

  // Reporting it as never-sent must not delete it or release its reservation.
  const abandoned = await abandonEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    sent: false,
    now: 3,
  });
  assert.equal(abandoned.ok, true);
  assert.equal(abandoned.released, false);
  assert.equal(abandoned.job.status, 'unknown');

  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'unknown');
  assert.equal(outstandingMicroOf(state), RESERVED);

  // The reservation is still reconcilable, so the money is never lost.
  const reconciled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 4,
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.job.status, 'settled');
  assert.equal(outstandingMicroOf(await loadEvaluationJobs()), 0);
});

test('stopping and deleting block late writes and never refund money', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });

  const stopped = await disableEvaluationBudget(2);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.enabled, false);
  assert.equal(stopped.state.epoch, 1);
  assert.equal(stopped.state.jobs[0].status, 'unknown');
  assert.equal(outstandingMicroOf(stopped.state), RESERVED);

  const late = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 3,
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'stale-epoch');
  const afterLate = await loadEvaluationJobs();
  assert.equal(afterLate.jobs[0].status, 'unknown');
  assert.equal(afterLate.spentMicro['jev-a'], undefined);

  const cleared = await clearEvaluationJobs(4);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.state.epoch, 2);
  assert.equal(cleared.state.enabled, false);
  // Settled history is gone, but a job that still holds money is kept: its
  // reservation and its identity survive the clear.
  assert.equal(cleared.state.jobs.length, 1);
  assert.equal(cleared.state.jobs[0].status, 'unknown');
  assert.equal(outstandingMicroOf(cleared.state), RESERVED);
  // Deleting history keeps the price table and the caps.
  assert.equal(cleared.state.prices.length, 3);
  assert.equal(cleared.state.limits[0].capMicro, CAP);

  // An answer from before the clear is refused, not resurrected.
  const afterDelete = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 1,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 5,
  });
  assert.equal(afterDelete.error, 'stale-epoch');
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);

  // The identical task is still recognised after the clear, so it is not started
  // again; a genuinely new task still needs a fresh enable.
  const sameTask = await startEvaluationJob({ ...request(), now: 6 });
  assert.equal(sameTask.ok, true);
  assert.equal(sameTask.deduped, true);
  assert.equal((await loadEvaluationJobs()).jobs.length, 1);
  assert.equal((await startEvaluationJob({ ...request({ inputHash: 'in-new' }), now: 7 })).error, 'disabled');

  // Clearing again drops any settled record but keeps the held reservation.
  const reconciled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 2,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 8,
  });
  assert.equal(reconciled.ok, true);
  const clearedAgain = await clearEvaluationJobs(9);
  assert.equal(clearedAgain.state.jobs.length, 0);
  assert.equal(clearedAgain.state.spentMicro['jev-a'], microUsed('jev-a', 2, 1));
  assert.equal(clearedAgain.state.epoch, 3);
});

test('stop, clear and re-enable cannot restart a possibly-charged task or reuse its money', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });
  const jobId = started.job.jobId;

  // Stop turns the open job unknown and keeps its reservation; clear keeps it.
  await disableEvaluationBudget(2);
  const cleared = await clearEvaluationJobs(3);
  assert.equal(outstandingMicroOf(cleared.state), RESERVED);

  // Re-enable with a cap that exactly fits the one reservation still held.
  const reEnabled = await enableEvaluationBudget({
    prices: Object.values(RATES),
    limits: [
      { model: 'jev-a', currency: 'USD', capMicro: RESERVED, maxInputTokens: MAX_INPUT_TOKENS },
      { model: 'model-b', currency: 'USD', capMicro: 100_000, maxInputTokens: MAX_INPUT_TOKENS },
    ],
    now: 4,
  });
  assert.equal(reEnabled.ok, true);

  // The identical task is still the same task: it is deduped, not re-reserved,
  // and it stays unknown rather than being sent a second time.
  const restart = await startEvaluationJob({ ...request(), now: 5 });
  assert.equal(restart.ok, true);
  assert.equal(restart.deduped, true);
  assert.equal(restart.job.jobId, jobId);
  assert.equal(restart.job.status, 'unknown');

  // The held reservation still consumes the cap, so the freed budget cannot be
  // spent again on a different task.
  const otherTask = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 6 });
  assert.equal(otherTask.ok, false);
  assert.equal(otherTask.error, 'cap-exceeded');

  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.filter((job) => job.jobId === jobId).length, 1);
  assert.equal(outstandingMicroOf(state), RESERVED);
});

test('identical concurrent starts reserve once, and a settle racing a delete serializes', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();

  const [first, second] = await Promise.all([
    startEvaluationJob({ ...request(), now: 1 }),
    startEvaluationJob({ ...request(), now: 2 }),
  ]);
  assert.equal([first, second].filter((result) => result.deduped).length, 1);
  const afterStarts = await loadEvaluationJobs();
  assert.equal(afterStarts.jobs.length, 1);
  assert.equal(outstandingMicroOf(afterStarts), RESERVED);

  const jobId = first.job.jobId;
  const [settled, cleared] = await Promise.all([
    settleEvaluationJob({
      jobId,
      epoch: 0,
      actualInputTokens: 2,
      actualOutputTokens: 1,
      now: 3,
    }),
    clearEvaluationJobs(4),
  ]);
  assert.equal(settled.ok, true);
  assert.equal(settled.released, true);
  assert.equal(cleared.ok, true);
  const finalState = await loadEvaluationJobs();
  assert.deepEqual(finalState.jobs, []);
  assert.equal(finalState.spentMicro['jev-a'], microUsed('jev-a', 2, 1));
  assert.equal(finalState.epoch, 1);
});

test('a corrupted record can never switch the budget on, invent a price or hold money', async () => {
  const handle = installChrome({
    local: {
      ...seedLocal(),
      [EVALUATION_JOBS_KEY]: {
        enabled: 'yes',
        epoch: -4,
        prices: [{ model: 'jev-a' }, 'nope'],
        limits: [{ model: 'jev-a', currency: 'USD', capMicro: -1 }],
        spentMicro: { 'jev-a': -5, 'model-b': 7 },
        jobs: [{ jobId: 'x' }, { jobId: '' }],
      },
    },
  });

  const state = await loadEvaluationJobs();
  assert.equal(state.enabled, false);
  assert.deepEqual(state.prices, []);
  assert.deepEqual(state.limits, []);
  assert.deepEqual(state.spentMicro, { 'model-b': 7 });
  assert.deepEqual(state.jobs, []);
  assert.equal(state.epoch, 0);
  assert.equal((await startEvaluationJob({ ...request(), now: 1 })).error, 'disabled');

  assert.deepEqual(normalizeJobState(undefined), emptyJobState());
  assert.equal(normalizeJobState('nonsense').enabled, false);
  assert.equal(isJobState(emptyJobState()), true);
  assert.equal(isJobState({ enabled: false }), false);
  assert.equal(
    isJobState({ enabled: false, epoch: 0, prices: [], limits: [], spentMicro: {}, jobs: [] }),
    true,
  );
  assert.equal(handle.localKeys().includes(EVALUATION_JOBS_KEY), true);
});

test('the budget path touches no production key and makes no network call', async () => {
  const handle = installChrome({
    local: seedLocal(),
    session: { 'anyfilter.scores.vercel.abc.5': { bait: 0.9 } },
  });
  const calls = banFetch();

  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });
  await recoverUnsettledEvaluationJobs(2);
  await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 3,
  });
  await clearEvaluationJobs(4);

  assert.deepEqual(calls, []);
  assert.deepEqual(handle.sessionKeys(), ['anyfilter.scores.vercel.abc.5']);
  const settings = handle.readLocal(SETTINGS_KEY);
  assert.deepEqual(settings.keys, KEYS);
  assert.equal(settings.filterOn, true);
  assert.equal(handle.readLocal(PANEL_KEY).tokens, 12);
  assert.deepEqual(Object.keys(handle.readLocal(EVALUATION_JOBS_KEY)).sort(), [
    'enabled',
    'epoch',
    'jobs',
    'limits',
    'prices',
    'spentMicro',
    'updatedAt',
  ]);
});

test('the reservation is the published model ceiling, never a count derived from the text', () => {
  // The documented whole-request ceiling for TypeSafe Jev 1.13.
  assert.equal(JEV_1_13_MAX_INPUT_TOKENS, 65_536);

  // A UTF-8 byte count of a tiny input is 2. A count like that is not a token
  // count and must never be used, because the provider's own short-question
  // response already reports 296 input tokens of hidden overhead.
  assert.equal(new TextEncoder().encode('xq').length, 2);

  // Jev 1.13's verified input price is $0.042 per million tokens, i.e. 42,000
  // micro per million (0.042 micro per token); output is free. At the documented
  // ceiling the input side is 65,536 * 42,000 / 1,000,000 = 2,752.512 micro,
  // charged up to 2,753 so it can never understate the real cost.
  const price = {
    model: 'jev-1.13.0',
    currency: 'USD',
    inputMicroPerMTok: 42_000,
    outputMicroPerMTok: 0,
  };
  assert.equal(reservationMicro(price, JEV_1_13_MAX_INPUT_TOKENS, 1), 2_753);
  assert.equal(microFor(JEV_1_13_MAX_INPUT_TOKENS, 42_000), 2_753);

  // The exact per-token rate is sub-micro, so a per-token integer unit could only
  // misstate it: 0 would make the price unusable and 1 would charge the whole
  // ceiling for one token.
  assert.equal(Math.ceil(JEV_1_13_MAX_INPUT_TOKENS / 1), JEV_1_13_MAX_INPUT_TOKENS);
  assert.ok(JEV_1_13_MAX_INPUT_TOKENS > 2_753 * 20, 'per-token rounding overcharges by ~23.8x');
});

test('costs are rounded up to a whole micro-unit so a fraction can never be dropped', () => {
  const rate = { model: 'm', currency: 'USD', inputMicroPerMTok: 42_000, outputMicroPerMTok: 0 };
  // 0.042 micro -> one whole micro.
  assert.equal(reservationMicro(rate, 1, 0), 1);
  // 0.084 micro -> one whole micro (not two, but never zero).
  assert.equal(reservationMicro(rate, 2, 0), 1);
  // A free output rate contributes nothing, however large the bound.
  assert.equal(reservationMicro(rate, 0, 1_000_000), 0);
  // A zero-token call costs nothing.
  assert.equal(reservationMicro(rate, 0, 0), 0);
  // Exact division is not inflated.
  assert.equal(reservationMicro({ ...rate, inputMicroPerMTok: 1_000_000 }, 3, 0), 3);
});

test('a job reserves the whole-request ceiling no matter how small the visible input is', async () => {
  installChrome({ local: seedLocal() });
  const enabled = await enableEvaluationBudget({
    prices: [
      {
        model: 'jev-1.13.0',
        currency: 'USD',
        inputMicroPerMTok: 1_000_000,
        outputMicroPerMTok: 0,
      },
    ],
    limits: [
      {
        model: 'jev-1.13.0',
        currency: 'USD',
        capMicro: 10_000_000,
        maxInputTokens: JEV_1_13_MAX_INPUT_TOKENS,
      },
    ],
    now: 0,
  });
  assert.equal(enabled.ok, true);

  // Output is free for this model, so a 1-token output bound costs nothing and
  // the reservation is exactly the input ceiling (1 micro per token).
  const started = await startEvaluationJob({
    model: 'jev-1.13.0',
    rulesFingerprint: 'rules-1',
    ruleId: 'bait',
    inputHash: 'in-small',
    maxOutputTokens: 1,
    now: 1,
  });
  assert.equal(started.ok, true);
  assert.equal(started.job.reservedInputTokens, JEV_1_13_MAX_INPUT_TOKENS);
  assert.equal(started.job.reservedMicro, JEV_1_13_MAX_INPUT_TOKENS);

  // A second, different task reserves the same ceiling: the reservation does not
  // depend on the text the caller happens to pass.
  const other = await startEvaluationJob({
    model: 'jev-1.13.0',
    rulesFingerprint: 'rules-1',
    ruleId: 'bait',
    inputHash: 'in-different',
    maxOutputTokens: 1,
    now: 2,
  });
  assert.equal(other.ok, true);
  assert.equal(other.job.reservedInputTokens, JEV_1_13_MAX_INPUT_TOKENS);
});

test('a limit with no verified input ceiling is refused instead of guessing one', async () => {
  installChrome({ local: seedLocal() });

  const missing = await enableEvaluationBudget({
    prices: [RATES['jev-a']],
    limits: [{ model: 'jev-a', currency: 'USD', capMicro: CAP }],
    now: 1,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'invalid');

  for (const maxInputTokens of [0, -1, 1.5, Number.POSITIVE_INFINITY, '65536']) {
    const bad = await enableEvaluationBudget({
      prices: [RATES['jev-a']],
      limits: [{ model: 'jev-a', currency: 'USD', capMicro: CAP, maxInputTokens }],
      now: 1,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid');
  }

  // None of the refusals switched the budget on.
  assert.equal((await loadEvaluationJobs()).enabled, false);
  assert.equal((await startEvaluationJob({ ...request(), now: 2 })).error, 'disabled');
});

test('a repriced or repointed alias cannot rewrite a reservation that is already held', async () => {
  installChrome({ local: seedLocal() });
  assert.equal((await enableAll()).ok, true);
  const held = await startEvaluationJob({ ...request(), now: 1 });
  assert.equal(held.ok, true);

  // The alias is repriced to a tenth of its former rate.
  const repriced = await enableEvaluationBudget({
    prices: [
      { model: 'jev-a', currency: 'USD', inputMicroPerMTok: 100_000, outputMicroPerMTok: 200_000 },
      RATES['model-b'],
    ],
    limits: [
      { model: 'jev-a', currency: 'USD', capMicro: CAP, maxInputTokens: MAX_INPUT_TOKENS },
      LIMITS[1],
    ],
    now: 2,
  });
  assert.equal(repriced.ok, true);

  // The held job keeps the rates it was reserved under and the money it holds.
  const stored = (await loadEvaluationJobs()).jobs.find((job) => job.jobId === held.job.jobId);
  assert.equal(stored.inputMicroPerMTok, RATES['jev-a'].inputMicroPerMTok);
  assert.equal(stored.reservedMicro, RESERVED);

  // Only a task reserved after the change uses the new rate.
  const fresh = await startEvaluationJob({ ...request({ inputHash: 'in-after' }), now: 3 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.job.inputMicroPerMTok, 100_000);
  assert.equal(
    fresh.job.reservedMicro,
    microFor(MAX_INPUT_TOKENS, 100_000) + microFor(10, 200_000),
  );
});

test('an overrun is recorded as it happened and the cap stays over-consumed', async () => {
  installChrome({ local: seedLocal() });
  const enabled = await enableEvaluationBudget({
    prices: Object.values(RATES),
    limits: [
      { model: 'jev-a', currency: 'USD', capMicro: RESERVED, maxInputTokens: MAX_INPUT_TOKENS },
      LIMITS[1],
    ],
    now: 0,
  });
  assert.equal(enabled.ok, true);

  const started = await startEvaluationJob({ ...request(), now: 1 });
  assert.equal(started.ok, true);
  const settled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 100,
    actualOutputTokens: 100,
    now: 2,
  });
  assert.equal(settled.ok, true);

  const actual = microUsed('jev-a', 100, 100);
  assert.equal(settled.job.settledMicro, actual);
  assert.ok(actual > RESERVED, 'the overrun is larger than the reservation');
  assert.equal(settled.job.reservedMicro, RESERVED); // kept for audit, unchanged

  const state = await loadEvaluationJobs();
  assert.equal(state.spentMicro['jev-a'], actual);

  // The cap is now over-consumed, so no new task may start against it.
  const again = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 3 });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'cap-exceeded');
});

test('a duplicate price or limit row is refused instead of silently widening the cap', async () => {
  installChrome({ local: seedLocal() });

  // Two rate rows for one model: the cheaper one must not win by position.
  const dupPrice = await enableEvaluationBudget({
    prices: [RATES['jev-a'], { ...RATES['jev-a'], inputMicroPerMTok: 1 }],
    limits: [LIMITS[0]],
    now: 1,
  });
  assert.equal(dupPrice.ok, false);
  assert.equal(dupPrice.error, 'invalid');

  // Two cap rows for one model: the looser one must not win by position.
  const dupLimit = await enableEvaluationBudget({
    prices: [RATES['jev-a']],
    limits: [LIMITS[0], { ...LIMITS[0], capMicro: CAP * 2 }],
    now: 1,
  });
  assert.equal(dupLimit.ok, false);
  assert.equal(dupLimit.error, 'invalid');

  // Neither refusal switched the budget on.
  assert.equal((await loadEvaluationJobs()).enabled, false);
  assert.equal((await startEvaluationJob({ ...request(), now: 2 })).error, 'disabled');
});

test('settlement keeps the reserved rates and a currency change cannot reinterpret spend', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });

  // Re-pricing the model cheaper after the reservation must not shrink the cost
  // that is charged to the cap.
  const repriced = await enableEvaluationBudget({
    prices: [
      { model: 'jev-a', currency: 'USD', inputMicroPerMTok: 1, outputMicroPerMTok: 1 },
      RATES['model-b'],
    ],
    limits: LIMITS,
    now: 2,
  });
  assert.equal(repriced.ok, true);

  const settled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: repriced.state.epoch,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 3,
  });
  assert.equal(settled.ok, true);
  // Charged at the reserved rates, not the new cheap ones.
  assert.equal(settled.job.settledMicro, microUsed('jev-a', 2, 1));
  assert.equal((await loadEvaluationJobs()).spentMicro['jev-a'], microUsed('jev-a', 2, 1));

  // The model now holds money, so its currency cannot be swapped underneath it.
  const currencySwap = await enableEvaluationBudget({
    prices: [
      {
        model: 'jev-a',
        currency: 'EUR',
        inputMicroPerMTok: 1_000_000,
        outputMicroPerMTok: 2_000_000,
      },
    ],
    limits: [{ model: 'jev-a', currency: 'EUR', capMicro: CAP, maxInputTokens: MAX_INPUT_TOKENS }],
    now: 4,
  });
  assert.equal(currencySwap.ok, false);
  assert.equal(currencySwap.error, 'currency-mismatch');
});

test('held money blocks a currency change even after its price and limit rows are deleted', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const held = await startEvaluationJob({ ...request(), now: 1 });
  assert.equal(held.ok, true);

  // Drop the model's price and limit rows entirely, keeping only the held job.
  const dropped = await enableEvaluationBudget({
    prices: [RATES['model-b']],
    limits: [LIMITS[1]],
    now: 2,
  });
  assert.equal(dropped.ok, true);

  const state = await loadEvaluationJobs();
  assert.equal(state.prices.some((price) => price.model === 'jev-a'), false);
  assert.equal(state.limits.some((limit) => limit.model === 'jev-a'), false);
  const stillHeld = state.jobs.find((job) => job.jobId === held.job.jobId);
  assert.equal(stillHeld.status, 'pending');
  assert.equal(stillHeld.currency, 'USD');

  // Re-adding the model in another currency must be refused: the job keeps its
  // own currency, so the reservation cannot be laundered into a different unit.
  const swapped = await enableEvaluationBudget({
    prices: [
      { model: 'jev-a', currency: 'EUR', inputMicroPerMTok: 1_000_000, outputMicroPerMTok: 2_000_000 },
      RATES['model-b'],
    ],
    limits: [
      { model: 'jev-a', currency: 'EUR', capMicro: CAP, maxInputTokens: MAX_INPUT_TOKENS },
      LIMITS[1],
    ],
    now: 3,
  });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error, 'currency-mismatch');

  // Re-adding it in the same currency is still allowed, and the money is intact.
  const same = await enableEvaluationBudget({
    prices: [RATES['jev-a'], RATES['model-b']],
    limits: LIMITS,
    now: 4,
  });
  assert.equal(same.ok, true);
  assert.equal(outstandingMicroOf(await loadEvaluationJobs()), RESERVED);
});

test('settling writes the verdict and identity in the same record, and a restart restores them', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({
    ...request({ sampleId: 'sample-1', threshold: 0.7 }),
    now: 1,
  });
  assert.equal(started.ok, true);
  assert.equal(started.job.sampleId, 'sample-1');
  assert.equal(started.job.threshold, 0.7);
  assert.equal(started.job.verdict, null);

  const settled = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    sampleId: 'sample-1',
    threshold: 0.7,
    answeredModel: 'jev-a',
    verdict: { status: 'decided', score: 0.9 },
    now: 2,
  });
  assert.equal(settled.ok, true);
  assert.deepEqual(settled.job.verdict, { status: 'decided', score: 0.9 });
  assert.equal(settled.job.answeredModel, 'jev-a');
  assert.equal(settled.job.settledMicro, microUsed('jev-a', 2, 1));

  // Money and verdict are one stored record; the restore reads it with no call.
  const baselines = await loadSettledEvaluationBaselines();
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].sampleId, 'sample-1');
  assert.equal(baselines[0].ruleId, 'bait');
  assert.equal(baselines[0].threshold, 0.7);
  assert.deepEqual(baselines[0].verdict, { status: 'decided', score: 0.9 });
  assert.equal(baselines[0].settledInputTokens, 2);
  assert.equal(baselines[0].settledOutputTokens, 1);
  assert.equal(baselines[0].settledMicro, microUsed('jev-a', 2, 1));
  assert.equal(baselines[0].answeredModel, 'jev-a');
});

test('a settle without a verdict is settled-without-result and yields no baseline', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });
  await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    now: 2,
  });
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs[0].status, 'settled');
  assert.equal(state.jobs[0].verdict, null);
  assert.deepEqual(settledBaselines(state), []);
  assert.deepEqual(await loadSettledEvaluationBaselines(), []);
});

test('an invalid verdict is refused and never settles the job', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();
  const started = await startEvaluationJob({ ...request(), now: 1 });
  const bad = await settleEvaluationJob({
    jobId: started.job.jobId,
    epoch: 0,
    actualInputTokens: 2,
    actualOutputTokens: 1,
    verdict: { status: 'decided', score: 1.5 },
    now: 2,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid');
  assert.equal((await loadEvaluationJobs()).jobs[0].status, 'pending');
});

test('a settled job with a corrupted verdict keeps its money but is settled-without-result', async () => {
  installChrome({
    local: {
      ...seedLocal(),
      [EVALUATION_JOBS_KEY]: {
        enabled: true,
        epoch: 0,
        prices: [RATES['jev-a']],
        limits: [LIMITS[0]],
        spentMicro: {},
        updatedAt: 0,
        jobs: [
          {
            jobId: 'job.x',
            sampleId: 'sample-1',
            model: 'jev-a',
            currency: 'USD',
            inputMicroPerMTok: 1_000_000,
            outputMicroPerMTok: 2_000_000,
            rulesFingerprint: 'rules-1',
            ruleId: 'bait',
            inputHash: 'in-1',
            threshold: 0.7,
            reservedInputTokens: MAX_INPUT_TOKENS,
            maxOutputTokens: 10,
            reservedMicro: RESERVED,
            settledMicro: 4,
            settledInputTokens: 2,
            settledOutputTokens: 1,
            answeredModel: 'jev-a',
            verdict: { status: 'decided', score: '0.9' },
            status: 'settled',
            epoch: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    },
  });
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'settled');
  assert.equal(state.jobs[0].verdict, null);
  assert.equal(state.jobs[0].settledMicro, 4);
  assert.deepEqual(settledBaselines(state), []);
});

test('the pre-send recheck fails closed after a stop, a delete or a recovery', async () => {
  installChrome({ local: seedLocal() });
  await enableAll();

  // Active while the reservation is still pending.
  const active = await startEvaluationJob({ ...request(), now: 1 });
  assert.equal((await recheckActiveEvaluationJob(active.job.jobId, 0)).ok, true);

  // A stop bumps the epoch and turns the job unknown: refused.
  await disableEvaluationBudget(2);
  const afterStop = await recheckActiveEvaluationJob(active.job.jobId, 0);
  assert.equal(afterStop.ok, false);
  assert.equal(afterStop.error, 'stale-epoch');

  // A delete bumps the epoch too: a still-held job is refused.
  await enableAll({ now: 3 });
  const second = await startEvaluationJob({ ...request({ inputHash: 'in-2' }), now: 4 });
  await clearEvaluationJobs(5);
  const afterClear = await recheckActiveEvaluationJob(second.job.jobId, second.job.epoch);
  assert.equal(afterClear.ok, false);
  assert.equal(afterClear.error, 'stale-epoch');

  // A recovery turns a pending job unknown: a send is refused.
  await enableAll({ now: 6 });
  const third = await startEvaluationJob({ ...request({ inputHash: 'in-3' }), now: 7 });
  await recoverUnsettledEvaluationJobs(8);
  const afterRecover = await recheckActiveEvaluationJob(third.job.jobId, third.job.epoch);
  assert.equal(afterRecover.ok, false);
  assert.equal(afterRecover.error, 'not-pending');

  // A job that does not exist is refused rather than assumed active.
  const missing = await recheckActiveEvaluationJob('job.missing', third.job.epoch);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not-found');
});
test('a settled answer outlives the job store cap and a repeat is found in the archive', async () => {
  installChrome({ local: seedLocal() });
  banFetch();
  await enableAll();

  // 260 tasks is more than the 200 settled jobs the job store keeps.
  for (let i = 0; i < 260; i += 1) {
    const started = await startEvaluationJob({ ...request({ inputHash: `in-${i}` }), sampleId: `s${i}`, threshold: 0.5, now: 1 });
    assert.equal(started.ok, true, `start ${i}`);
    const settled = await settleEvaluationJob({
      jobId: started.job.jobId,
      epoch: 0,
      actualInputTokens: 2,
      actualOutputTokens: 1,
      sampleId: `s${i}`,
      threshold: 0.5,
      verdict: { status: 'decided', score: 0.9 },
      now: 2,
    });
    assert.equal(settled.ok, true, `settle ${i}`);
  }

  const kept = await loadEvaluationJobs();
  assert.ok(kept.jobs.length <= 200, 'the job store still sheds');
  assert.equal((await loadArchiveCounts())['jev-a'], 260);
  const all = await loadEvaluationJobsWithArchive(kept);
  assert.equal(settledBaselines(all).length, 260);
  assert.equal(new Set(settledBaselines(all).map((b) => b.sampleId)).size, 260);
  assert.equal((await loadSettledEvaluationBaselines()).length, 260);

  // The oldest task was shed from the job store; repeating it is a free dedupe.
  const spentBefore = (await loadEvaluationJobs()).spentMicro['jev-a'];
  const repeat = await startEvaluationJob({ ...request({ inputHash: 'in-0' }), sampleId: 's0', threshold: 0.5, now: 3 });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.deduped, true);
  assert.deepEqual(repeat.job.verdict, { status: 'decided', score: 0.9 });
  assert.equal((await loadEvaluationJobs()).spentMicro['jev-a'], spentBefore);

  // Deleting the job history deletes the archive with it.
  await clearEvaluationJobs(4);
  assert.deepEqual(await loadArchiveCounts(), {});
  assert.equal((await loadEvaluationJobsWithArchive(await loadEvaluationJobs())).jobs.length, 0);
});
