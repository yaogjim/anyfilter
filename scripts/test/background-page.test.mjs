/**
 * The background side of "judge this page": how the toolbar icon opens the panel,
 * who may ask for a page to be read, and that nothing is sent out for a page the
 * gate refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extensionPageSender,
  installChrome,
  installFetch,
  jsonResponse,
  TYPESAFE_URL,
  typesafeAnswers,
  webPageSender,
  xContentSender,
} from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function extraction(overrides = {}) {
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
      text: words(900),
      units: 900,
      paywallDetected: false,
      ...overrides,
    },
  };
}

async function setup({ settings, page } = {}) {
  const handle = installChrome({
    local: { [SETTINGS_KEY]: settings ?? { provider: 'typesafe', keys: { typesafe: 'sk_secret_value', vercel: '' } } },
  });
  const injected = [];
  globalThis.chrome.scripting = {
    executeScript: async (injection) => {
      injected.push(injection);
      if (page instanceof Error) throw page;
      return [{ result: page ?? extraction() }];
    },
  };
  const calls = installFetch(() =>
    jsonResponse(typesafeAnswers({ readable: 0.95, marketing: 0.9, clickbait: 0.05 }, { inputTokens: 3300 })),
  );
  globalThis.defineBackground = (factory) => factory();
  await import('../../src/entrypoints/background');
  return { handle, injected, calls };
}

// One module load per process: everything below shares this background.
const shared = await setup();

test('the toolbar icon opens the panel on the clicked tab, in the same turn', () => {
  shared.handle.clickToolbarIcon({ id: 42, url: 'https://example.com/a' });
  // Nothing was awaited: `sidePanel.open` has to run inside the click's gesture.
  assert.deepEqual(shared.handle.sidePanelOpens, [{ tabId: 42 }]);
  shared.handle.clickToolbarIcon({ id: undefined });
  assert.equal(shared.handle.sidePanelOpens.length, 1, 'a click without a tab opens nothing');
});

test('a toolbar click leaves a signal an open panel can watch, and nothing about the page', async () => {
  shared.handle.clickToolbarIcon({ id: 7, url: 'https://example.com/private?token=1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const session = shared.handle.snapshot().session;
  assert.equal(typeof session['anyfilter.toolbarClickedAt'], 'number');
  assert.equal(JSON.stringify(session).includes('example.com'), false);
});

test('the browser is told not to open the panel on its own, on every start', () => {
  // The flag is stored by the browser: an older install may still have it on.
  assert.ok(shared.handle.panelBehaviors.length > 0);
  assert.equal(shared.handle.panelBehaviors.every((b) => b.openPanelOnActionClick === false), true);
});

test('the panel is enabled everywhere, not only on X', () => {
  assert.ok(shared.handle.sidePanelOptions.some((o) => o.enabled === true && o.tabId === undefined));
  assert.equal(shared.handle.sidePanelOptions.some((o) => o.enabled === false), false);
});

test('only one of our own pages may ask for a page to be read', async () => {
  for (const sender of [webPageSender(), xContentSender()]) {
    const result = await shared.handle.dispatchMessage({ type: 'judge-page', tabId: 5 }, sender);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no-access');
  }
  assert.equal(shared.injected.length, 0, 'nothing was injected for a refused sender');
  assert.equal(shared.calls.length, 0);
});

test('an extension page gets a judgement: the extractor is injected and one request is sent', async () => {
  const result = await shared.handle.dispatchMessage({ type: 'judge-page', tabId: 5 }, extensionPageSender());
  assert.equal(result.ok, true);
  assert.equal(result.verdict.kind, 'judged');
  assert.equal(result.verdict.top.rule, 'marketing');
  assert.equal(result.tokens, 3300);
  assert.deepEqual(shared.injected[0], { target: { tabId: 5 }, files: ['/article-extractor.js'] });
  assert.equal(shared.calls.length, 1);
  assert.equal(shared.calls[0].url, TYPESAFE_URL);
  assert.deepEqual(Object.keys(shared.calls[0].body.questions).sort(), ['clickbait', 'marketing', 'readable']);
});

test('the key is never in the reply and the page text is not returned', async () => {
  const result = await shared.handle.dispatchMessage({ type: 'judge-page', tabId: 5 }, extensionPageSender());
  const text = JSON.stringify(result);
  assert.equal(text.includes('sk_secret_value'), false);
  assert.equal(text.includes('w17'), false);
});
