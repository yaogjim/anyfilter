/**
 * The auto mode flow with everything outside the process replaced: when a tab is
 * looked at, what is sent, what is kept, what the badge says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUTO_MAX_FAILURES, AUTO_RESERVE_MICRO, EMPTY_AUTO_STATE, withEnabled } from '../../src/domain/auto-mode';
import { createAutoRunner } from '../../src/infrastructure/auto-mode';
import { EMPTY_AUTO_RESULTS, trimmed, MAX_TAB_RESULTS } from '../../src/infrastructure/auto-store';

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function article(overrides = {}) {
  return {
    url: 'https://blog.example.com/post/1',
    title: 'A launch post',
    author: '',
    site: '',
    published: '',
    description: '',
    language: 'en',
    headings: [],
    text: words(900),
    units: 900,
    paywallDetected: false,
    ...overrides,
  };
}

/** A whole auto mode world in memory. */
function world({ enabled = true, granted = ['https://blog.example.com/*'], scores, tokens = 3000 } = {}) {
  const w = {
    clock: 1_000_000,
    state: enabled ? withEnabled(EMPTY_AUTO_STATE, true) : EMPTY_AUTO_STATE,
    results: structuredClone(EMPTY_AUTO_RESULTS),
    tabs: new Map(),
    granted: new Set(granted),
    pages: new Map(),
    extracted: [],
    classified: [],
    badges: [],
    cleared: [],
    sleeps: [],
    scores: scores ?? { readable: 0.95, marketing: 0.9, clickbait: 0.05 },
    tokens,
    classifyError: null,
  };
  w.tab = (id, url, extra = {}) => w.tabs.set(id, { url, active: true, status: 'complete', ...extra });
  w.deps = {
    now: () => w.clock,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      w.clock += ms;
    },
    loadState: async () => structuredClone(w.state),
    saveState: async (state) => void (w.state = structuredClone(state)),
    loadResults: async () => structuredClone(w.results),
    saveResults: async (results) => void (w.results = structuredClone(trimmed(results))),
    getTab: async (id) => w.tabs.get(id),
    hasPermission: async (pattern) => w.granted.has(pattern),
    extract: async (id) => {
      w.extracted.push(id);
      return { ok: true, article: w.pages.get(id) ?? article() };
    },
    classify: async (state, questions) => {
      w.classified.push({ state, questions });
      if (w.classifyError) return { ok: false, error: w.classifyError, detail: 'x' };
      return { ok: true, scores: w.scores, tokens: w.tokens, model: 'm', complete: true };
    },
    hash: async (text) => `h${text.length}:${text.slice(0, 40)}`,
    showBadge: (tabId, verdict) => w.badges.push({ tabId, top: verdict.kind === 'judged' ? verdict.top?.rule ?? null : null }),
    clearBadge: (tabId) => w.cleared.push(tabId),
  };
  w.runner = createAutoRunner(w.deps);
  w.go = async (id) => {
    await w.runner.consider(id);
    await w.runner.idle();
  };
  return w;
}

test('with the switch off nothing is read, sent or stored', async () => {
  const w = world({ enabled: false });
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  assert.deepEqual([w.extracted.length, w.classified.length, Object.keys(w.results.tabs).length], [0, 0, 0]);
});

test('a site the person has not authorised is left alone', async () => {
  const w = world({ granted: [] });
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  assert.equal(w.extracted.length, 0, 'the page is not even read');
});

test('X, chrome pages and the provider hosts are never touched, even if authorised', async () => {
  const w = world({ granted: ['https://x.com/*', 'https://api.typesafe.ai/*'] });
  w.tab(1, 'https://x.com/home');
  w.tab(2, 'chrome://extensions');
  w.tab(3, 'https://api.typesafe.ai/docs');
  for (const id of [1, 2, 3]) await w.go(id);
  assert.equal(w.extracted.length, 0);
});

test('only the tab in front, and only once it has finished loading', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1', { active: false });
  w.tab(2, 'https://blog.example.com/post/2', { status: 'loading' });
  await w.go(1);
  await w.go(2);
  assert.equal(w.extracted.length, 0);
  w.tabs.get(1).active = true;
  await w.go(1);
  assert.equal(w.classified.length, 1, 'it is judged when it comes to the front');
});

test('a matching page is judged once, shown on the badge, and costs its real tokens', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1?utm=a');
  await w.go(1);
  assert.equal(w.classified.length, 1);
  assert.deepEqual(Object.keys(w.classified[0].questions).sort(), ['clickbait', 'marketing', 'readable']);
  assert.deepEqual(w.badges, [{ tabId: 1, top: 'marketing' }]);
  assert.equal(w.state.spentMicro, 126, 'settled at 3000 input tokens, not left at the reservation');
  assert.equal(w.state.dayCount, 1);
  const stored = w.results.tabs['1'];
  assert.equal(stored.url, 'https://blog.example.com/post/1', 'the address kept has no query string');
  assert.equal(stored.result.ok, true);
  assert.equal(JSON.stringify(w.results).includes('w100'), false, 'no page text is kept');
});

test('a reload, a new query string or coming back to the tab does not ask again', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  await w.go(1);
  w.tabs.get(1).url = 'https://blog.example.com/post/1?ref=feed#comments';
  await w.go(1);
  assert.equal(w.classified.length, 1);
  assert.equal(w.state.dayCount, 1);
});

test('a reload puts the badge back, because the browser drops a tab\'s badge on navigation', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  w.badges.length = 0; // what the browser did to the tab's badge
  await w.go(1);
  assert.equal(w.classified.length, 1, 'still one paid request');
  assert.deepEqual(w.badges, [{ tabId: 1, top: 'marketing' }]);
});

test('a worker restart does not repeat a paid judgement; it shows the stored one again', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  w.badges.length = 0;
  const restarted = createAutoRunner(w.deps); // no memory of what it did
  await restarted.consider(1);
  await restarted.idle();
  assert.equal(w.classified.length, 1);
  assert.deepEqual(w.badges, [{ tabId: 1, top: 'marketing' }]);
});

test('the same content in another tab is answered from the cache, for free', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1');
  w.tab(2, 'https://blog.example.com/post/1');
  await w.go(1);
  await w.go(2);
  assert.equal(w.classified.length, 1);
  assert.equal(w.state.spentMicro, 126);
  assert.equal(w.results.tabs['2'].result.ok, true);
});

test('another address in the same tab is judged again', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  w.pages.set(1, article({ text: words(1200), units: 1200 }));
  w.tabs.get(1).url = 'https://blog.example.com/post/2';
  await w.go(1);
  assert.equal(w.classified.length, 2);
});

test('a page the code gate refuses is never sent to the model', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/account/login');
  w.pages.set(1, article({ url: 'https://blog.example.com/account/login', title: 'Sign in' }));
  await w.go(1);
  assert.equal(w.classified.length, 0);
  assert.equal(w.state.spentMicro, 0);
  assert.equal(w.results.tabs['1'].result.verdict.kind, 'not-article');
});

test('a clean page leaves no badge', async () => {
  const w = world({ scores: { readable: 0.95, marketing: 0.03, clickbait: 0.05 } });
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  assert.deepEqual(w.badges, [{ tabId: 1, top: null }]);
});

test('requests are spaced and the queue is one at a time', async () => {
  const w = world();
  for (let id = 1; id <= 3; id += 1) {
    w.tab(id, `https://blog.example.com/post/${id}`);
    w.pages.set(id, article({ url: `https://blog.example.com/post/${id}`, text: words(800 + id), units: 800 + id }));
  }
  await Promise.all([1, 2, 3].map((id) => w.runner.consider(id)));
  await w.runner.idle();
  assert.equal(w.classified.length, 3);
  assert.equal(w.sleeps.length >= 2, true, 'the second and third wait for the gap');
});

test('three failures pause auto mode; nothing more is sent until the person resumes', async () => {
  const w = world();
  w.classifyError = 'auth';
  for (let id = 1; id <= AUTO_MAX_FAILURES; id += 1) {
    w.tab(id, `https://blog.example.com/post/${id}`);
    w.pages.set(id, article({ url: `https://blog.example.com/post/${id}`, text: words(800 + id), units: 800 + id }));
    await w.go(id);
  }
  assert.equal(w.state.paused, true);
  assert.equal(w.state.spentMicro, 0, 'rejected requests were not billed');
  const sent = w.classified.length;
  w.tab(9, 'https://blog.example.com/post/9');
  await w.go(9);
  assert.equal(w.classified.length, sent, 'paused: not even asked');
  w.classifyError = null;
  await w.runner.resume();
  await w.go(9);
  assert.equal(w.classified.length, sent + 1);
});

test('at the cap nothing is sent, and the page is picked up again after a reset', async () => {
  const w = world();
  w.state = { ...w.state, spentMicro: 10_000_000 - AUTO_RESERVE_MICRO + 1 };
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  assert.equal(w.classified.length, 0);
  assert.equal(Object.keys(w.results.tabs).length, 0);
  await w.runner.resetSpend();
  await w.go(1);
  assert.equal(w.classified.length, 1);
});

test('turning it off empties the queue, and closing a tab forgets its result', async () => {
  const w = world();
  w.tab(1, 'https://blog.example.com/post/1');
  await w.go(1);
  assert.ok(w.results.tabs['1']);
  await w.runner.forgetTab(1);
  assert.equal(w.results.tabs['1'], undefined);
  const off = await w.runner.setEnabled(false);
  assert.equal(off.enabled, false);
  w.tab(2, 'https://blog.example.com/post/2');
  await w.go(2);
  assert.equal(w.classified.length, 1);
});

test('the stored results are bounded', () => {
  const tabs = {};
  for (let i = 0; i < MAX_TAB_RESULTS + 20; i += 1) {
    tabs[String(i)] = { url: `https://e.example/${i}`, at: i, result: { ok: false, error: 'network', detail: '' } };
  }
  const kept = trimmed({ tabs, cache: {} });
  assert.equal(Object.keys(kept.tabs).length, MAX_TAB_RESULTS);
  assert.ok(kept.tabs[String(MAX_TAB_RESULTS + 19)], 'the newest are kept');
});
