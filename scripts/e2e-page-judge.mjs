#!/usr/bin/env node
/**
 * Real-browser check of "judge this page" (stage 2), against the built extension.
 *
 * What is real: Chrome for Testing with the unpacked extension, the toolbar click
 * (`Extensions.triggerAction`, the same path as the icon), the real side panel
 * driven with trusted mouse events, and the real `activeTab` / `scripting`
 * behaviour. What is replaced: the model. Requests to api.typesafe.ai are caught
 * in the service worker with the CDP Fetch domain and answered locally, so no key
 * is spent and every request can be inspected.
 *
 * Needs a headed Chrome (the side panel does not exist headless). Usage:
 *   pnpm build && node scripts/e2e-page-judge.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = path.join(ROOT, '.output', 'chrome-mv3');
const EXECUTABLE = process.env.ANYFILTER_CHROMIUM ?? chromium.executablePath();
const PORT = 9447;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
};
if (!existsSync(EXT)) {
  console.log(`SKIP: ${EXT} does not exist; run "pnpm build" first`);
  process.exit(process.env.CI ? 1 : 0);
}

const words = (n, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
const para = (text) => `<p>${text}</p>`;
const PAGES = {
  '/blog/careful-essay': {
    title: 'What I learned rewriting a build system',
    body: `<article><h1>What I learned rewriting a build system</h1>${Array.from({ length: 6 }, (_, i) => para(`Section ${i}: ${words(150, 'essay')}`)).join('')}</article><script>window.__pageScriptRan = true;</script>`,
  },
  '/blog/promo-launch': {
    title: 'Introducing SuperCRM - start your free trial today',
    body: `<article><h1>Introducing SuperCRM</h1>${Array.from({ length: 6 }, (_, i) => para(`Feature ${i}: ${words(150, 'promo')}`)).join('')}<p>Get started free. Book a demo.</p></article>`,
  },
  '/blog/very-long': {
    title: 'A very long piece',
    body: `<article><h1>A very long piece</h1>${Array.from({ length: 30 }, (_, i) => para(`Part ${i}: ${words(150, 'long')}`)).join('')}</article>`,
  },
  '/account/login': {
    title: 'Sign in',
    body: `<main><h1>Sign in</h1>${para(words(400, 'login'))}</main>`,
  },
  '/blog/tiny': { title: 'Tiny', body: `<article><h1>Tiny</h1>${para('Just a few words here.')}</article>` },
};
const server = http.createServer((request, response) => {
  const page = PAGES[new URL(request.url, 'http://x').pathname];
  if (!page) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${page.title}</title></head><body>${page.body}</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const OTHER_ORIGIN = `http://localhost:${server.address().port}`;

class Cdp {
  static async attach(targetId) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.n = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.result);
        }
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    };
  }
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }
  send(method, params = {}) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  /** A trusted click at the centre of the first element matching `selector`. */
  async click(selector) {
    const rect = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!rect) throw new Error(`no element for ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: rect.x,
        y: rect.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
  }
  close() {
    this.ws.close();
  }
}

const proc = spawn(
  EXECUTABLE,
  [
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'anyfilter-page-'))}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await sleep(3500);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const browserCdp = await browser.newBrowserCDPSession();
const { extensions } = await browserCdp.send('Extensions.getExtensions');
const extensionId = extensions.find((extension) => extension.name === 'AnyFilter')?.id;
if (!extensionId) {
  console.log('FAIL  the AnyFilter extension did not load');
  process.exit(1);
}
const context = browser.contexts()[0];
const targets = async () => (await browserCdp.send('Target.getTargets', { filter: [{}] })).targetInfos;
const tabTargetFor = async (prefix) => (await targets()).find((target) => target.type === 'tab' && target.url.startsWith(prefix));

// --- the model, replaced: catch every request the service worker makes ---------
const modelRequests = [];
let answerDelayMs = 0;
let scoreFor = () => ({ readable: 0.95, marketing: 0.02, clickbait: 0.03 });
const worker = await (async () => {
  for (let i = 0; i < 40; i += 1) {
    const target = (await targets()).find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`);
    if (target) return Cdp.attach(target.targetId);
    await sleep(250);
  }
  throw new Error('service worker not found');
})();
await worker.send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.typesafe.ai/*' }] });
worker.on('Fetch.requestPaused', (params) => {
  const body = JSON.parse(params.request.postData ?? '{}');
  modelRequests.push({ url: params.request.url, body, authorization: params.request.headers.Authorization ?? params.request.headers.authorization ?? '' });
  const scores = scoreFor(body);
  const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: 'noul', noul: scores[id] ?? 0.02 }]));
  const payload = JSON.stringify({ answers, model: 'jev-mock', usage: { input_tokens: 3300, output_tokens: 100 } });
  setTimeout(() => {
    void worker.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
      body: Buffer.from(payload).toString('base64'),
    });
  }, answerDelayMs);
});
await worker.eval(`chrome.storage.local.set({ 'anyfilter.settings': { provider: 'typesafe', keys: { typesafe: 'sk_e2e_fixture', vercel: '' } } })`);

try {
  // --- open a page, click the toolbar icon on it -------------------------------
  const page = context.pages()[0];
  await page.goto(`${ORIGIN}/blog/careful-essay`);
  const tab = await tabTargetFor(`${ORIGIN}/blog/careful-essay`);
  const domBefore = await page.evaluate(() => ({ length: document.documentElement.outerHTML.length, scripts: document.scripts.length }));
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  const panelTarget = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const found = (await targets()).find((t) => t.type === 'page' && t.url === `chrome-extension://${extensionId}/sidepanel.html`);
      if (found) return found;
      await sleep(250);
    }
    return null;
  })();
  check(panelTarget !== null, 'the toolbar icon opens the side panel on a non-X page');
  if (panelTarget === null) throw new Error('no side panel');
  const panel = await Cdp.attach(panelTarget.targetId);
  await panel.send('Runtime.enable');
  const waitForPanel = async (expression, label, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await panel.eval(expression)) return true;
      await sleep(150);
    }
    console.log(`TIMEOUT: ${label}`);
    return false;
  };
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-page="section"]')`, 'page view'), 'the panel opens on the "this page" view for a non-X tab');

  // --- a good essay: judged, nothing matches -----------------------------------
  await panel.click('[data-anyfilter-page="judge"]');
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-page-verdict]')`, 'verdict'), 'pressing the button returns a verdict');
  check(modelRequests.length === 1, 'exactly one model request for one press');
  const first = modelRequests[0];
  check(first?.url === 'https://api.typesafe.ai/v1/systemone', 'the request goes to the provider the person configured');
  check(first?.authorization === 'Bearer sk_e2e_fixture', 'the request carries the configured key');
  check(JSON.stringify(Object.keys(first?.body.questions ?? {}).sort()) === JSON.stringify(['clickbait', 'marketing', 'readable']), 'two rule questions plus the readability check are asked');
  check(first?.body.state.title === 'What I learned rewriting a build system', 'the page title reached the model');
  check(String(first?.body.state.text).includes('essay10'), 'the page body reached the model');
  check(first?.body.state.truncated === false, 'a short page is not marked truncated');
  check((await panel.eval(`document.querySelector('[data-anyfilter-page-verdict]').dataset.anyfilterPageVerdict`)) === 'clean', 'a clean essay shows "no rule matched"');
  const domAfter = await page.evaluate(() => ({ length: document.documentElement.outerHTML.length, scripts: document.scripts.length, ran: window.__pageScriptRan === true }));
  check(domAfter.length === domBefore.length && domAfter.scripts === domBefore.scripts && domAfter.ran, 'reading the page does not change it (same HTML length, scripts kept, page script state kept)');

  // --- a promo page: matches marketing at its own threshold (0.45 < 0.7) --------
  await page.goto(`${ORIGIN}/blog/promo-launch`);
  const promoTab = await tabTargetFor(`${ORIGIN}/blog/promo-launch`);
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: promoTab.targetId });
  scoreFor = () => ({ readable: 0.95, marketing: 0.45, clickbait: 0.05 });
  await sleep(600);
  check(await waitForPanel(`!document.querySelector('[data-anyfilter-page-verdict]')`, 'old verdict cleared'), 'a new page starts from a blank slate, not the old verdict');
  await panel.click('[data-anyfilter-page="judge"]');
  check(await waitForPanel(`document.querySelector('[data-anyfilter-page-verdict]')?.dataset.anyfilterPageVerdict === 'match'`, 'match'), 'marketing at 45% matches its 40% threshold (would miss at the 70% default)');
  const shown = await panel.eval(`document.querySelector('[data-anyfilter-page-verdict]').innerText`);
  check(/45%/.test(shown) && /40%/.test(shown), 'the badge shows the probability and the threshold');

  // --- a long page: truncated; the title-style rules still answer -------------------
  await page.goto(`${ORIGIN}/blog/very-long`);
  const longTab = await tabTargetFor(`${ORIGIN}/blog/very-long`);
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: longTab.targetId });
  scoreFor = () => ({ readable: 0.95, marketing: 0.02, clickbait: 0.1 });
  await sleep(600);
  const before = modelRequests.length;
  await panel.click('[data-anyfilter-page="judge"]');
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-page-verdict]')`, 'long verdict'), 'a long page is judged');
  const sent = modelRequests[before]?.body.state;
  check(sent?.truncated === true && sent.word_count > 2000, 'a long page is marked truncated with its full word count');
  check(String(sent?.text).split(/\s+/).length <= 2000, 'no more than 2000 words leave the page');
  check((await panel.eval(`document.querySelector('[data-anyfilter-page-rule="clickbait"]')?.dataset.anyfilterPageStatus`)) === 'no-match', 'clickbait is about the title, so a truncated page still gets a plain answer');

  // --- pages the gate refuses cost nothing --------------------------------------
  for (const route of ['/account/login', '/blog/tiny']) {
    await page.goto(`${ORIGIN}${route}`);
    const t = await tabTargetFor(`${ORIGIN}${route}`);
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: t.targetId });
    await sleep(600);
    const count = modelRequests.length;
    await panel.click('[data-anyfilter-page="judge"]');
    check(await waitForPanel(`document.querySelector('[data-anyfilter-page-verdict]')?.dataset.anyfilterPageVerdict === 'not-article'`, route), `${route}: shown as not an article`);
    check(modelRequests.length === count, `${route}: nothing was sent to the model`);
  }

  // --- access is per tab and per origin ------------------------------------------
  const isDisabled = () => panel.eval(`document.querySelector('[data-anyfilter-page="judge"]').disabled`);
  const other = await context.newPage();
  await other.goto(`${ORIGIN}/blog/careful-essay`);
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-page-hint="needs-icon"]')`, 'needs-icon hint'), 'a tab the icon was not clicked on says so up front, with the instruction to click the icon');
  check(await isDisabled(), 'and offers no button that would fail');
  const count2 = modelRequests.length;
  await panel.click('[data-anyfilter-page="judge"]');
  await sleep(500);
  check(modelRequests.length === count2, 'pressing it anyway sends nothing');
  const clickable = (await targets()).find((t) => t.type === 'tab' && t.url === `${ORIGIN}/blog/careful-essay` && t.targetId !== tab.targetId);
  scoreFor = () => ({ readable: 0.95, marketing: 0.02, clickbait: 0.03 });
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: clickable.targetId });
  check(await waitForPanel(`!document.querySelector('[data-anyfilter-page-hint]') && document.querySelector('[data-anyfilter-page="judge"]').disabled === false`, 'enabled after icon'), 'clicking the icon on that tab enables the open panel without reloading it');
  await panel.click('[data-anyfilter-page="judge"]');
  check(await waitForPanel(`document.querySelector('[data-anyfilter-page-verdict]')?.dataset.anyfilterPageVerdict === 'clean'`, 'after icon'), 'and the page can then be judged');
  await other.goto(`${OTHER_ORIGIN}/blog/careful-essay`);
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-page-hint="needs-icon"]')`, 'hint after cross-origin'), 'access is lost when the tab moves to another origin, and the panel says so');
  const count3 = modelRequests.length;
  await panel.click('[data-anyfilter-page="judge"]');
  await sleep(500);
  check(modelRequests.length === count3, 'nothing is sent after access is lost');

  // --- a slow answer for a page the person has left is not shown on the next one --
  {
    const slow = await context.newPage();
    await slow.goto(`${ORIGIN}/blog/promo-launch`);
    const slowTab = (await targets()).find((t) => t.type === 'tab' && t.url === `${ORIGIN}/blog/promo-launch` && t.targetId !== promoTab.targetId) ?? (await tabTargetFor(`${ORIGIN}/blog/promo-launch`));
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: slowTab.targetId });
    await waitForPanel(`document.querySelector('[data-anyfilter-page="judge"]').disabled === false`, 'ready for slow');
    answerDelayMs = 2500;
    scoreFor = () => ({ readable: 0.95, marketing: 0.9, clickbait: 0.05 });
    await panel.click('[data-anyfilter-page="judge"]');
    await sleep(500);
    await slow.goto(`${ORIGIN}/blog/careful-essay`);
    await sleep(3500);
    answerDelayMs = 0;
    check(await panel.eval(`!document.querySelector('[data-anyfilter-page-verdict]')`), 'an answer that arrives after the tab moved to another page is dropped, not shown against it');
  }

  // --- nothing is stored ---------------------------------------------------------
  const stored = JSON.stringify(await worker.eval(`chrome.storage.local.get(null)`));
  check(!stored.includes('essay10') && !stored.includes('promo10'), 'no page text is written to extension storage');
  panel.close();
} catch (error) {
  console.log('FAIL  ', error instanceof Error ? error.stack : String(error));
  failures += 1;
} finally {
  worker.close();
  server.close();
  proc.kill();
  await sleep(300);
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
