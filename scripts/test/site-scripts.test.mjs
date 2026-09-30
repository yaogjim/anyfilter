/**
 * Another site's script follows the browser's grant, and only that: register when
 * granted, drop when not, never twice, and never for a site nobody turned on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FEED_SITES } from '../../src/domain/feed-sites';
import { createSiteScripts } from '../../src/infrastructure/site-scripts';
import { installChrome, xContentSender } from './harness.mjs';

const HN = FEED_SITES.find((site) => site.id === 'hn');

function world({ granted = false, registered = false, failRegister = false } = {}) {
  const w = {
    granted, registered, log: [],
    deps: {
      hasPermission: async () => w.granted,
      isRegistered: async () => w.registered,
      register: async (site) => {
        if (failRegister) throw new Error('boom');
        if (w.registered) throw new Error('Duplicate script ID');
        w.registered = true;
        w.log.push(`register ${site.id}`);
      },
      unregister: async () => { w.registered = false; w.log.push('unregister'); },
      injectIntoOpenTabs: async (site) => { w.log.push(`inject ${site.id}`); },
    },
  };
  return w;
}

test('the site is a fixed, named entry with its own script and pattern', () => {
  assert.equal(HN.pattern, 'https://news.ycombinator.com/*');
  assert.equal(HN.file, 'hn-feed.js');
  assert.equal(FEED_SITES.some((site) => site.id === 'x'), false, 'X is in the manifest, not here');
});

test('a site nobody granted gets nothing registered', async () => {
  const w = world();
  await createSiteScripts(w.deps).sync();
  assert.deepEqual(w.log, []);
});

test('granting registers the script and puts it into tabs that are already open', async () => {
  const w = world({ granted: true });
  await createSiteScripts(w.deps).sync();
  assert.deepEqual(w.log, ['register hn', 'inject hn']);
});

test('asking again changes nothing, even when a grant, a start and an update ask at once', async () => {
  const w = world({ granted: true });
  const sites = createSiteScripts(w.deps);
  await Promise.all([sites.sync(), sites.sync(), sites.sync()]);
  assert.deepEqual(w.log, ['register hn', 'inject hn']);
});

test('taking the grant away removes the registration', async () => {
  const w = world({ granted: true });
  const sites = createSiteScripts(w.deps);
  await sites.sync();
  w.granted = false;
  await sites.sync();
  assert.deepEqual(w.log, ['register hn', 'inject hn', 'unregister']);
  assert.equal(w.registered, false);
});

test('an update re-registers so the new file is the one that runs', async () => {
  const w = world({ granted: true, registered: true });
  await createSiteScripts(w.deps).sync(true);
  assert.deepEqual(w.log, ['unregister', 'register hn', 'inject hn']);
});

test('a failure is reported and does not stop the next call from working', async () => {
  const w = world({ granted: true, failRegister: true });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const sites = createSiteScripts(w.deps);
    await sites.sync();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not sync hn/);
  } finally {
    console.warn = warn;
  }
});

// One background for the rest of the file; it is loaded once per process.
const handle = installChrome();
handle.setOpenTabs([{ id: 7, url: 'https://news.ycombinator.com/news' }]);
globalThis.defineBackground = (factory) => factory();
await import('../../src/entrypoints/background');

test('in the browser as the background wires it: grant, open tabs, revoke', async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  await settle();
  assert.deepEqual(handle.registeredScripts(), [], 'a fresh install has no site script');

  handle.grantOrigin('https://news.ycombinator.com/*');
  await settle();
  const [script] = handle.registeredScripts();
  assert.equal(script.id, HN.scriptId);
  assert.deepEqual(script.matches, ['https://news.ycombinator.com/*']);
  assert.deepEqual(script.js, ['hn-feed.js']);
  assert.deepEqual(handle.injections, [{ target: { tabId: 7 }, files: ['hn-feed.js'] }]);

  handle.revokeOrigin('https://news.ycombinator.com/*');
  await settle();
  assert.deepEqual(handle.registeredScripts(), []);
});

test('an override from the panel is sent to Hacker News tabs as well as X tabs', async () => {
  const sent = [];
  globalThis.chrome.tabs.query = async (query) => {
    sent.push(query.url);
    return [{ id: 9, url: 'https://news.ycombinator.com/news' }];
  };
  globalThis.chrome.tabs.sendMessage = async (tabId, message) => void sent.push([tabId, message.type]);
  await handle.dispatchMessage({ type: 'override', postId: 'hn:1', shown: true }, xContentSender());
  assert.deepEqual(sent[0], ['https://x.com/*', 'https://news.ycombinator.com/*']);
  assert.deepEqual(sent[1], [9, 'override']);
});
