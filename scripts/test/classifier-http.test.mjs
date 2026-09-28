/**
 * Provider response handling shared by the feed and the preview: missing or
 * invalid answers must be left as "not judged" instead of becoming a zero, the
 * cache must only hold fully answered responses, and the preview path must not
 * read or write that cache at all.
 *
 * The rate-limit test is last on purpose: the cooldown is module state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings } from '../../src/domain/settings';
import { classifyPost, classifyText, filterScores } from '../../src/infrastructure/classifier';
import { installChrome, installFetch, jsonResponse, makePost, vercelAnswers, VERCEL_URL } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const KEY = 'vck_unit_test';
const QUESTIONS = { bait: 'bait question?', hate: 'hate question?' };

function withKey(overrides = {}) {
  return normalizeSettings({ keys: { vercel: KEY, typesafe: '' }, ...overrides });
}

test('an empty question set makes no request and reports no scores', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({})));

  const result = await classifyPost(makePost(), {}, '');

  assert.deepEqual(result, { ok: true, scores: {}, tokens: 0 });
  assert.equal(calls.length, 0);
});

test('without a key the classifier reports no-key and sends nothing', async () => {
  installChrome({ local: { [SETTINGS_KEY]: normalizeSettings({}) } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({})));

  const result = await classifyPost(makePost(), QUESTIONS, 'k1');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-key');
  assert.equal(calls.length, 0);
});

test('a complete response is cached and reused without a second request', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({ bait: 0.9, hate: 0.1 })));
  const post = makePost();

  const first = await classifyPost(post, QUESTIONS, 'k1');
  assert.equal(first.ok, true);
  assert.deepEqual(first.scores, { bait: 0.9, hate: 0.1 });
  assert.equal(calls.length, 1);

  const second = await classifyPost(post, QUESTIONS, 'k1');
  assert.equal(second.ok, true);
  assert.deepEqual(second.scores, { bait: 0.9, hate: 0.1 });
  assert.equal(second.tokens, 0);
  assert.equal(calls.length, 1, 'the second call should be served from the session cache');

  assert.equal(handle.sessionKeys().length, 1);
  assert.equal(JSON.stringify(handle.snapshot().session).includes(KEY), false);
  assert.equal(calls[0].url, VERCEL_URL);
  assert.equal(JSON.stringify(calls[0].body).includes(KEY), false, 'the key stays in the header, never the body');
});

test('a response missing an answer stays incomplete and is never cached', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({ bait: 0.9 })));
  const post = makePost();

  const first = await classifyPost(post, QUESTIONS, 'k1');
  assert.equal(first.ok, true);
  assert.deepEqual(first.scores, { bait: 0.9 }, 'the missing answer must not appear as 0');
  assert.deepEqual(handle.sessionKeys(), []);

  await classifyPost(post, QUESTIONS, 'k1');
  assert.equal(calls.length, 2, 'an incomplete answer must be asked again');
});

test('out-of-range and non-numeric answers are dropped', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  installFetch(() =>
    jsonResponse({
      answers: {
        bait: { type: 'boolean', probability: 0.9 },
        hate: { type: 'boolean', probability: 1.4 },
      },
      usage: { inputTokens: 5 },
    }),
  );

  const result = await classifyPost(makePost(), QUESTIONS, 'k1');

  assert.equal(result.ok, true);
  assert.deepEqual(result.scores, { bait: 0.9 });
});

test('a response with no usable answer at all is a bad-response', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  installFetch(() =>
    jsonResponse({
      answers: {
        bait: { type: 'boolean', probability: 'very likely' },
        hate: { type: 'boolean', probability: -0.5 },
      },
    }),
  );

  const result = await classifyPost(makePost(), QUESTIONS, 'k1');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad-response');
  assert.match(result.detail, /no usable answers/);
});

test('filterScores keeps only finite 0..1 answers for the ids that were asked', () => {
  const mixed = filterScores(
    { bait: 0.5, hate: -0.1, promo: 2, nsfw: Number.NaN, spam: 1 },
    ['bait', 'hate', 'promo', 'nsfw', 'spam', 'crypto'],
  );
  assert.deepEqual(mixed.scores, { bait: 0.5, spam: 1 });
  assert.equal(mixed.complete, false);

  const complete = filterScores({ bait: 0, hate: 1 }, ['bait', 'hate']);
  assert.deepEqual(complete.scores, { bait: 0, hate: 1 });
  assert.equal(complete.complete, true);
});

test('answers for ids that were not asked are ignored', () => {
  const filtered = filterScores({ bait: 0.5, somethingElse: 0.9 }, ['bait']);

  assert.deepEqual(filtered.scores, { bait: 0.5 });
  assert.equal(filtered.complete, true);
});

test('the preview path never reads or writes the score cache', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({ bait: 0.9, hate: 0.1 })));
  const state = { text: 'same text', author: { handle: '@ada', name: 'Ada' } };

  await classifyText(state, QUESTIONS);
  await classifyText(state, QUESTIONS);

  assert.equal(calls.length, 2, 'the preview must ask every time');
  assert.deepEqual(handle.sessionKeys(), []);
});

test('an auth failure is surfaced without a retry', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() => jsonResponse({}, { status: 401, body: 'unauthorized' }));

  const result = await classifyPost(makePost(), QUESTIONS, 'k1');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'auth');
  assert.equal(calls.length, 1);
});

test('a 429 sets a cooldown that short-circuits the next request', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() =>
    jsonResponse({}, { status: 429, headers: { 'retry-after': '30' }, body: 'slow down' }),
  );

  const first = await classifyPost(makePost(), QUESTIONS, 'k1');
  assert.equal(first.ok, false);
  assert.equal(first.error, 'rate-limited');
  assert.equal(calls.length, 1);

  const second = await classifyPost(makePost(), QUESTIONS, 'k1');
  assert.equal(second.ok, false);
  assert.equal(second.error, 'rate-limited');
  assert.match(second.detail, /cooling down/);
  assert.equal(calls.length, 1, 'no request is sent while cooling down');
});