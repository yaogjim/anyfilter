/**
 * Offline test doubles: an in-memory `chrome.storage` (local + session, with
 * change events), a fetch recorder, and small builders for provider responses.
 *
 * Everything here is deterministic and makes no network calls, so the suite is
 * safe to run in CI and never costs tokens.
 */

function makeEvent() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => {
      for (const listener of [...listeners]) listener(...args);
    },
    count: () => listeners.size,
    /** Invokes every listener and returns what each of them returned, so a test
     * can see whether a message listener asked to answer asynchronously. */
    invoke: (...args) => [...listeners].map((listener) => listener(...args)),
  };
}

/** The extension id the stubbed `chrome.runtime.id` reports. */
export const TEST_EXTENSION_ID = 'anyfiltertestextensionid';

/** One of our own pages, as the background would see it. */
export function extensionPageSender(id = TEST_EXTENSION_ID) {
  return { id, url: `chrome-extension://${id}/sidepanel.html` };
}

/** Our content script running in an X tab. */
export function xContentSender(id = TEST_EXTENSION_ID) {
  return { id, url: 'https://x.com/home', tab: { url: 'https://x.com/home' } };
}

/** An unrelated web page (never reaches the listener in a real browser). */
export function webPageSender() {
  return { url: 'https://evil.test/page' };
}

function createStorageArea(name, map, notify) {
  const report = (changes) => {
    if (Object.keys(changes).length > 0) notify(changes, name);
  };
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return Object.fromEntries(map);
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (map.has(key)) out[key] = map.get(key);
        return out;
      }
      if (typeof keys === 'object') {
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) {
          out[key] = map.has(key) ? map.get(key) : fallback;
        }
        return out;
      }
      return {};
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: map.get(key), newValue: value };
        map.set(key, value);
      }
      report(changes);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (!map.has(key)) continue;
        changes[key] = { oldValue: map.get(key), newValue: undefined };
        map.delete(key);
      }
      report(changes);
    },
    async clear() {
      const changes = {};
      for (const [key, value] of map) changes[key] = { oldValue: value, newValue: undefined };
      map.clear();
      report(changes);
    },
  };
}

/** Installs an in-memory `chrome` global and returns inspection helpers. */
export function installChrome({ local = {}, session = {} } = {}) {
  const localMap = new Map(Object.entries(structuredClone(local)));
  const sessionMap = new Map(Object.entries(structuredClone(session)));
  const onChanged = makeEvent();
  const notify = (changes, areaName) => onChanged.emit(changes, areaName);
  const onMessage = makeEvent();

  globalThis.chrome = {
    storage: {
      local: createStorageArea('local', localMap, notify),
      session: createStorageArea('session', sessionMap, notify),
      onChanged,
    },
    runtime: {
      id: TEST_EXTENSION_ID,
      getURL: (path) => `chrome-extension://${TEST_EXTENSION_ID}/${path}`,
      sendMessage: async () => {
        throw new Error('chrome.runtime.sendMessage is not modelled in unit tests');
      },
      onMessage,
      onInstalled: makeEvent(),
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined,
      onUpdated: makeEvent(),
    },
    sidePanel: {
      setOptions: async () => undefined,
      setPanelBehavior: async () => undefined,
    },
  };

  return {
    storageChanged: onChanged,
    onMessage,
    /** Delivers one runtime message to the registered listeners and resolves with
     * whatever the listener answered. A listener that does not ask to answer
     * asynchronously resolves to `undefined` immediately; a listener that hangs
     * times out instead of blocking the suite. */
    dispatchMessage: (message, sender = extensionPageSender()) =>
      new Promise((resolve) => {
        let settled = false;
        const sendResponse = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const results = onMessage.invoke(message, sender, sendResponse);
        if (!results.some((keepsAlive) => keepsAlive === true)) {
          sendResponse(undefined);
          return;
        }
        const timer = setTimeout(() => sendResponse(undefined), 2000);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    snapshot: () => ({
      local: structuredClone(Object.fromEntries(localMap)),
      session: structuredClone(Object.fromEntries(sessionMap)),
    }),
    localKeys: () => [...localMap.keys()].sort(),
    sessionKeys: () => [...sessionMap.keys()].sort(),
    readLocal: (key) => localMap.get(key),
  };
}

/** Replaces the global fetch with a recorder; `handler` must return a response. */
export function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return calls;
}

function headerBag(headers) {
  const map = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return { get: (name) => map.get(String(name).toLowerCase()) ?? null };
}

/** A minimal stand-in for a `fetch` Response, only covering what the adapters read. */
export function jsonResponse(data, { status = 200, headers = {}, body } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerBag(headers),
    json: async () => structuredClone(data),
    text: async () => (body !== undefined ? body : JSON.stringify(data)),
  };
}

/** Vercel AI Gateway answer shape: `{ answers: { id: { type, probability } } }`. */
export function vercelAnswers(scores, { inputTokens = 100 } = {}) {
  const answers = {};
  for (const [id, probability] of Object.entries(scores)) {
    answers[id] = { type: 'boolean', probability };
  }
  return { answers, usage: { inputTokens } };
}

/** TypeSafe direct answer shape, which reports the probability under `noul`. */
export function typesafeAnswers(scores, { inputTokens = 100 } = {}) {
  const answers = {};
  for (const [id, probability] of Object.entries(scores)) {
    answers[id] = { type: 'boolean', noul: probability };
  }
  return { answers, usage: { input_tokens: inputTokens } };
}

let postCounter = 1000;

/** A syntactically valid {@link import('../src/domain/post').Post}. */
export function makePost(overrides = {}) {
  postCounter += 1;
  const id = overrides.id ?? String(postCounter);
  return {
    id,
    kind: 'post',
    parent: null,
    thread: id,
    own: false,
    name: 'Ada Lovelace',
    handle: 'ada',
    time: '1h',
    text: 'a post about compilers',
    promoted: false,
    avatarUrl: '',
    imageUrls: [],
    hasVideo: false,
    quotedName: '',
    quotedText: '',
    truncated: false,
    ...overrides,
  };
}

/** The Vercel endpoint the classifier actually posts to. */
export const VERCEL_URL = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';