/**
 * Auto mode limits: the money cap, the daily count, the failure stop, and which
 * addresses may be authorised. Pure, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_CAP_MICRO,
  AUTO_DAILY_REQUESTS,
  AUTO_MAX_FAILURES,
  AUTO_RESERVE_MICRO,
  beginRequest,
  canAuthorise,
  costMicro,
  dayOf,
  EMPTY_AUTO_STATE,
  hostOfPattern,
  neverAuto,
  normalizeAutoState,
  originPatternOf,
  pageKeyOf,
  refusalOf,
  resumed,
  settleRequest,
  withEnabled,
  withSpendReset,
} from '../../src/domain/auto-mode';

const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const on = withEnabled(EMPTY_AUTO_STATE, true);

test('the cap is ten dollars and a typical page costs about a hundredth of a cent', () => {
  assert.equal(AUTO_CAP_MICRO, 10_000_000);
  assert.equal(costMicro(3000), 126); // 3000 tokens at $0.042 per million
  assert.equal(costMicro(0), 0);
  assert.equal(costMicro(Number.NaN), 0);
  assert.equal(costMicro(-5), 0);
  // The reservation is the worst case, not a typical page.
  assert.ok(AUTO_RESERVE_MICRO >= costMicro(3700) * 3);
});

test('nothing is allowed until the switch is turned on', () => {
  assert.equal(refusalOf(EMPTY_AUTO_STATE, NOW), 'off');
  assert.equal(refusalOf(on, NOW), null);
  const start = beginRequest(EMPTY_AUTO_STATE, NOW);
  assert.equal(start.ok, false);
  assert.equal(start.state.spentMicro, 0, 'a refusal charges nothing');
});

test('a request is charged its worst case up front and its real cost afterwards', () => {
  const begun = beginRequest(on, NOW);
  assert.equal(begun.ok, true);
  assert.equal(begun.state.spentMicro, AUTO_RESERVE_MICRO);
  assert.equal(begun.state.dayCount, 1);
  const settled = settleRequest(begun.state, begun.reservedMicro, { ok: true, inputTokens: 3000 });
  assert.equal(settled.spentMicro, 126);
  assert.equal(settled.failures, 0);
});

test('requests that never reached a billable answer are refunded; a garbled answer is not', () => {
  for (const error of ['no-key', 'auth', 'rate-limited', 'network']) {
    const begun = beginRequest(on, NOW);
    const settled = settleRequest(begun.state, begun.reservedMicro, { ok: false, error });
    assert.equal(settled.spentMicro, 0, `${error} is not billed`);
    assert.equal(settled.failures, 1);
  }
  const begun = beginRequest(on, NOW);
  const settled = settleRequest(begun.state, begun.reservedMicro, { ok: false, error: 'bad-response' });
  assert.equal(settled.spentMicro, AUTO_RESERVE_MICRO, 'the provider may have billed it');
});

test('three failures in a row stop auto mode until the person resumes it', () => {
  let state = on;
  for (let i = 0; i < AUTO_MAX_FAILURES; i += 1) {
    const begun = beginRequest(state, NOW);
    assert.equal(begun.ok, true, `attempt ${i + 1} is allowed`);
    state = settleRequest(begun.state, begun.reservedMicro, { ok: false, error: 'auth' });
  }
  assert.equal(state.paused, true);
  assert.equal(refusalOf(state, NOW), 'paused');
  state = resumed(state);
  assert.equal(refusalOf(state, NOW), null);
  assert.equal(state.failures, 0);
});

test('a success in between resets the failure count', () => {
  let state = on;
  for (const outcome of [
    { ok: false, error: 'network' },
    { ok: false, error: 'network' },
    { ok: true, inputTokens: 100 },
    { ok: false, error: 'network' },
    { ok: false, error: 'network' },
  ]) {
    const begun = beginRequest(state, NOW);
    state = settleRequest(begun.state, begun.reservedMicro, outcome);
  }
  assert.equal(state.paused, false);
  assert.equal(state.failures, 2);
});

test('the ten-dollar cap refuses the request that would pass it, and the reset lifts it', () => {
  const nearly = { ...on, spentMicro: AUTO_CAP_MICRO - AUTO_RESERVE_MICRO + 1 };
  assert.equal(refusalOf(nearly, NOW), 'cap');
  const exactly = { ...on, spentMicro: AUTO_CAP_MICRO - AUTO_RESERVE_MICRO };
  assert.equal(refusalOf(exactly, NOW), null, 'the last request that fits is allowed');
  assert.equal(refusalOf(withSpendReset(nearly), NOW), null);
});

test('the daily count stops a runaway page and starts again the next day', () => {
  const full = { ...on, day: dayOf(NOW), dayCount: AUTO_DAILY_REQUESTS };
  assert.equal(refusalOf(full, NOW), 'daily');
  const tomorrow = NOW + 24 * 60 * 60 * 1000;
  assert.equal(refusalOf(full, tomorrow), null);
  const begun = beginRequest(full, tomorrow);
  assert.equal(begun.state.dayCount, 1);
});

test('stored state is validated, not trusted', () => {
  assert.deepEqual(normalizeAutoState(null), EMPTY_AUTO_STATE);
  assert.deepEqual(normalizeAutoState('x'), EMPTY_AUTO_STATE);
  const odd = normalizeAutoState({ enabled: 'yes', spentMicro: -4, day: 'today', dayCount: 1.9, failures: Number.NaN, paused: 1 });
  assert.deepEqual(odd, { enabled: false, spentMicro: 0, day: '', dayCount: 1, failures: 0, paused: false });
  assert.equal(normalizeAutoState({ enabled: true, spentMicro: 500 }).spentMicro, 500);
});

test('only ordinary web pages on ordinary hosts can be authorised', () => {
  assert.equal(originPatternOf('https://example.com/a/b?q=1#x'), 'https://example.com/*');
  assert.equal(originPatternOf('http://example.com:8080/a'), 'http://example.com/*');
  assert.equal(originPatternOf('chrome://extensions'), null);
  assert.equal(originPatternOf('file:///etc/passwd'), null);
  assert.equal(originPatternOf('not a url'), null);
  assert.equal(hostOfPattern('https://example.com/*'), 'example.com');
  assert.equal(hostOfPattern('https://*.example.com/*'), null);
  for (const address of [
    'https://x.com/home',
    'https://twitter.com/a',
    'https://mobile.twitter.com/a',
    'https://api.typesafe.ai/v1',
    'https://ai-gateway.vercel.sh/x',
    'https://api.openai.com/v1',
    'chrome://settings',
  ]) {
    assert.equal(canAuthorise(address), false, address);
  }
  assert.equal(canAuthorise('https://blog.example.com/post'), true);
  assert.equal(neverAuto('notx.com'), false, 'a look-alike host is not X');
});

test('one page per tab and address: the query string and fragment are not the page', () => {
  assert.equal(pageKeyOf('https://example.com/a?utm=1#top'), 'https://example.com/a');
  assert.equal(pageKeyOf('https://example.com/a?x=2'), pageKeyOf('https://example.com/a'));
  assert.notEqual(pageKeyOf('https://example.com/a'), pageKeyOf('https://example.com/b'));
});
