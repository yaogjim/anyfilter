/**
 * E1 to E3: pricing table, batch gate, machine labellers and the runner.
 * Offline and synthetic: an in-memory `chrome.storage`, a recorded `fetch`, and
 * no key, account or provider is ever contacted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleOf } from '../../src/domain/capture';
import { formatMicro, reservationMicro } from '../../src/domain/evaluation-budget';
import {
  DEFAULT_BATCH_POLICY,
  runBatch,
  stepOfSkip,
} from '../../src/domain/evaluation-batch';
import {
  DEEPSEEK_SPEC,
  JEV_SPEC,
  LABELLER_SPECS,
  OPENAI_SPEC,
  budgetConfigOfAllLabellers,
  fitsInputCeiling,
  normalizeBaseUrl,
  normalizeConnection,
  specWith,
} from '../../src/domain/evaluation-pricing';
import {
  machinePromptOf,
  machineRequestOf,
  machineResponseOf,
  parseMachineAnswer,
} from '../../src/domain/machine-label';
import { compileRules } from '../../src/domain/rule-compiler';
import { normalizeSettings } from '../../src/domain/settings';
import { isRuntimeMessage } from '../../src/domain/messages';
import { normalizeJobVerdict, enableBudget, emptyJobState } from '../../src/domain/evaluation-budget';
import { buildEvaluationExport, isEvaluationRunStatus, overviewOf } from '../../src/domain/evaluation-run';
import { loadEvaluationJobs } from '../../src/infrastructure/evaluation-jobs';
import { enableEvaluationBudgets } from '../../src/infrastructure/evaluation-jev';
import { runSingleMachineLabel } from '../../src/infrastructure/evaluation-machine';
import { EVALUATION_KEYS_KEY, loadKeyPresence } from '../../src/infrastructure/evaluation-keys';
import { EVALUATION_CONNECTION_KEY, loadEvaluationConnections } from '../../src/infrastructure/evaluation-connection';
import {
  loadEvaluationExport,
  setEvaluationConnection,
  setEvaluationKey,
  startEvaluationBatch,
  stopEvaluationBatch,
} from '../../src/infrastructure/evaluation-runner';
import {
  TEST_EXTENSION_ID,
  extensionPageSender,
  installChrome,
  installFetch,
  jsonResponse,
  makePost,
  xContentSender,
} from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const SAMPLES_KEY = 'anyfilter.capture.samples';
const RULE_ID = 'bait';
const compiled = compileRules(normalizeSettings({}).rules, { hasParent: false });
const QUESTION = compiled.questions[RULE_ID];

function sample(text, handle = 'ada') {
  return sampleOf(makePost({ handle, name: 'Ada', text }), {
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
  });
}

function localWith(samples, { machineKeys = { openai: 'sk-o', deepseek: 'sk-d' } } = {}) {
  return {
    [SETTINGS_KEY]: normalizeSettings({ keys: { vercel: '', typesafe: 'ts_key' } }),
    [SAMPLES_KEY]: samples,
    ...(machineKeys ? { [EVALUATION_KEYS_KEY]: machineKeys } : {}),
  };
}

const openAiAnswer = (
  state = 'match',
  reason = 'promotes engagement',
  usage = { prompt_tokens: 700, completion_tokens: 30 },
  model = 'gpt-6-luna-2026-08-01',
) =>
  jsonResponse({
    model,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ state, reason }) } }],
    usage,
  });

const deepSeekAnswer = (state = 'no-match', reason = 'ordinary post', usage = { prompt_tokens: 650, completion_tokens: 25 }) =>
  jsonResponse({
    model: 'deepseek-flash',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ state, reason }) } }],
    usage,
  });

// ------------------------------------------------------------------- pricing

test('every labeller has a pinned model, a same-currency price and cap, and a source', () => {
  for (const spec of Object.values(LABELLER_SPECS)) {
    assert.equal(spec.price.model, spec.model);
    assert.equal(spec.limit.model, spec.model);
    assert.equal(spec.price.currency, spec.limit.currency);
    assert.ok(spec.limit.capMicro > 0 && spec.limit.maxInputTokens > 0 && spec.maxOutputTokens > 0);
    assert.match(spec.source, /^https:\/\//);
    assert.doesNotMatch(spec.model, /latest|preview/);
  }
  assert.deepEqual(
    [JEV_SPEC.model, OPENAI_SPEC.model, DEEPSEEK_SPEC.model],
    ['jev-1.13.0', 'gpt-6-luna', 'deepseek-flash'],
  );
});

test('the verified rates are stored as micro-units per million tokens', () => {
  assert.deepEqual(
    [JEV_SPEC.price.inputMicroPerMTok, JEV_SPEC.price.outputMicroPerMTok],
    [42_000, 0],
  );
  assert.deepEqual(
    [OPENAI_SPEC.price.inputMicroPerMTok, OPENAI_SPEC.price.outputMicroPerMTok],
    [100_000, 500_000],
  );
  // DeepSeek is priced at its dearest (peak, cache-miss) rate on purpose.
  assert.deepEqual(
    [DEEPSEEK_SPEC.price.inputMicroPerMTok, DEEPSEEK_SPEC.price.outputMicroPerMTok],
    [300_000, 1_200_000],
  );
});

test('the worst-case reservation per call is tiny next to its cap', () => {
  for (const spec of Object.values(LABELLER_SPECS)) {
    const held = reservationMicro(spec.price, spec.limit.maxInputTokens, spec.maxOutputTokens);
    assert.ok(held > 0 && held * 100 < spec.limit.capMicro, `${spec.id} holds ${formatMicro(held, 'USD')} per call`);
  }
});

test('one enable writes an isolated price and cap row for every labeller', () => {
  const result = enableBudget(emptyJobState(), budgetConfigOfAllLabellers(), 1);
  assert.ok(result.ok);
  assert.equal(result.state.prices.length, 4);
  assert.equal(new Set(result.state.limits.map((limit) => limit.model)).size, 4);
});

test('a prompt beyond the input ceiling is refused before it is sent', () => {
  assert.equal(fitsInputCeiling(OPENAI_SPEC, 'x'.repeat(1000)), true);
  assert.equal(fitsInputCeiling(OPENAI_SPEC, 'x'.repeat(OPENAI_SPEC.limit.maxInputTokens)), false);
  // A multibyte body is measured in bytes, which bound its tokens.
  assert.equal(fitsInputCeiling(DEEPSEEK_SPEC, '汉'.repeat(6000)), false);
});

// ------------------------------------------------------------- machine labels

test('the prompt is built from the post state and the rule only', () => {
  const prompt = machinePromptOf('{"text":"hi"}', 'Is it bait?');
  assert.match(prompt.user, /Is it bait\?/);
  assert.match(prompt.user, /\{"text":"hi"\}/);
  assert.match(prompt.system, /untrusted/);
  // No parameter can carry a score or another model's label into the prompt.
  assert.equal(machinePromptOf.length, 2);
});

test('OpenAI and DeepSeek requests pin the model, cap output and turn reasoning off', () => {
  const prompt = machinePromptOf('{}', 'q');
  const openai = machineRequestOf(OPENAI_SPEC, 'sk-o', prompt, 256);
  const body = JSON.parse(openai.body);
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.max_completion_tokens, 256);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.messages.length, 2);
  assert.equal(openai.headers.Authorization, 'Bearer sk-o');

  const deepseek = machineRequestOf(DEEPSEEK_SPEC, 'sk-d', prompt, 256);
  const dsBody = JSON.parse(deepseek.body);
  assert.equal(deepseek.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(dsBody.model, 'deepseek-flash');
  assert.equal(dsBody.max_tokens, 256);
  assert.deepEqual(dsBody.thinking, { type: 'disabled' });
  assert.deepEqual(dsBody.response_format, { type: 'json_object' });
});

test('a configured base URL and priced model change the endpoint and the price', () => {
  const relay = specWith('openai', { baseUrl: 'https://relay.example/v1', model: 'gpt-6-sol' });
  assert.equal(relay.endpoint, 'https://relay.example/v1/chat/completions');
  assert.equal(relay.model, 'gpt-6-sol');
  assert.deepEqual([relay.price.inputMicroPerMTok, relay.price.outputMicroPerMTok], [2_000_000, 10_000_000]);
  assert.equal(JSON.parse(machineRequestOf(relay, 'k', machinePromptOf('{}', 'q'), 256).body).model, 'gpt-6-sol');
  // The reservation is still a small part of the cap at the dearer model.
  assert.ok(reservationMicro(relay.price, relay.limit.maxInputTokens, relay.maxOutputTokens) * 20 < relay.limit.capMicro);
});

test('a base URL must be https without credentials, query or fragment, and the model must be priced', () => {
  assert.equal(normalizeBaseUrl('https://relay.example/v1/'), 'https://relay.example/v1');
  for (const bad of ['http://relay.example/v1', 'https://u:p@relay.example', 'https://relay.example/v1?x=1', 'https://relay.example/#a', 'nope', 42]) {
    assert.equal(normalizeBaseUrl(bad), null, String(bad));
  }
  assert.deepEqual(normalizeConnection('openai', { baseUrl: 'https://a.example', model: 'gpt-6-luna' }), { baseUrl: 'https://a.example', model: 'gpt-6-luna' });
  assert.equal(normalizeConnection('openai', { baseUrl: 'https://a.example', model: 'gpt-9-unpriced' }), null);
  assert.equal(normalizeConnection('deepseek', { baseUrl: 'https://a.example', model: 'gpt-6-sol' }), null);
});

test('responses are read strictly: usage, model and truncation', () => {
  const ok = machineResponseOf({
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { content: '{"state":"match","reason":"r"}' } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });
  assert.deepEqual([ok.inputTokens, ok.outputTokens, ok.model, ok.truncated], [5, 2, 'm', false]);
  assert.equal(machineResponseOf({ usage: { prompt_tokens: -1, completion_tokens: 1.5 } }).inputTokens, undefined);
  assert.equal(machineResponseOf({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }).truncated, true);
  assert.equal(machineResponseOf({}).text, undefined);
});

test('an answer is one of three states or nothing', () => {
  assert.deepEqual(parseMachineAnswer('{"state":"no-match","reason":"fine"}'), { state: 'no-match', reason: 'fine' });
  assert.deepEqual(parseMachineAnswer('```json\n{"state":"undecided","reason":"?"}\n```'), { state: 'undecided', reason: '?' });
  assert.equal(parseMachineAnswer('{"state":"maybe"}'), null);
  assert.equal(parseMachineAnswer('not json'), null);
  assert.equal(parseMachineAnswer(undefined), null);
  const long = parseMachineAnswer(JSON.stringify({ state: 'match', reason: 'x'.repeat(1000) }));
  assert.equal(long.reason.length, 280);
  assert.equal(parseMachineAnswer('{"state":"match","reason":"a\\u0000b\\nc"}').reason, 'a b c');
});

test('a labelled verdict survives normalization and refuses a made-up state', () => {
  assert.deepEqual(normalizeJobVerdict({ status: 'labelled', state: 'match', reason: ' r ' }), {
    status: 'labelled',
    state: 'match',
    reason: 'r',
  });
  assert.equal(normalizeJobVerdict({ status: 'labelled', state: 'sure', reason: 'r' }), null);
  assert.equal(normalizeJobVerdict({ status: 'labelled', state: 'match' }), null);
});

// ------------------------------------------------------------------ batch gate

const task = (n) => ({ sampleId: `s${n}`, ruleId: 'r' });
const tasks = (count) => Array.from({ length: count }, (_, i) => task(i));

test('a batch runs every task and counts each outcome', async () => {
  const seen = [];
  const result = await runBatch({
    tasks: tasks(6),
    execute: async (t) => {
      seen.push(t.sampleId);
      if (t.sampleId === 's1') return { kind: 'repeat' };
      if (t.sampleId === 's2') return { kind: 'skipped', reason: 'x' };
      return { kind: 'recorded' };
    },
  });
  assert.equal(seen.length, 6);
  assert.deepEqual(
    [result.recorded, result.repeats, result.skipped, result.failed, result.halted, result.finished],
    [4, 1, 1, 0, null, true],
  );
});

test('exceeding the cap stops the batch and starts nothing more', async () => {
  let started = 0;
  const result = await runBatch({
    tasks: tasks(50),
    policy: { concurrency: 1 },
    execute: async () => {
      started += 1;
      return started > 3 ? stepOfSkip('cap-exceeded', 'over the cap') : { kind: 'recorded' };
    },
  });
  assert.equal(started, 4);
  assert.equal(result.halted, 'budget');
  assert.equal(result.recorded, 3);
  assert.match(result.haltDetail, /cap-exceeded/);
});

test('with concurrency a halt lets in-flight tasks finish but starts no new one', async () => {
  let started = 0;
  const result = await runBatch({
    tasks: tasks(40),
    policy: { concurrency: 4 },
    execute: async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return stepOfSkip('budget-disabled', 'off');
    },
  });
  assert.ok(started <= 4, `started ${started}`);
  assert.equal(result.halted, 'budget');
});

test('a missing key, a storage failure and an unknown refusal all halt', () => {
  assert.equal(stepOfSkip('no-key', 'k').haltAs, 'key');
  assert.equal(stepOfSkip('storage', 's').haltAs, 'storage');
  assert.equal(stepOfSkip('job-inactive', 'j').haltAs, 'inactive');
  assert.equal(stepOfSkip('something-new', 'n').kind, 'halt');
  assert.deepEqual(stepOfSkip('already-recorded', 'a'), { kind: 'repeat' });
  assert.equal(stepOfSkip('not-sendable', 'protected').kind, 'skipped');
});

test('consecutive failures halt the run; a success resets the streak', async () => {
  const flaky = await runBatch({
    tasks: tasks(20),
    policy: { concurrency: 1 },
    execute: async (t) => (Number(t.sampleId.slice(1)) % 3 === 2 ? { kind: 'recorded' } : { kind: 'failed', reason: 'boom' }),
  });
  assert.equal(flaky.halted, null);
  const dead = await runBatch({
    tasks: tasks(20),
    policy: { concurrency: 1, maxConsecutiveFailures: 3 },
    execute: async () => ({ kind: 'failed', reason: 'HTTP 401' }),
  });
  assert.equal(dead.halted, 'failures');
  assert.equal(dead.failed, 3);
  assert.match(dead.haltDetail, /HTTP 401/);
});

test('a thrown error is a failure, not a crash', async () => {
  const result = await runBatch({
    tasks: tasks(2),
    policy: { concurrency: 1, maxConsecutiveFailures: 5 },
    execute: async () => {
      throw new Error('kaboom');
    },
  });
  assert.equal(result.failed, 2);
  assert.equal(result.halted, null);
});

test('the person can stop, and a ceiling caps the number of tasks', async () => {
  let started = 0;
  let stop = false;
  const stopped = await runBatch({
    tasks: tasks(20),
    policy: { concurrency: 1 },
    shouldStop: () => stop,
    execute: async () => {
      started += 1;
      if (started === 5) stop = true;
      return { kind: 'recorded' };
    },
  });
  assert.equal(stopped.halted, 'stopped');
  assert.equal(started, 5);

  const capped = await runBatch({
    tasks: tasks(30),
    policy: { maxTasks: 10, concurrency: 2 },
    execute: async () => ({ kind: 'recorded' }),
  });
  assert.equal(capped.started, 10);
  assert.equal(capped.halted, 'ceiling');
  assert.ok(DEFAULT_BATCH_POLICY.maxTasks >= 1000);
});

// -------------------------------------------------------------- executor + runner

const machine = (labeller, sampleId, overrides = {}) =>
  runSingleMachineLabel({ labeller, sampleId, ruleId: RULE_ID, authorized: true, ...overrides });

test('an unauthorized or keyless machine call makes zero network requests', async () => {
  const s = sample('post one');
  installChrome({ local: localWith([s], { machineKeys: { openai: '', deepseek: '' } }) });
  const calls = installFetch(() => {
    throw new Error('network must not be reached');
  });
  await enableEvaluationBudgets(0);
  assert.equal((await machine('openai', s.sampleId, { authorized: false })).reason, 'not-authorized');
  assert.equal((await machine('openai', s.sampleId)).reason, 'no-key');
  assert.equal((await machine('deepseek', s.sampleId)).reason, 'no-key');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

test('with the budget off a machine call is refused before any request', async () => {
  const s = sample('post one');
  installChrome({ local: localWith([s]) });
  const calls = installFetch(() => {
    throw new Error('network must not be reached');
  });
  const result = await machine('openai', s.sampleId);
  assert.equal(result.reason, 'budget-disabled');
  assert.deepEqual(calls, []);
});

test('OpenAI labels a sample, settles at real usage and records the answer', async () => {
  const s = sample('please like and retweet');
  installChrome({ local: localWith([s]) });
  await enableEvaluationBudgets(0);
  const calls = installFetch(() => openAiAnswer('match', 'asks for engagement'));

  const result = await machine('openai', s.sampleId);

  assert.equal(result.kind, 'labelled');
  assert.equal(result.state, 'match');
  assert.equal(result.reason, 'asks for engagement');
  assert.equal(result.trace.requestedModel, 'gpt-6-luna');
  assert.equal(result.trace.answeredModel, 'gpt-6-luna-2026-08-01');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-o');

  const state = await loadEvaluationJobs();
  const job = state.jobs[0];
  assert.equal(job.model, 'gpt-6-luna');
  assert.equal(job.status, 'settled');
  assert.deepEqual(job.verdict, { status: 'labelled', state: 'match', reason: 'asks for engagement' });
  // 700 input tokens at $0.10/M plus 30 output at $0.50/M, rounded up: 70 + 15 micro.
  assert.equal(state.spentMicro['gpt-6-luna'], 85);
  assert.equal(state.spentMicro['deepseek-flash'], undefined);
  assert.equal(state.spentMicro['jev-1.13.0'], undefined);
});

test('a configured relay and model receive the request and are billed at that model', async () => {
  const s = sample('please like and retweet');
  installChrome({
    local: {
      ...localWith([s]),
      [EVALUATION_CONNECTION_KEY]: { openai: { baseUrl: 'https://relay.example/v1/', model: 'gpt-6-sol' } },
    },
  });
  await enableEvaluationBudgets(0);
  const calls = installFetch(() => openAiAnswer('match', 'asks for engagement', undefined, 'gpt-6-sol'));

  const result = await machine('openai', s.sampleId);

  assert.equal(result.kind, 'labelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.example/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].init.body).model, 'gpt-6-sol');
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs[0].model, 'gpt-6-sol');
  // 700 input at $2/M plus 30 output at $10/M: 1400 + 300 micro.
  assert.equal(state.spentMicro['gpt-6-sol'], 1700);
  assert.equal(state.spentMicro['gpt-6-luna'], undefined);
});

test('a stored connection that is not https or names an unpriced model is ignored', async () => {
  const s = sample('a post');
  installChrome({
    local: {
      ...localWith([s]),
      [EVALUATION_CONNECTION_KEY]: { openai: { baseUrl: 'http://evil.example', model: 'gpt-6-luna' }, deepseek: { baseUrl: 'https://ok.example', model: 'made-up' } },
    },
  });
  const connections = await loadEvaluationConnections();
  assert.equal(connections.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(connections.deepseek.model, 'deepseek-flash');
});

test('only an extension page can change a connection', async () => {
  installChrome({ local: localWith([]) });
  const refused = await setEvaluationConnection({ id: 'other-extension' }, TEST_EXTENSION_ID, 'openai', { baseUrl: 'https://x.example/v1', model: 'gpt-6-sol' });
  assert.equal(refused.ok, false);
  assert.equal(refused.connections.openai.baseUrl, 'https://api.openai.com/v1');
  const bad = await setEvaluationConnection(extensionPageSender(), TEST_EXTENSION_ID, 'openai', { baseUrl: 'http://x.example', model: 'gpt-6-sol' });
  assert.equal(bad.ok, false);
  const ok = await setEvaluationConnection(extensionPageSender(), TEST_EXTENSION_ID, 'openai', { baseUrl: 'https://x.example/v1/', model: 'gpt-6-sol' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.connections.openai, { baseUrl: 'https://x.example/v1', model: 'gpt-6-sol' });
});

test('the two machine labellers are billed to separate buckets and never see each other', async () => {
  const s = sample('a plain post');
  installChrome({ local: localWith([s]) });
  await enableEvaluationBudgets(0);
  const calls = installFetch((call) => (call.url.includes('openai') ? openAiAnswer('no-match', 'zqx-alpha-reason') : deepSeekAnswer('match', 'zqx-beta-reason')));

  const a = await machine('openai', s.sampleId);
  const b = await machine('deepseek', s.sampleId);
  assert.equal(a.state, 'no-match');
  assert.equal(b.state, 'match');
  assert.equal(calls.length, 2);

  // The second request contains neither the first model's answer nor its reason.
  assert.doesNotMatch(calls[1].init.body, /zqx-alpha|gpt-6/);
  assert.doesNotMatch(calls[0].init.body, /zqx-beta|deepseek/);
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.length, 2);
  assert.ok(state.spentMicro['gpt-6-luna'] > 0 && state.spentMicro['deepseek-flash'] > 0);
  // 650 in at $0.30/M + 25 out at $1.20/M, rounded up per side: 195 + 30.
  assert.equal(state.spentMicro['deepseek-flash'], 225);
});

test('a repeated machine call is deduped and returns the stored label without a request', async () => {
  const s = sample('post');
  installChrome({ local: localWith([s]) });
  await enableEvaluationBudgets(0);
  const calls = installFetch(() => deepSeekAnswer('no-match', 'ok'));
  await machine('deepseek', s.sampleId);
  const again = await machine('deepseek', s.sampleId);
  assert.equal(calls.length, 1);
  assert.equal(again.kind, 'labelled');
  assert.equal(again.state, 'no-match');
});

test('an unreadable answer is a paid undecided, and a failed request keeps its money held', async () => {
  const s = sample('one');
  const t = sample('two', 'bob');
  installChrome({ local: localWith([s, t]) });
  await enableEvaluationBudgets(0);
  installFetch(() => jsonResponse({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: 'sure!' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  const first = await machine('deepseek', s.sampleId);
  assert.equal(first.kind, 'undecided');

  installFetch(() => jsonResponse({ error: 'no' }, { status: 401 }));
  const second = await machine('deepseek', t.sampleId);
  assert.equal(second.kind, 'unknown');
  const state = await loadEvaluationJobs();
  assert.equal(state.jobs.find((job) => job.sampleId === t.sampleId).status, 'unknown');
  assert.ok(state.jobs.find((job) => job.sampleId === t.sampleId).reservedMicro > 0);
});

test('missing usage in a machine response keeps the reservation instead of guessing', async () => {
  const s = sample('one');
  installChrome({ local: localWith([s]) });
  await enableEvaluationBudgets(0);
  installFetch(() => openAiAnswer('match', 'x', {}));
  const result = await machine('openai', s.sampleId);
  assert.equal(result.kind, 'unknown');
  assert.equal((await loadEvaluationJobs()).jobs[0].status, 'unknown');
});

test('the cap stops a labeller: a reservation that no longer fits is refused', async () => {
  const s = sample('one');
  const handle = installChrome({ local: localWith([s]) });
  await enableEvaluationBudgets(0);
  const stored = handle.readLocal('anyfilter.evaluation.jobs');
  const tight = {
    ...stored,
    limits: stored.limits.map((limit) => (limit.model === 'deepseek-flash' ? { ...limit, capMicro: 100 } : limit)),
  };
  await chrome.storage.local.set({ 'anyfilter.evaluation.jobs': tight });
  const calls = installFetch((call) => (call.url.includes('openai') ? openAiAnswer() : deepSeekAnswer()));
  const result = await machine('deepseek', s.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'cap-exceeded');
  assert.deepEqual(calls, []);
  // The other labellers are unaffected by DeepSeek's cap.
  const other = await machine('openai', s.sampleId);
  assert.equal(other.kind, 'labelled');
  assert.equal(calls.length, 1);
});

test('an oversized post is refused without reserving or sending', async () => {
  const big = sampleOf(makePost({ handle: 'ada', name: 'Ada', text: 'word '.repeat(300) }), {
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
  });
  const huge = { ...big, stateJson: JSON.stringify({ ...JSON.parse(big.stateJson), text: '汉'.repeat(9000) }) };
  installChrome({ local: localWith([huge]) });
  await enableEvaluationBudgets(0);
  const calls = installFetch(() => openAiAnswer());
  const result = await machine('openai', huge.sampleId);
  assert.equal(result.kind, 'skipped');
  assert.equal(result.reason, 'not-sendable');
  assert.deepEqual(calls, []);
  assert.equal((await loadEvaluationJobs()).jobs.length, 0);
});

// -------------------------------------------------------------------- runner

test('only our own pages may set a key, start a batch, stop it or export', async () => {
  const s = sample('one');
  installChrome({ local: localWith([s], { machineKeys: null }) });
  const calls = installFetch(() => {
    throw new Error('network must not be reached');
  });
  const x = xContentSender();
  const refusedKey = await setEvaluationKey(x, TEST_EXTENSION_ID, 'openai', 'sk-evil');
  assert.equal(refusedKey.ok, false);
  assert.equal((await loadKeyPresence()).openai, false);

  const start = await startEvaluationBatch(x, TEST_EXTENSION_ID, 'openai');
  assert.equal(start.ok, false);
  assert.match(start.detail, /own pages/);
  assert.equal(await loadEvaluationExport(x, TEST_EXTENSION_ID), null);
  assert.equal(stopEvaluationBatch(x, TEST_EXTENSION_ID).running, false);
  assert.deepEqual(calls, []);

  const ok = await setEvaluationKey(extensionPageSender(), TEST_EXTENSION_ID, 'openai', ' sk-good ');
  assert.equal(ok.ok, true);
  assert.equal(ok.keys.openai, true);
  assert.equal(ok.keys.deepseek, false);
  const bad = await setEvaluationKey(extensionPageSender(), TEST_EXTENSION_ID, 'deepseek', 'has space in it');
  assert.equal(bad.ok, false);
});

test('a batch labels every sample for every enabled semantic rule, then dedupes on re-run', async () => {
  const samples = [sample('one', 'ada'), sample('two', 'bob'), sample('three', 'cy')];
  installChrome({ local: localWith(samples) });
  await enableEvaluationBudgets(0);
  const calls = installFetch(() => openAiAnswer('no-match', 'fine'));

  const started = await startEvaluationBatch(extensionPageSender(), TEST_EXTENSION_ID, 'openai');
  assert.ok(started.ok);
  assert.equal(isEvaluationRunStatus(started.status), true);
  const done = await started.done;

  const settings = normalizeSettings({});
  const semantic = settings.rules.filter((rule) => rule.enabled && rule.kind === 'semantic').length;
  assert.equal(done.total, samples.length * semantic);
  assert.equal(done.halted, null);
  assert.equal(done.recorded + done.skipped, done.total);
  assert.equal(calls.length, done.recorded);
  assert.ok(done.recorded > 0);

  const again = await startEvaluationBatch(extensionPageSender(), TEST_EXTENSION_ID, 'openai');
  const rerun = await again.done;
  assert.equal(calls.length, done.recorded, 'no task is paid for twice');
  assert.equal(rerun.repeats, done.recorded);
});

test('a batch halts on a missing key without calling anyone', async () => {
  const samples = [sample('one'), sample('two', 'bob')];
  installChrome({ local: localWith(samples, { machineKeys: null }) });
  await enableEvaluationBudgets(0);
  const calls = installFetch(() => {
    throw new Error('network must not be reached');
  });
  const started = await startEvaluationBatch(extensionPageSender(), TEST_EXTENSION_ID, 'deepseek');
  const done = await started.done;
  assert.equal(done.halted, 'key');
  assert.equal(done.recorded, 0);
  assert.ok(done.started <= 4);
  assert.deepEqual(calls, []);
});

test('a second batch cannot start while one is running', async () => {
  const samples = [sample('one'), sample('two', 'bob')];
  installChrome({ local: localWith(samples) });
  await enableEvaluationBudgets(0);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  installFetch(async () => {
    await gate;
    return deepSeekAnswer();
  });
  const first = await startEvaluationBatch(extensionPageSender(), TEST_EXTENSION_ID, 'deepseek');
  assert.ok(first.ok);
  const second = await startEvaluationBatch(extensionPageSender(), TEST_EXTENSION_ID, 'openai');
  assert.equal(second.ok, false);
  assert.match(second.detail, /already running/);
  stopEvaluationBatch(extensionPageSender(), TEST_EXTENSION_ID);
  release();
  const done = await first.done;
  assert.equal(done.finished, true);
  assert.equal(done.halted, 'stopped');
});

// -------------------------------------------------------------------- export

test('the export carries samples, real answers and held jobs apart, and no key', async () => {
  const s = sample('exported post');
  installChrome({ local: localWith([s]) });
  await enableEvaluationBudgets(0);
  installFetch((call) => (call.url.includes('openai') ? openAiAnswer('match', 'promo') : jsonResponse({}, { status: 500 })));
  await machine('openai', s.sampleId);
  await machine('deepseek', s.sampleId);

  const out = await loadEvaluationExport(extensionPageSender(), TEST_EXTENSION_ID);
  assert.equal(out.version, 1);
  assert.equal(out.containsPostText, true);
  assert.equal(out.samples.length, 1);
  assert.equal(out.samples[0].sampleId, s.sampleId);
  assert.equal(out.samples[0].stateJson, s.stateJson);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].labeller, 'openai');
  assert.deepEqual(out.results[0].verdict, { status: 'labelled', state: 'match', reason: 'promo' });
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].labeller, 'deepseek');
  assert.equal(out.failures[0].status, 'unknown');
  assert.ok(out.rules.some((rule) => rule.id === RULE_ID && rule.questionWithoutParent === QUESTION));
  assert.doesNotMatch(JSON.stringify(out), /sk-o|sk-d|ts_key/);
  assert.equal(out.spend.length, 4);
  assert.equal(out.spend.find((row) => row.labeller === 'openai').spentMicro > 0, true);

  const state = await loadEvaluationJobs();
  const overview = overviewOf(state, 1, 4);
  assert.equal(overview.spend.length, 4);
  assert.equal(buildEvaluationExport([], state, normalizeSettings({}), 'x').results.length, 1);
});

test('a budget written for Jev only is reported as partial, not as ready', () => {
  const jevOnly = enableBudget(emptyJobState(), { prices: [JEV_SPEC.price], limits: [JEV_SPEC.limit] }, 1);
  assert.ok(jevOnly.ok);
  const partial = overviewOf(jevOnly.state, 1, 4);
  assert.deepEqual([partial.enabled, partial.partial], [false, true]);
  const full = enableBudget(jevOnly.state, budgetConfigOfAllLabellers(), 2);
  assert.ok(full.ok);
  assert.deepEqual([overviewOf(full.state, 1, 4).enabled, overviewOf(full.state, 1, 4).partial], [true, false]);
  assert.deepEqual([overviewOf(emptyJobState(), 1, 4).enabled, overviewOf(emptyJobState(), 1, 4).partial], [false, false]);
});

test('control messages are validated and a key message is bounded', () => {
  assert.equal(isRuntimeMessage({ type: 'eval-batch-start', labeller: 'openai' }), true);
  assert.equal(isRuntimeMessage({ type: 'eval-batch-start', labeller: 'gpt' }), false);
  assert.equal(isRuntimeMessage({ type: 'eval-set-key', labeller: 'deepseek', key: 'k' }), true);
  assert.equal(isRuntimeMessage({ type: 'eval-set-key', labeller: 'jev', key: 'k' }), false);
  assert.equal(isRuntimeMessage({ type: 'eval-set-key', labeller: 'openai', key: 'k'.repeat(301) }), false);
  assert.equal(isRuntimeMessage({ type: 'eval-set-connection', labeller: 'openai', baseUrl: 'https://a.example', model: 'gpt-6-sol' }), true);
  assert.equal(isRuntimeMessage({ type: 'eval-set-connection', labeller: 'jev', baseUrl: 'https://a.example', model: 'x' }), false);
  for (const type of ['eval-overview', 'eval-key-status', 'eval-connection-status', 'eval-batch-stop', 'eval-batch-status', 'eval-export']) {
    assert.equal(isRuntimeMessage({ type }), true);
  }
});
