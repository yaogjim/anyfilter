/**
 * Auto mode as the background wires it: who may switch it, that the browser's tab
 * events drive it, and what it leaves behind in storage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extensionPageSender,
  installChrome,
  installFetch,
  jsonResponse,
  typesafeAnswers,
  webPageSender,
  xContentSender,
} from './harness.mjs';

const words = (n) => Array.from({ length: n }, (_, i) => `secretword${i}`).join(' ');
const PAGE = 'https://blog.example.com/post/1';

const handle = installChrome({
  local: { 'anyfilter.settings': { provider: 'typesafe', keys: { typesafe: 'sk_secret_value', vercel: '' } } },
});
Object.assign(globalThis.chrome.scripting, {
  executeScript: async () => [
    {
      result: {
        ok: true,
        article: {
          url: PAGE, title: 'A launch post', author: '', site: '', published: '', description: '', language: 'en',
          headings: [], text: words(900), units: 900, paywallDetected: false,
        },
      },
    },
  ],
});
const calls = installFetch(() =>
  jsonResponse(typesafeAnswers({ readable: 0.95, marketing: 0.9, clickbait: 0.05 }, { inputTokens: 3000 })),
);
globalThis.defineBackground = (factory) => factory();
await import('../../src/entrypoints/background');

async function until(check, what) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const autoState = () => handle.snapshot().local['anyfilter.auto'];

test('only one of our own pages can switch auto mode on', async () => {
  for (const sender of [webPageSender(), xContentSender()]) {
    const reply = await handle.dispatchMessage({ type: 'auto-set-enabled', enabled: true }, sender);
    assert.equal(reply, null);
  }
  assert.equal(autoState(), undefined, 'a refused request writes nothing');
  const ok = await handle.dispatchMessage({ type: 'auto-set-enabled', enabled: true }, extensionPageSender());
  assert.equal(ok.enabled, true);
  assert.equal(autoState().enabled, true);
});

test('resume and reset are equally closed to web pages and content scripts', async () => {
  for (const type of ['auto-resume', 'auto-reset-spend']) {
    assert.equal(await handle.dispatchMessage({ type }, webPageSender()), null);
    assert.equal(await handle.dispatchMessage({ type }, xContentSender()), null);
  }
});

test('a tab that finishes loading on an unauthorised site sends nothing', async () => {
  handle.tabs.set(1, { url: PAGE });
  handle.tabs.complete(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 0);
});

test('once the site is authorised, the same tab event judges the page and shows the badge', async () => {
  handle.grantOrigin('https://blog.example.com/*');
  handle.tabs.complete(1);
  await until(() => calls.length === 1, 'one model request');
  await until(() => handle.badges.some((b) => b.kind === 'text' && b.text === 'MKT'), 'the badge');
  assert.equal(calls.length, 1);
  await until(() => autoState()?.spentMicro === 126, 'the spend to settle at 3000 tokens');
  assert.equal(autoState().dayCount, 1);
  const sent = JSON.stringify(calls[0].body);
  assert.ok(sent.includes('secretword0'), 'the page text reached the provider, as it does for a manual judgement');
});

test('what auto mode keeps: counters in local storage, a verdict and an address in session, never page text', () => {
  const { local, session } = handle.snapshot();
  const stored = JSON.stringify({ auto: local['anyfilter.auto'], results: session['anyfilter.auto.results'] });
  assert.equal(stored.includes('secretword'), false);
  assert.equal(JSON.stringify(local['anyfilter.auto']).includes('example.com'), false, 'no address in durable storage');
  assert.ok(session['anyfilter.auto.results'].tabs['1'], 'the tab result is in session storage');
  assert.equal(session['anyfilter.auto.results'].tabs['1'].url, PAGE);
  assert.equal(Object.keys(session['anyfilter.auto.results'].cache).length, 1);
});

test('coming back to the tab does not ask again', async () => {
  handle.tabs.activate(1);
  handle.tabs.complete(1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
});

test('closing the tab forgets its result', async () => {
  handle.tabs.remove(1);
  await until(() => handle.snapshot().session['anyfilter.auto.results'].tabs['1'] === undefined, 'the tab result to go');
});

test('clear data empties the session results too', async () => {
  const before = handle.snapshot().session['anyfilter.auto.results'];
  assert.ok(Object.keys(before.cache).length > 0);
  await handle.dispatchMessage({ type: 'clear-data' }, extensionPageSender());
  assert.equal(handle.snapshot().session['anyfilter.auto.results'], undefined);
});

test('switching it off stops new judgements', async () => {
  await handle.dispatchMessage({ type: 'auto-set-enabled', enabled: false }, extensionPageSender());
  handle.tabs.set(2, { url: 'https://blog.example.com/post/2' });
  handle.tabs.complete(2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
});
