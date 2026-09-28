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
  },
  {
    name: 'typesafe',
    adapter: typesafeDirectAdapter,
    url: TYPESAFE_URL,
    answers: typesafeAnswers,
    probabilityField: 'noul',
  },
];

for (const { name, adapter, url, answers, probabilityField } of ADAPTERS) {
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
}

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