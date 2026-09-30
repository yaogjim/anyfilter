#!/usr/bin/env node
/**
 * Real-browser check of auto mode, against the built extension.
 *
 * Real: Chrome for Testing, the unpacked extension, the tab events that drive it,
 * `scripting` on an authorised host, the toolbar badge, the side panel driven with
 * trusted mouse events. Replaced: the model (caught in the service worker with the
 * CDP Fetch domain) and the permission prompt. The prompt is a native dialog that
 * automation cannot answer, so the test build of the extension is given
 * http://127.0.0.1/* as a host permission up front. That stands in for "the person
 * pressed Allow"; the prompt itself is checked by hand.
 *
 * Needs a headed Chrome. Usage:
 *   pnpm build && node scripts/e2e-auto-mode.mjs
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BUILT = path.join(ROOT, '.output', 'chrome-mv3');
const EXT = path.join(mkdtempSync(path.join(tmpdir(), 'anyfilter-auto-ext-')), 'ext');
const EXECUTABLE = process.env.ANYFILTER_CHROMIUM ?? chromium.executablePath();
const PORT = 9448;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
};
if (!existsSync(BUILT)) {
  console.log(`SKIP: ${BUILT} does not exist; run "pnpm build" first`);
  process.exit(process.env.CI ? 1 : 0);
}

cpSync(BUILT, EXT, { recursive: true });
const manifestPath = path.join(EXT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
writeFileSync(manifestPath, JSON.stringify(manifest));

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
  '/blog/second-essay': {
    title: 'Notes on a second essay',
    body: `<article><h1>Notes on a second essay</h1>${Array.from({ length: 6 }, (_, i) => para(`Note ${i}: ${words(150, 'second')}`)).join('')}</article>`,
  },
  ...Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `/blog/fresh-${n}`,
      {
        title: `Fresh page ${n}`,
        body: `<article><h1>Fresh page ${n}</h1>${Array.from({ length: 6 }, (_, i) => para(`Fresh ${n} part ${i}: ${words(150, `fresh${n}x`)}`)).join('')}</article>`,
      },
    ]),
  ),
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
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'anyfilter-auto-'))}`,
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

const modelRequests = [];
let failWith = 0;
const isMarketingPage = (body) => String(body.state?.title ?? '').includes('SuperCRM');
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
  modelRequests.push({ body });
  if (failWith) {
    void worker.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: failWith, responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }], body: '' });
    return;
  }
  const scores = isMarketingPage(body) ? { readable: 0.95, marketing: 0.9, clickbait: 0.05 } : { readable: 0.95, marketing: 0.02, clickbait: 0.03 };
  const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: 'noul', noul: scores[id] ?? 0.02 }]));
  const payload = JSON.stringify({ answers, model: 'jev-mock', usage: { input_tokens: 3000, output_tokens: 100 } });
  void worker.send('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
    body: Buffer.from(payload).toString('base64'),
  });
});
await worker.eval(`chrome.storage.local.set({ 'anyfilter.settings': { provider: 'typesafe', keys: { typesafe: 'sk_e2e_fixture', vercel: '' } } })`);
const autoState = () => worker.eval(`chrome.storage.local.get('anyfilter.auto').then((r) => r['anyfilter.auto'] ?? null)`);
const badgeOf = (prefix) =>
  worker.eval(`(async () => { const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(prefix + '*')} }); return tab ? chrome.action.getBadgeText({ tabId: tab.id }) : null; })()`);
const settle = async (ms = 1500) => sleep(ms);
const until = async (fn, label, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(150);
  }
  console.log(`TIMEOUT: ${label}`);
  return false;
};

try {
  const page = context.pages()[0];
  await page.goto(`${ORIGIN}/blog/careful-essay`);
  const tab = await tabTargetFor(`${ORIGIN}/blog/careful-essay`);

  // --- off by default: nothing is read or sent --------------------------------------
  await settle();
  check(modelRequests.length === 0, 'with the switch off (the default) a loaded page sends nothing');
  check((await autoState()) === null || (await autoState()).enabled === false, 'the switch is off until the person turns it on');

  // --- open the panel, look at the section --------------------------------------------
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
  const panelTarget = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const found = (await targets()).find((t) => t.type === 'page' && t.url === `chrome-extension://${extensionId}/sidepanel.html`);
      if (found) return found;
      await sleep(250);
    }
    return null;
  })();
  if (panelTarget === null) throw new Error('no side panel');
  const panel = await Cdp.attach(panelTarget.targetId);
  await panel.send('Runtime.enable');
  const waitForPanel = (expression, label, timeout) => until(() => panel.eval(expression), label, timeout);
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-auto="section"]')`, 'auto section'), 'the panel shows the auto judging section under "this page"');
  check((await panel.eval(`document.querySelector('[data-anyfilter-auto="toggle"]').getAttribute('aria-pressed')`)) === 'false', 'it shows as off');
  const usage = await panel.eval(`document.querySelector('[data-anyfilter-auto="usage"]').innerText`);
  check(/\$0\.0000/.test(usage) && /\$10\.0000/.test(usage) && /0 of 300/.test(usage), `usage starts at zero against the $10 cap and 300 a day (${usage})`);
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-auto-site="127.0.0.1"]')`, 'site list'), 'the allowed site is listed');
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-auto="site-allowed"]')`, 'site allowed'), 'the current site is shown as allowed');

  // --- turn it on with a real click ---------------------------------------------------
  await panel.click('[data-anyfilter-auto="toggle"]');
  check(await until(async () => (await autoState())?.enabled === true, 'enabled'), 'a real click on the switch turns it on');
  check(await waitForPanel(`document.querySelector('[data-anyfilter-auto="toggle"]').getAttribute('aria-pressed') === 'true'`, 'toggle on'), 'and the panel shows it on');

  // --- a page loads in the front tab: judged, badge, panel shows it ---------------------
  await page.goto(`${ORIGIN}/blog/promo-launch`);
  check(await until(() => modelRequests.length === 1, 'first request'), 'a page that finishes loading in the front tab is judged with no click');
  const sent = modelRequests[0]?.body;
  check(JSON.stringify(Object.keys(sent?.questions ?? {}).sort()) === JSON.stringify(['clickbait', 'marketing', 'readable']), 'the same three questions as a manual judgement');
  check(String(sent?.state.text).includes('promo10'), 'the page body reached the model');
  check(await until(async () => (await badgeOf(`${ORIGIN}/blog/promo-launch`)) === 'MKT', 'badge'), 'a marketing hit puts MKT on the toolbar icon of that tab');
  const promoTab = await tabTargetFor(`${ORIGIN}/blog/promo-launch`);
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: promoTab.targetId });
  check(await waitForPanel(`document.querySelector('[data-anyfilter-page-auto="result"] [data-anyfilter-page-verdict]')?.dataset.anyfilterPageVerdict === 'match'`, 'panel shows auto result'), 'opening "this page" shows the automatic verdict without pressing anything');
  const st = await autoState();
  check(st.spentMicro === 126 && st.dayCount === 1, `the spend is settled at the real tokens: 3000 tokens = 126 micro-dollars (${st.spentMicro}, ${st.dayCount} today)`);
  check(await waitForPanel(`/\\$0\\.0001/.test(document.querySelector('[data-anyfilter-auto="usage"]').innerText)`, 'usage line'), 'the panel usage line moved');

  // --- reload and revisit: no second request ---------------------------------------------
  await page.reload();
  await settle();
  await page.goto(`${ORIGIN}/blog/promo-launch?utm=feed`);
  await settle();
  check(modelRequests.length === 1, 'reloading, or adding a query string, does not ask again');
  check(await until(async () => (await badgeOf(`${ORIGIN}/blog/promo-launch`)) === 'MKT', 'badge after reload'), 'and the badge is still on after the reload (the browser drops it on navigation)');
  await page.reload();
  await settle();
  check(await until(async () => (await badgeOf(`${ORIGIN}/blog/promo-launch`)) === 'MKT', 'badge after second reload'), 'a plain reload of the same address also brings the badge back');

  // --- a clean page: judged, no badge ------------------------------------------------------
  await page.goto(`${ORIGIN}/blog/careful-essay`);
  check(await until(() => modelRequests.length === 2, 'second request'), 'another page in the same tab is judged');
  await settle(500);
  check((await badgeOf(`${ORIGIN}/blog/careful-essay`)) === '', 'a clean page leaves no badge');

  // --- gate-refused pages cost nothing ------------------------------------------------------
  for (const route of ['/account/login', '/blog/tiny']) {
    await page.goto(`${ORIGIN}${route}`);
    await settle();
    check(modelRequests.length === 2, `${route}: read locally, nothing sent`);
  }

  // --- an unauthorised origin is left alone --------------------------------------------------
  await page.goto(`${OTHER_ORIGIN}/blog/second-essay`);
  await settle(2500);
  check(modelRequests.length === 2, 'a site the person has not allowed (localhost) is not read');

  // --- a background tab waits until it is in front ---------------------------------------------
  const front = await context.newPage();
  await front.goto('about:blank');
  await front.bringToFront();
  await page.goto(`${ORIGIN}/blog/second-essay`); // loads in a tab that is not in front
  await settle(2500);
  check(modelRequests.length === 2, 'a page loading in a background tab is not judged');
  await page.bringToFront();
  check(await until(() => modelRequests.length === 3, 'judged on activation'), 'it is judged when the person switches to it');
  await front.close();

  // --- failures stop it, the panel says so, resume restarts it -----------------------------------
  failWith = 401;
  const beforeFail = modelRequests.length;
  for (const n of [1, 2, 3]) {
    await page.goto(`${ORIGIN}/blog/fresh-${n}`);
    check(await until(() => modelRequests.length === beforeFail + n, `failure ${n}`, 10000), `rejected request ${n} is attempted (2 s apart)`);
  }
  check(await until(async () => (await autoState())?.paused === true, 'paused', 5000), 'three rejected requests in a row stop auto mode');
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-auto="paused"]')`, 'paused notice'), 'and the panel says so');
  const afterPause = modelRequests.length;
  await page.goto(`${ORIGIN}/blog/fresh-4`);
  await settle(2500);
  check(modelRequests.length === afterPause, 'while stopped nothing is sent');
  check((await autoState()).spentMicro === 126 * 3, `rejected requests were not billed (${(await autoState()).spentMicro})`);
  failWith = 0;
  if (await panel.eval(`!!document.querySelector('[data-anyfilter-auto="resume"]')`)) await panel.click('[data-anyfilter-auto="resume"]');
  check(await until(async () => (await autoState())?.paused === false, 'resumed'), 'Resume restarts it');

  // --- the cap -----------------------------------------------------------------------------------
  await worker.eval(`chrome.storage.local.get('anyfilter.auto').then((r) => chrome.storage.local.set({ 'anyfilter.auto': { ...r['anyfilter.auto'], spentMicro: 9999900 } }))`);
  const beforeCap = modelRequests.length;
  await page.goto(`${ORIGIN}/blog/tiny`);
  await page.goto(`${ORIGIN}/blog/promo-launch?cap=1`);
  await settle(2500);
  check(modelRequests.length === beforeCap, 'at the $10 cap nothing more is sent');
  check(await waitForPanel(`!!document.querySelector('[data-anyfilter-auto="cap"]')`, 'cap notice'), 'and the panel says the cap is reached');
  await panel.click('[data-anyfilter-auto="reset"]');
  check(await until(async () => (await autoState())?.spentMicro === 0, 'reset'), 'Reset usage clears the spend');

  // --- switching off ---------------------------------------------------------------------------------
  await panel.click('[data-anyfilter-auto="toggle"]');
  check(await until(async () => (await autoState())?.enabled === false, 'disabled'), 'a click turns it off');
  const beforeOff = modelRequests.length;
  await page.goto(`${ORIGIN}/blog/promo-launch?off=1`);
  await settle(2500);
  check(modelRequests.length === beforeOff, 'when off, nothing is sent');

  // --- what is stored -----------------------------------------------------------------------------------
  const local = JSON.stringify(await worker.eval(`chrome.storage.local.get(null)`));
  const session = JSON.stringify(await worker.eval(`chrome.storage.session.get(null)`));
  check(!local.includes('promo10') && !local.includes('essay10') && !session.includes('promo10') && !session.includes('essay10'), 'no page text is stored, in local or in session storage');
  check(!/127\.0\.0\.1/.test(JSON.stringify((await worker.eval(`chrome.storage.local.get('anyfilter.auto').then((r) => r['anyfilter.auto'])`)))), 'the durable auto state holds no address');
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
