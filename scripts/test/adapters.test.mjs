/**
 * Provider adapter contract for both providers: request shape, legal answers,
 * missing fields, out-of-range values, unknown ids, and where the key is placed.
 * The classifier is exercised through each provider so the two paths cannot
 * silently drift apart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings } from '../../src/domain/settings';
import { classifyPost } from '../../src/infrastructure/classifier';
import { typesafeDirectAdapter } from '../../src/infrastructure/jev/typesafe-direct-adapter';
import { vercelGatewayAdapter } from '../../src/infrastructure/jev/vercel-gateway-adapter';
import {
  installChrome,
  installFetch,
  jsonResponse,
  makePost,
  TYPESAFE_URL,
  typesafeAnswers,
  vercelAnswers,
  VERCEL_URL,
} from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const KEY = 'sk_secret_value';
const QUESTIONS = { bait: 'bait question?', hate: 'hate question?' };

const ADAPTERS = [
  {
    name: 'vercel',
    adapter: vercelGatewayAdapter,
    url: VERCEL_URL,
    answers: vercelAnswers,
    probabilityField: 'probability',
    tokenFields: { input: 'inputTokens', output: 'outputTokens' },
    reportsCost: true,
  },
  {
    name: 'typesafe',
    adapter: typesafeDirectAdapter,
    url: TYPESAFE_URL,
    answers: typesafeAnswers,
    probabilityField: 'noul',
    tokenFields: { input: 'input_tokens', output: 'output_tokens' },
    reportsCost: false,
  },
];

for (const { name, adapter, url, answers, probabilityField, tokenFields, reportsCost } of ADAPTERS) {
  test(`[${name}] buildRequest targets its endpoint with the key in the header`, () => {
    const request = adapter.buildRequest(KEY, { text: 'hello' }, QUESTIONS);

    assert.equal(request.url, url);
    assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.equal(
      JSON.stringify(request.body).includes(KEY),
      false,
      'the key must never be placed in the request body',
    );
    assert.equal(request.body.state.text, 'hello');
    assert.equal(Object.keys(request.body.questions).join(','), 'bait,hate');
    assert.equal(request.body.questions.bait.instructions, QUESTIONS.bait);
  });

  test(`[${name}] parseScores reads the legal answer shape`, () => {
    const scores = adapter.parseScores(answers({ bait: 0.9, hate: 0.1 }));

    assert.deepEqual(scores, { bait: 0.9, hate: 0.1 });
    assert.equal(typeof adapter.parseScores(answers({ bait: 0.42 })).bait, 'number');
    assert.equal(adapter.parseScores(answers({ bait: 0.42 })).bait, 0.42);
  });

  test(`[${name}] parseScores ignores the other provider's probability field`, () => {
    const scores = adapter.parseScores({ answers: { bait: { type: 'boolean' } } });

    assert.deepEqual(scores, {});

    // A response that carries the other provider's field name must not be read:
    // the Vercel adapter reads `probability`, TypeSafe reads `noul`.
    const foreign = probabilityField === 'probability' ? 'noul' : 'probability';
    const leaked = adapter.parseScores({ answers: { bait: { [foreign]: 0.9 } } });
    assert.deepEqual(leaked, {}, `the ${name} adapter must not read "${foreign}"`);
  });

  test(`[${name}] parseScores tolerates malformed envelopes`, () => {
    for (const junk of [null, 42, 'nope', {}, { answers: null }, { answers: [] }]) {
      assert.deepEqual(adapter.parseScores(junk), {});
    }
  });

  test(`[${name}] parseScores keeps out-of-range and unknown ids for the caller to filter`, () => {
    const scores = adapter.parseScores(answers({ bait: 1.5, hate: -0.2, unknown: 0.9 }));

    assert.equal(scores.bait, 1.5);
    assert.equal(scores.hate, -0.2);
    assert.equal(scores.unknown, 0.9);
  });

  test(`[${name}] inputTokens reads its provider's field`, () => {
    assert.equal(adapter.inputTokens(answers({ bait: 0.5 }, { inputTokens: 1234 })), 1234);
    assert.equal(adapter.inputTokens({ usage: {} }), 0);
    assert.equal(adapter.inputTokens(null), 0);
  });

  test(`[${name}] readMetadata reads the reported model and both token counts`, () => {
    const meta = adapter.readMetadata({
      model: 'proof-of-answer-model',
      answers: {},
      usage: { [tokenFields.input]: 296, [tokenFields.output]: 20 },
    });

    assert.equal(meta.model, 'proof-of-answer-model');
    assert.equal(meta.inputTokens, 296);
    assert.equal(meta.outputTokens, 20);
  });

  test(`[${name}] readMetadata reports an unknown model rather than the requested id`, () => {
    for (const junk of [undefined, null, '', '   ', 42, {}, []]) {
      const meta = adapter.readMetadata({ model: junk, usage: {} });
      assert.equal(meta.model, undefined, `model ${JSON.stringify(junk)} must stay unknown`);
    }
    // The requested model id is never substituted for what the provider actually
    // said it ran.
    const absent = adapter.readMetadata({ usage: {} });
    assert.equal(absent.model, undefined);
    assert.notEqual(absent.model, adapter.model);
  });

  test(`[${name}] readMetadata never fabricates a token count`, () => {
    for (const value of [-1, 1.5, '12', NaN, Infinity, null, {}]) {
      const meta = adapter.readMetadata({
        usage: { [tokenFields.input]: value, [tokenFields.output]: 5 },
      });
      assert.equal(meta.inputTokens, undefined, `${JSON.stringify(value)} is not a token count`);
      assert.equal(meta.outputTokens, 5);
    }
    for (const json of [null, undefined, {}, { usage: null }, { usage: [] }]) {
      const meta = adapter.readMetadata(json);
      assert.equal(meta.inputTokens, undefined);
      assert.equal(meta.outputTokens, undefined);
    }
  });

  test(`[${name}] readMetadata reads only its own provider's token field names`, () => {
    const foreignInput = probabilityField === 'probability' ? 'input_tokens' : 'inputTokens';
    const foreignOutput = probabilityField === 'probability' ? 'output_tokens' : 'outputTokens';
    const meta = adapter.readMetadata({ usage: { [foreignInput]: 7, [foreignOutput]: 9 } });

    assert.equal(meta.inputTokens, undefined, `the ${name} adapter must not read "${foreignInput}"`);
    assert.equal(meta.outputTokens, undefined);
  });

  test(`[${name}] readMetadata leaves cost unknown when no gateway cost is present`, () => {
    assert.equal(adapter.readMetadata({ usage: {} }).cost, undefined);
    assert.equal(adapter.readMetadata(null).cost, undefined);
  });
}

test('[vercel] readMetadata reads the gateway cost as a decimal string or a number', () => {
  const costOf = (value) =>
    vercelGatewayAdapter.readMetadata({ providerMetadata: { gateway: { cost: value } } }).cost;

  assert.equal(costOf('0.00001155'), 0.00001155);
  assert.equal(costOf(0.25), 0.25);
  assert.equal(costOf('0'), 0);
});

test('[vercel] readMetadata keeps a missing or malformed gateway cost unknown', () => {
  const costOf = (json) => vercelGatewayAdapter.readMetadata(json).cost;

  for (const junk of [undefined, null, '', '  ', 'free', -0.5, NaN, Infinity, {}, []]) {
    assert.equal(costOf({ providerMetadata: { gateway: { cost: junk } } }), undefined);
  }
  for (const json of [
    null,
    undefined,
    {},
    { providerMetadata: null },
    { providerMetadata: { gateway: null } },
  ]) {
    assert.equal(costOf(json), undefined);
  }
  // The sibling gateway figures are deliberately not used as a fallback.
  assert.equal(costOf({ providerMetadata: { gateway: { marketCost: '0.9' } } }), undefined);
  assert.equal(costOf({ providerMetadata: { gateway: { gatewayCost: '0.9' } } }), undefined);
});

test('[typesafe] readMetadata reports the versioned model, not the requested alias', () => {
  const meta = typesafeDirectAdapter.readMetadata({
    model: 'jev-1.13.0',
    answers: {},
    usage: { input_tokens: 296, output_tokens: 20 },
  });

  assert.equal(meta.model, 'jev-1.13.0');
  assert.notEqual(meta.model, typesafeDirectAdapter.model);
  assert.equal(meta.cost, undefined, 'TypeSafe direct reports no cost of its own');
});

test('[typesafe] readMetadata ignores a gateway cost envelope', () => {
  const meta = typesafeDirectAdapter.readMetadata({
    model: 'jev-1.13.0',
    usage: {},
    providerMetadata: { gateway: { cost: '0.00001155' } },
  });

  assert.equal(meta.cost, undefined);
});

test('[typesafe] a full classify round trip uses the direct endpoint and field', async () => {
  installChrome({
    local: {
      [SETTINGS_KEY]: normalizeSettings({
        provider: 'typesafe',
        keys: { vercel: '', typesafe: KEY },
      }),
    },
  });
  const calls = installFetch(() => jsonResponse(typesafeAnswers({ bait: 0.9, hate: 0.2 })));

  const result = await classifyPost(makePost(), QUESTIONS, 'k-typesafe');

  assert.equal(result.ok, true);
  assert.deepEqual(result.scores, { bait: 0.9, hate: 0.2 });
  assert.equal(calls[0].url, TYPESAFE_URL);
  assert.equal(calls[0].url, typesafeDirectAdapter.buildRequest('k', {}, {}).url);
});

test('[key separation] the typesafe provider cannot borrow the vercel key', async () => {
  installChrome({
    local: {
      [SETTINGS_KEY]: normalizeSettings({
        provider: 'typesafe',
        keys: { vercel: 'vck_vercel_only', typesafe: '' },
      }),
    },
  });
  const calls = installFetch(() => jsonResponse(typesafeAnswers({ bait: 0.9 })));

  const result = await classifyPost(makePost(), QUESTIONS, 'k-separation');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-key');
  assert.equal(calls.length, 0, 'no request may be made with the wrong provider key');
});

test('a provider answer for an id that was not asked is not surfaced', async () => {
  installChrome({
    local: { [SETTINGS_KEY]: normalizeSettings({ keys: { vercel: KEY, typesafe: '' } }) },
  });
  installFetch(() => jsonResponse(vercelAnswers({ bait: 0.8, notAQuestion: 0.99 })));

  const result = await classifyPost(makePost(), QUESTIONS, 'k-unknown-id');

  assert.equal(result.ok, true);
  assert.deepEqual(result.scores, { bait: 0.8 });
  assert.equal('notAQuestion' in result.scores, false);
});

test('a 500 response is a bad-response, not a partial pass', async () => {
  installChrome({
    local: { [SETTINGS_KEY]: normalizeSettings({ keys: { vercel: KEY, typesafe: '' } }) },
  });
  installFetch(() => jsonResponse({}, { status: 500, body: 'boom' }));

  const result = await classifyPost(makePost(), QUESTIONS, 'k-500');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad-response');
  assert.match(result.detail, /HTTP 500/);
});

test('a dropped connection surfaces as a network error with the reason', async () => {
  installChrome({
    local: { [SETTINGS_KEY]: normalizeSettings({ keys: { vercel: KEY, typesafe: '' } }) },
  });
  installFetch(() => {
    throw new Error('socket hang up');
  });

  const result = await classifyPost(makePost(), QUESTIONS, 'k-timeout');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'network');
  assert.match(result.detail, /socket hang up/);
});