/**
 * The judge-one-page flow with the browser and the network replaced: what is read,
 * when anything is sent out, and what comes back to the panel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isJudgePageResult } from '../../src/domain/article-judgement';
import { ARTICLE_TEXT_CAP_UNITS } from '../../src/domain/article';
import { isRuntimeMessage } from '../../src/domain/messages';
import { judgePage } from '../../src/infrastructure/article-judge';

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function extraction(overrides = {}) {
  const units = overrides.units ?? 900;
  return {
    ok: true,
    article: {
      url: 'https://example.com/blog/post',
      title: 'A launch post',
      author: '',
      site: '',
      published: '',
      description: '',
      language: 'en',
      headings: [],
      text: words(Math.min(units, ARTICLE_TEXT_CAP_UNITS)),
      units,
      paywallDetected: false,
      ...overrides,
    },
  };
}

function deps({ extract, scores = { readable: 0.95, marketing: 0.9, clickbait: 0.05 }, classifyResult } = {}) {
  const calls = { classify: [] };
  return {
    calls,
    deps: {
      extract: extract ?? (async () => extraction()),
      classify: async (state, questions) => {
        calls.classify.push({ state, questions });
        return classifyResult ?? { ok: true, scores, tokens: 1234, model: 'jev-x', complete: true };
      },
    },
  };
}

test('a page is read, sent once with the two rule questions, and judged per rule', async () => {
  const { deps: d, calls } = deps();
  const result = await judgePage(7, d);
  assert.equal(result.ok, true);
  assert.equal(result.verdict.kind, 'judged');
  assert.equal(result.verdict.top.rule, 'marketing');
  assert.equal(result.tokens, 1234);
  assert.equal(calls.classify.length, 1);
  assert.deepEqual(Object.keys(calls.classify[0].questions).sort(), ['clickbait', 'marketing', 'readable']);
  assert.equal(calls.classify[0].state.title, 'A launch post');
  assert.equal(isJudgePageResult(result), true);
});

test('the panel is told what was judged but never gets the page text', async () => {
  const { deps: d } = deps();
  const result = await judgePage(1, d);
  assert.deepEqual(Object.keys(result.page).sort(), ['title', 'units', 'url']);
  assert.equal(JSON.stringify(result).includes('w5'), false);
});

test('a page the gate refuses is never sent out and costs nothing', async () => {
  for (const overrides of [{ title: 'Just a moment...' }, { units: 40 }, { url: 'https://example.com/' }]) {
    const { deps: d, calls } = deps({ extract: async () => extraction(overrides) });
    const result = await judgePage(3, d);
    assert.equal(result.ok, true);
    assert.equal(result.verdict.kind, 'not-article');
    assert.equal(result.tokens, 0);
    assert.equal(calls.classify.length, 0, JSON.stringify(overrides));
  }
});

test('a tab the browser refuses to read is "no access", not a crash', async () => {
  const { deps: d, calls } = deps({
    extract: async () => {
      throw new Error('Cannot access contents of the page. Extension manifest must request permission');
    },
  });
  const result = await judgePage(3, d);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-access');
  assert.equal(calls.classify.length, 0);
  assert.equal(isJudgePageResult(result), true);
});

test('anything that is not the exact extraction shape is refused before the model', async () => {
  for (const raw of [undefined, null, 'x', { ok: false, error: 'boom' }, { ok: true, article: { title: 'only' } }, { ok: true, article: { ...extraction().article, units: -3 } }]) {
    const { deps: d, calls } = deps({ extract: async () => raw });
    const result = await judgePage(3, d);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'extract-failed');
    assert.equal(calls.classify.length, 0);
  }
});

test('a failing provider call comes back as its own error, no verdict is invented', async () => {
  for (const error of ['no-key', 'rate-limited', 'auth', 'network', 'bad-response']) {
    const { deps: d } = deps({ classifyResult: { ok: false, error, detail: 'x' } });
    const result = await judgePage(3, d);
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.equal(isJudgePageResult(result), true);
  }
});

test('an incomplete answer set leaves the unanswered rule undetermined', async () => {
  const { deps: d } = deps({ scores: { readable: 0.9, marketing: 0.9 } });
  const result = await judgePage(3, d);
  assert.equal(result.ok, true);
  const clickbait = result.verdict.outcomes.find((o) => o.rule === 'clickbait');
  assert.equal(clickbait.status, 'undetermined');
  assert.equal(clickbait.reason, 'no-answer');
});

test('the judge-page message needs a whole, non-negative tab id', () => {
  assert.equal(isRuntimeMessage({ type: 'judge-page', tabId: 5 }), true);
  assert.equal(isRuntimeMessage({ type: 'judge-page', tabId: -1 }), false);
  assert.equal(isRuntimeMessage({ type: 'judge-page', tabId: 1.5 }), false);
  assert.equal(isRuntimeMessage({ type: 'judge-page', tabId: '5' }), false);
  assert.equal(isRuntimeMessage({ type: 'judge-page' }), false);
});

test('a result with a made-up shape is not accepted by the panel', () => {
  assert.equal(isJudgePageResult({ ok: true }), false);
  assert.equal(isJudgePageResult({ ok: false, error: 'weird', detail: '' }), false);
  assert.equal(isJudgePageResult({ ok: true, page: { url: '', title: '', units: 1 }, verdict: { kind: 'judged' }, tokens: 0 }), false);
});
