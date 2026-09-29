/**
 * Phase 2 capture slice: the local admissibility rule, the exact snapshot shape,
 * the bounded independent store, the sender routing rule, and the read-only
 * property of the passive sampler.
 *
 * Everything is offline: an in-memory `chrome.storage`, a fake DOM that records
 * every mutation and is asserted to stay untouched, and a `fetch` that throws if
 * it is ever called. No network, no provider key, no model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureInputHash,
  CAPTURE_RETENTION_MS,
  captureSkipReason,
  emptyCaptureState,
  isCaptureState,
  isCaptureSubmitResult,
  MAX_OBSERVATIONS_PER_MESSAGE,
  MAX_SAMPLES,
  mergeSample,
  normalizeCaptureState,
  observedStateJson,
  sampleIdFor,
  sampleOf,
  senderKind,
  xPageOf,
  xPageUrlOf,
} from '../../src/domain/capture';
import { isRuntimeMessage } from '../../src/domain/messages';
import { normalizeSettings } from '../../src/domain/settings';
import { PassiveCapture } from '../../src/features/evaluation-capture';
import {
  clearCaptureSamples,
  loadCaptureSamples,
  loadCaptureState,
  onCaptureStateChanged,
  pruneExpiredCaptureSamples,
  recordObservations,
  setCaptureRunState,
} from '../../src/infrastructure/capture-store';
import { installChrome, makePost } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const PANEL_KEY = 'anyfilter.panel';
const KEYS = { vercel: 'vck_vercel', typesafe: 'ts_typesafe' };

function seedLocal(overrides = {}) {
  return {
    [SETTINGS_KEY]: normalizeSettings({ keys: KEYS, ...overrides }),
    [PANEL_KEY]: { tokens: 12, seen: {}, hidden: {}, lastFailure: null },
  };
}

/** Fails any test that reaches the network. */
function banFetch() {
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(String(url));
    throw new Error(`unexpected network call to ${url}`);
  };
  return calls;
}

/** Waits for the sampler's fire-and-forget submit loop to settle. */
async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------- domain rules

test('an eligible post is a public, text-bearing post that is not your own', () => {
  assert.equal(captureSkipReason(makePost()), null);
  assert.equal(captureSkipReason(makePost({ promoted: true })), null);
  assert.equal(captureSkipReason(makePost({ own: true })), 'own');
  assert.equal(captureSkipReason(makePost({ text: '' })), 'no-text');
  assert.equal(captureSkipReason(makePost({ text: '   ' })), 'no-text');
  assert.equal(captureSkipReason(makePost({ id: '' })), 'no-id');
  assert.equal(captureSkipReason(makePost({ id: 'not-a-post-id' })), 'no-id');
  assert.equal(captureSkipReason(makePost({ name: 'x'.repeat(121) })), 'too-long');
  assert.equal(captureSkipReason(makePost({ handle: '' })), 'possibly-protected');
  assert.equal(captureSkipReason(makePost({ text: 'x'.repeat(2000) })), null);
  assert.equal(captureSkipReason(makePost({ text: 'x'.repeat(2001) })), 'too-long');
  assert.equal(captureSkipReason(makePost({ quotedText: 'q'.repeat(1001) })), 'too-long');
});

test('protected placeholders are refused instead of being stored', () => {
  assert.equal(
    captureSkipReason(makePost({ text: 'These posts are protected' })),
    'possibly-protected',
  );
  assert.equal(captureSkipReason(makePost({ text: 'Follow to see more' })), 'possibly-protected');
  assert.equal(
    captureSkipReason(makePost({ text: 'This post may contain sensitive content' })),
    'possibly-protected',
  );
  assert.equal(captureSkipReason(makePost({ text: 'sensitive topics are hard' })), null);
});

test('the snapshot is byte-identical to the state the feed would send', () => {
  const plain = makePost({ handle: 'ada', name: 'Ada Lovelace', text: 'a post about compilers' });
  assert.equal(
    observedStateJson(plain),
    '{"author":{"handle":"@ada","name":"Ada Lovelace"},"text":"a post about compilers"}',
  );

  const rich = makePost({
    handle: 'ada',
    name: 'Ada Lovelace',
    text: 'the body',
    quotedText: 'a quoted post',
    parent: { id: '900', name: 'Grace', handle: 'grace', text: 'the post above', avatarUrl: '' },
  });
  assert.equal(
    observedStateJson(rich),
    '{"author":{"handle":"@ada","name":"Ada Lovelace"},"text":"the body",' +
      '"quoted":"a quoted post","replyingTo":{"author":"@grace","text":"the post above"}}',
  );

  const hash = captureInputHash(observedStateJson(plain));
  assert.equal(hash, captureInputHash(observedStateJson(plain)));
  assert.notEqual(hash, captureInputHash(observedStateJson(makePost({ text: 'other' }))));
});

test('a sample keeps the exact input, a short excerpt and no page query', () => {
  const post = makePost({ text: 'x'.repeat(400) });
  const sample = sampleOf(post, {
    page: 'home',
    pageUrl: xPageUrlOf('https://x.com/home?utm=tracking#frag'),
    capturedAt: 1234,
  });

  assert.equal(sample.pageUrl, 'https://x.com/home');
  assert.equal(sample.capturedAt, 1234);
  assert.equal(sample.stateJson, observedStateJson(post));
  assert.equal(sample.inputHash, captureInputHash(sample.stateJson));
  assert.equal(sample.excerpt.length, 141);
  assert.ok(sample.excerpt.endsWith('…'));
  assert.equal(sample.truncated, false);
  assert.equal(sample.sampleId, sampleIdFor(post));
  assert.equal(xPageUrlOf('not a url'), '');
});

test('repeats are idempotent, an edit adds a record, and the cap sheds the oldest', () => {
  const post = makePost({ id: '5', text: 'stable body' });
  const first = sampleOf(post, { page: 'home', pageUrl: 'https://x.com/home', capturedAt: 1 });
  const same = sampleOf(post, { page: 'search', pageUrl: 'https://x.com/search', capturedAt: 2 });

  const once = mergeSample([], first);
  assert.equal(once.added, true);
  const twice = mergeSample(once.samples, same);
  assert.equal(twice.added, false);
  assert.equal(twice.samples.length, 1);
  assert.equal(twice.samples[0].page, 'home');

  // The same id with a different body must not overwrite the earlier record.
  const edited = { ...first, contentKey: 'different', stateJson: '{}' };
  const afterEdit = mergeSample(once.samples, edited);
  assert.equal(afterEdit.samples.length, 2);
  assert.equal(afterEdit.samples[1].sampleId, `${first.sampleId}#2`);

  let samples = [];
  for (let i = 0; i < MAX_SAMPLES + 1; i += 1) {
    samples = [
      ...mergeSample(samples, { ...first, sampleId: `sample-${i}`, contentKey: `key-${i}` }).samples,
    ];
  }
  assert.equal(samples.length, MAX_SAMPLES);
  assert.equal(samples[0].sampleId, 'sample-1');
  assert.equal(samples[samples.length - 1].sampleId, `sample-${MAX_SAMPLES}`);
});

test('the captured surface and the sender routing rule are decided from the URL', () => {
  assert.equal(xPageOf('https://x.com/home'), 'home');
  assert.equal(xPageOf('https://x.com/search?q=next'), 'search');
  assert.equal(xPageOf('https://x.com/ada/status/1001'), 'status');
  assert.equal(xPageOf('https://x.com/notifications'), null);
  assert.equal(xPageOf('https://example.com/home'), null);
  assert.equal(xPageOf('not a url'), null);

  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(senderKind({ id, url: 'https://x.com/home', tab: { url: 'https://x.com/home' } }, id), 'x-content');
  // A content script always carries `tab`; a tab-less sender is never treated as
  // page content, so a submit can only come from a real X tab.
  assert.equal(senderKind({ id, tab: { url: 'https://x.com/home' } }, id), 'other');
  assert.equal(senderKind({ id, url: 'https://example.com/frame', tab: { url: 'https://x.com/home' } }, id), 'other');
  assert.equal(senderKind({ id, url: 'https://x.com/home', tab: { url: 'https://example.com/' } }, id), 'other');
  assert.equal(senderKind({ id, url: 'https://x.com/home' }, id), 'other');
  assert.equal(senderKind({ id, tab: { url: 'https://example.com/' } }, id), 'other');
  assert.equal(senderKind({ id, tab: { url: 'https://x.com.evil.test/' } }, id), 'other');
  assert.equal(
    senderKind({ id, url: `chrome-extension://${id}/options.html` }, id),
    'extension-page',
  );
  assert.equal(
    senderKind({ id, url: `chrome-extension://${id}/sidepanel.html` }, id),
    'extension-page',
  );
  // Our options page is opened as a real tab, so a tab is present; it must still
  // count as one of our own pages rather than as page content.
  assert.equal(
    senderKind(
      { id, url: `chrome-extension://${id}/options.html`, tab: { url: `chrome-extension://${id}/options.html` } },
      id,
    ),
    'extension-page',
  );
  assert.equal(
    senderKind({ id: 'other-extension', url: 'chrome-extension://other/options.html' }, id),
    'other',
  );
  assert.equal(senderKind({}, id), 'other');
  assert.equal(senderKind({ id, tab: { url: 'https://x.com/home' } }, ''), 'other');
});

test('a corrupted run state can never switch observation on', () => {
  assert.deepEqual(normalizeCaptureState(undefined), emptyCaptureState());
  assert.deepEqual(normalizeCaptureState({ runState: 'active!', epoch: -1 }), emptyCaptureState());
  assert.equal(normalizeCaptureState({ runState: 'active' }).runState, 'active');
  assert.equal(normalizeCaptureState({ runState: 'off', epoch: 3, stored: 2, skipped: 1 }).epoch, 3);
  assert.equal(isCaptureState(emptyCaptureState()), true);
  assert.equal(
    isCaptureState({ runState: 'active', epoch: 1, stored: 0, skipped: 0, updatedAt: 0 }),
    true,
  );
  assert.equal(isCaptureState({ runState: 'active', epoch: 1, stored: 0 }), false);
  assert.equal(
    isCaptureState({ runState: 'on', epoch: 0, stored: 0, skipped: 0, updatedAt: 0 }),
    false,
  );
});

test('only the three capture messages are accepted, and only with valid shapes', () => {
  const post = makePost();
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: 1, posts: [post] }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: 1, posts: [] }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: -1, posts: [post] }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: 1.5, posts: [post] }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: 1, posts: [{ id: 'x' }] }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: 1, posts: 'x' }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-submit', epoch: 1, posts: Array(21).fill(post) }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-set-state', runState: 'active' }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-set-state', runState: 'paused' }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-set-state', runState: 'on' }), false);
  assert.equal(isRuntimeMessage({ type: 'capture-clear' }), true);
  assert.equal(isRuntimeMessage({ type: 'capture-something-else' }), false);
});

// ------------------------------------------------------- independent local store

test('capture is off by default and collects nothing until the user starts it', async () => {
  const handle = installChrome({ local: seedLocal() });
  const before = handle.snapshot();

  const state = await loadCaptureState();
  assert.equal(state.runState, 'off');
  assert.equal(state.stored, 0);

  const refused = await recordObservations({
    epoch: 0,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: 1,
    posts: [makePost()],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not-active');
  assert.deepEqual(handle.snapshot(), before);
  assert.equal(handle.localKeys().includes('anyfilter.capture.samples'), false);
});

test('starting stores only admissible posts, reports counts and stays idempotent', async () => {
  const handle = installChrome({ local: seedLocal() });
  const started = await setCaptureRunState('active');
  assert.equal(started.runState, 'active');
  assert.equal(started.epoch, 1);

  const posts = [
    makePost({ id: '1', text: 'a about compilers' }),
    makePost({ id: '2', text: 'b about compilers' }),
    makePost({ id: '3', text: 'mine', own: true }),
    makePost({ id: '4', text: '' }),
  ];

  const capturedAt = Date.now();
  const first = await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt,
    posts,
  });
  assert.deepEqual(first, { ok: true, stored: 2, skipped: 2 });

  const samples = await loadCaptureSamples();
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((sample) => sample.postId), ['1', '2']);
  assert.equal(samples[0].capturedAt, capturedAt);
  assert.equal(samples[0].page, 'home');

  const state = await loadCaptureState();
  assert.equal(state.runState, 'active');
  assert.equal(state.stored, samples.length);
  assert.equal(state.skipped, 2);

  const repeat = await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt,
    posts,
  });
  assert.deepEqual(repeat, { ok: true, stored: 0, skipped: 4 });
  assert.equal((await loadCaptureSamples()).length, 2);
  assert.equal((await loadCaptureState()).stored, 2);

  // Nothing went to the score cache or the panel.
  assert.deepEqual(handle.sessionKeys(), []);
  assert.equal(handle.readLocal(PANEL_KEY).tokens, 12);
});

test('a paused or stale batch is refused and never written', async () => {
  installChrome({ local: seedLocal() });
  const started = await setCaptureRunState('active');
  const paused = await setCaptureRunState('paused');
  assert.equal(paused.epoch, started.epoch + 1);

  const refusedWhilePaused = await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: 1,
    posts: [makePost({ id: '1' })],
  });
  assert.equal(refusedWhilePaused.ok, false);
  // The run state gate is checked first, so a paused workflow reports the reason
  // that matters most: it is not collecting at all.
  assert.equal(refusedWhilePaused.error, 'not-active');
  assert.equal((await loadCaptureSamples()).length, 0);

  const whilePaused = await recordObservations({
    epoch: paused.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: 1,
    posts: [makePost({ id: '1' })],
  });
  assert.equal(whilePaused.ok, false);
  assert.equal(whilePaused.error, 'not-active');
  assert.equal((await loadCaptureSamples()).length, 0);
});

test('expired samples are hidden on read and physically removed on background wake', async () => {
  const now = Date.now();
  const sample = sampleOf(makePost({ id: '1' }), {
    page: 'home', pageUrl: 'https://x.com/home', capturedAt: now,
  });
  const expired = { ...sample, sampleId: 'expired', capturedAt: now - CAPTURE_RETENTION_MS - 1 };
  const handle = installChrome({ local: {
    ...seedLocal(),
    'anyfilter.capture.state': { runState: 'off', epoch: 3, stored: 2, skipped: 0, updatedAt: now },
    'anyfilter.capture.samples': [expired, sample],
  } });
  assert.deepEqual((await loadCaptureSamples()).map((entry) => entry.sampleId), [sample.sampleId]);
  const state = await pruneExpiredCaptureSamples();
  assert.equal(state.stored, 1);
  assert.deepEqual(handle.readLocal('anyfilter.capture.samples').map((entry) => entry.sampleId), [sample.sampleId]);
  assert.equal(handle.readLocal(SETTINGS_KEY).keys.vercel, KEYS.vercel);
});

test('deleting samples empties the library, bumps the epoch and keeps rules and keys', async () => {
  const handle = installChrome({
    local: seedLocal(),
    session: { 'anyfilter.scores.vercel.abc.5': { bait: 0.9 } },
  });
  const started = await setCaptureRunState('active');
  await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: Date.now(),
    posts: [makePost({ id: '1' }), makePost({ id: '2' })],
  });
  assert.equal((await loadCaptureSamples()).length, 2);

  const cleared = await clearCaptureSamples();
  assert.equal(cleared.stored, 0);
  assert.equal(cleared.epoch, started.epoch + 1);
  assert.deepEqual(await loadCaptureSamples(), []);

  // An in-flight submit from before the delete cannot re-add what was deleted.
  const stale = await recordObservations({
    epoch: started.epoch,
    page: 'home',
    pageUrl: 'https://x.com/home',
    capturedAt: 2,
    posts: [makePost({ id: '1' })],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale-epoch');
  assert.deepEqual(await loadCaptureSamples(), []);

  // Only the two capture keys were touched.
  const stored = handle.readLocal(SETTINGS_KEY);
  assert.deepEqual(stored.keys, KEYS);
  assert.equal(stored.rules.length, 10);
  assert.equal(handle.readLocal(PANEL_KEY).tokens, 12);
  assert.deepEqual(handle.sessionKeys(), ['anyfilter.scores.vercel.abc.5']);

  const resumed = await setCaptureRunState('active');
  assert.equal(resumed.stored, 0);
});

test('state changes are broadcast and the result validators reject junk', async () => {
  const handle = installChrome({ local: seedLocal() });
  const seen = [];
  const stop = onCaptureStateChanged((state) => seen.push(state));
  await setCaptureRunState('active');
  await clearCaptureSamples();
  stop();

  assert.equal(seen.length, 2);
  assert.equal(seen[0].runState, 'active');
  assert.equal(seen[0].epoch, 1);
  assert.equal(seen[1].epoch, 2);
  assert.equal(seen[1].stored, 0);
  assert.deepEqual(handle.sessionKeys(), []);

  assert.equal(isCaptureSubmitResult({ ok: true, stored: 1, skipped: 0 }), true);
  assert.equal(isCaptureSubmitResult({ ok: true, stored: -1, skipped: 0 }), false);
  assert.equal(isCaptureSubmitResult({ ok: false, error: 'not-active', detail: '' }), true);
  assert.equal(isCaptureSubmitResult({ ok: true }), false);
});

// --------------------------------------------------- read-only passive sampler

/** Every mutation attempt on a fake page element lands here, so a test can prove
 * the sampler never writes to the page. */
let pageWrites = [];

/**
 * A fake tweet-shaped DOM. `readPost` and `readPostId` see exactly the selectors
 * they look for; `setAttribute`, `removeAttribute` and a class change are
 * recorded instead of applied.
 */
function tweetElement({ id, text, handle = 'bob', name = 'Bob Ross', time = '13h', promoted = false }) {
  const record = (operation) => pageWrites.push(operation);
  const element = (props = {}) => ({
    textContent: props.textContent ?? '',
    parentElement: props.parentElement ?? null,
    firstElementChild: null,
    getAttribute: (attribute) => props.attrs?.[attribute] ?? null,
    setAttribute: (attribute, value) => record(['setAttribute', attribute, value]),
    removeAttribute: (attribute) => record(['removeAttribute', attribute]),
    querySelector: (selector) => props.children?.[selector] ?? null,
    querySelectorAll: (selector) => props.lists?.[selector] ?? [],
    closest: () => (promoted ? {} : null),
    classList: {
      add: () => record(['classList.add']),
      remove: () => record(['classList.remove']),
      contains: () => false,
    },
    compareDocumentPosition: () => 0,
  });

  return element({
    children: {
      '[data-testid^="UserAvatar-Container-"]': element({
        attrs: { 'data-testid': `UserAvatar-Container-${handle}` },
      }),
      '[data-testid="User-Name"]': element({ children: { span: element({ textContent: name }) } }),
      '[data-testid="tweetText"]': element({ textContent: text }),
    },
    lists: {
      time: [
        {
          textContent: time,
          parentElement: {
            getAttribute: (attribute) => (attribute === 'href' ? `/x/status/${id}` : null),
          },
        },
      ],
    },
  });
}

function installDom({ articles, pathname = '/home', ownHandle = 'ada' }) {
  const observers = [];
  pageWrites = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      observers.push(this);
    }
    observe() {
      this.observing = true;
    }
    disconnect() {
      this.observing = false;
    }
  }

  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 0;
  };
  globalThis.location = { pathname, href: `https://x.com${pathname}` };
  globalThis.document = {
    body: {},
    querySelectorAll: (selector) => (selector === 'article[data-testid="tweet"]' ? articles : []),
    querySelector: (selector) =>
      selector === 'a[data-testid="AppTabBar_Profile_Link"]' && ownHandle !== ''
        ? { getAttribute: () => `/${ownHandle}` }
        : null,
  };

  return {
    writes: () => pageWrites,
    observing: () => observers.filter((observer) => observer.observing).length,
    fire: () => observers.filter((observer) => observer.observing).forEach((o) => o.callback()),
    restore: () => {
      delete globalThis.document;
      delete globalThis.location;
      delete globalThis.MutationObserver;
      delete globalThis.requestAnimationFrame;
    },
  };
}

test('with capture off the sampler installs no observer and reads nothing', async () => {
  const dom = installDom({ articles: [tweetElement({ id: '1', text: 'a post' })] });
  const calls = banFetch();
  const batches = [];
  const capture = new PassiveCapture(async (epoch, posts) => {
    batches.push({ epoch, posts });
    return { ok: true, stored: posts.length, skipped: 0 };
  });
  try {
    capture.applyState(emptyCaptureState());
    await settle();
    assert.equal(dom.observing(), 0);
    assert.deepEqual(batches, []);
    assert.deepEqual(dom.writes(), []);
    assert.deepEqual(calls, []);
  } finally {
    capture.stop();
    dom.restore();
  }
});

test('capture waits when the signed-in account cannot be identified', async () => {
  const dom = installDom({
    ownHandle: '',
    articles: [tweetElement({ id: '1', text: 'may be my post' })],
  });
  const batches = [];
  const capture = new PassiveCapture(async (_epoch, posts) => {
    batches.push(posts);
    return { ok: true, stored: posts.length, skipped: 0 };
  });
  try {
    capture.applyState({ runState: 'active', epoch: 1, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    assert.deepEqual(batches, []);
    assert.deepEqual(dom.writes(), []);
  } finally {
    capture.stop();
    dom.restore();
  }
});

test('clearing while a batch is in flight never re-adds the old page', async () => {
  const dom = installDom({ articles: [tweetElement({ id: '1', text: 'old post' })] });
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const batches = [];
  const capture = new PassiveCapture(async (epoch, posts) => {
    batches.push({ epoch, posts });
    return waiting;
  });
  try {
    capture.applyState({ runState: 'active', epoch: 1, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    capture.applyState({ runState: 'active', epoch: 2, stored: 0, skipped: 0, updatedAt: 0 });
    finish({ ok: false, error: 'stale-epoch', detail: 'cleared' });
    await settle();
    dom.fire();
    await settle();
    assert.equal(batches.length, 1);
    assert.deepEqual(dom.writes(), []);
  } finally {
    capture.stop();
    dom.restore();
  }
});

test('an active sampler submits only admissible posts, in batches, writing nothing', async () => {
  const articles = [];
  for (let i = 1; i <= MAX_OBSERVATIONS_PER_MESSAGE + 5; i += 1) {
    articles.push(tweetElement({ id: String(i), text: `post number ${i}` }));
  }
  articles.push(tweetElement({ id: '900', text: 'my own post', handle: 'ada' }));
  articles.push(tweetElement({ id: '901', text: '   ' }));
  const dom = installDom({ articles });
  const calls = banFetch();
  const batches = [];
  const capture = new PassiveCapture(async (epoch, posts) => {
    batches.push(posts.map((post) => post.id));
    return { ok: true, stored: posts.length, skipped: 0 };
  });

  try {
    capture.applyState({ runState: 'active', epoch: 1, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    await settle();

    assert.equal(dom.observing(), 1);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [MAX_OBSERVATIONS_PER_MESSAGE, 5],
    );
    const submitted = batches.flat();
    assert.equal(submitted.length, MAX_OBSERVATIONS_PER_MESSAGE + 5);
    assert.equal(submitted.includes('900'), false);
    assert.equal(submitted.includes('901'), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(dom.writes(), []);

    // A re-scan of the same DOM resubmits nothing.
    dom.fire();
    await settle();
    assert.equal(batches.length, 2);

    // A delete (new epoch) keeps the already-handled set, so nothing is re-added.
    capture.applyState({ runState: 'active', epoch: 2, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    assert.equal(batches.length, 2);

    // Pausing removes the observer: no reads at all while paused.
    capture.applyState({ runState: 'paused', epoch: 3, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    assert.equal(dom.observing(), 0);
    assert.equal(batches.length, 2);
  } finally {
    capture.stop();
    dom.restore();
  }
});

test('a refused batch is not recorded as handled and is retried on the next read', async () => {
  const dom = installDom({ articles: [tweetElement({ id: '1', text: 'a post' })] });
  banFetch();
  const results = [
    { ok: false, error: 'stale-epoch', detail: 'stale' },
    { ok: true, stored: 1, skipped: 0 },
  ];
  let index = 0;
  const capture = new PassiveCapture(async () => results[Math.min(index++, results.length - 1)]);

  try {
    capture.applyState({ runState: 'active', epoch: 1, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    assert.equal(index, 1);

    // The post was not marked handled, so the next read offers it again.
    dom.fire();
    await settle();
    assert.equal(index, 2);
    assert.deepEqual(dom.writes(), []);
  } finally {
    capture.stop();
    dom.restore();
  }
});

test('the sampler ignores pages outside the captured surfaces', async () => {
  const dom = installDom({
    articles: [tweetElement({ id: '1', text: 'a post' })],
    pathname: '/notifications',
  });
  banFetch();
  const batches = [];
  const capture = new PassiveCapture(async (epoch, posts) => {
    batches.push(posts.length);
    return { ok: true, stored: 0, skipped: 0 };
  });
  try {
    capture.applyState({ runState: 'active', epoch: 1, stored: 0, skipped: 0, updatedAt: 0 });
    await settle();
    assert.deepEqual(batches, []);
    assert.deepEqual(dom.writes(), []);
  } finally {
    capture.stop();
    dom.restore();
  }
});