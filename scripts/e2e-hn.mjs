#!/usr/bin/env node
/**
 * Hacker News in a real browser, offline: the page is a saved copy of the real
 * front page (scripts/fixtures/hn-news.html) and the model is answered locally.
 *
 * The one thing this cannot do is click the browser's own "allow this site" prompt.
 * So a temporary copy of the built extension is given the site's permission up
 * front; everything after the grant is real: the background registers the script
 * from that permission at start, the script reads rows, hides them, sends titles,
 * and the panel's "put back" reaches the open page. The prompt itself, and revoking,
 * are checked by hand (docs/hacker-news.md, section 9).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BUILT = path.join(ROOT, '.output', 'chrome-mv3');
const FIXTURE = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'hn-news.html'), 'utf8');
const EXECUTABLE = process.env.ANYFILTER_CHROMIUM ?? chromium.executablePath();

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures += 1;
}
async function waitFor(fn, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`TIMEOUT waiting for: ${label}`);
  return false;
}
function skip(reason) {
  console.log(`\nSKIP: ${reason}`);
  process.exit(process.env.CI ? 1 : 0);
}
if (!existsSync(BUILT)) skip(`${BUILT} does not exist; run "pnpm build" first`);

// A temporary copy that already holds the site's permission.
const EXTENSION_DIR = path.join(mkdtempSync(path.join(tmpdir(), 'anyfilter-hn-ext-')), 'ext');
cpSync(BUILT, EXTENSION_DIR, { recursive: true });
const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...manifest.host_permissions, 'https://news.ycombinator.com/*'];
writeFileSync(manifestPath, JSON.stringify(manifest));

const POLITICAL_ID = '49893509'; // "America.gov"
const modelCalls = [];

let context;
try {
  context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'anyfilter-hn-')), {
    headless: true,
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
} catch (error) {
  skip(`could not launch Chromium: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
}

await context.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('https://news.ycombinator.com/')) {
    if (/\.(css|js|png|gif|ico|svg)(\?|$)/.test(url)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: FIXTURE });
  }
  if (url.startsWith('https://api.typesafe.ai/')) {
    const body = JSON.parse(route.request().postData() ?? '{}');
    modelCalls.push(body);
    const political = String(body.state?.text ?? '').includes('America.gov');
    const answers = Object.fromEntries(
      Object.keys(body.questions ?? {}).map((id) => [id, { type: 'boolean', noul: id === 'politics' && political ? 0.96 : 0.02 }]),
    );
    return route.fulfill({ json: { answers, model: 'jev-mock', usage: { input_tokens: 400, output_tokens: 4 } } });
  }
  if (url.startsWith('chrome-extension://')) return route.continue();
  return route.abort();
});

let [worker] = context.serviceWorkers();
if (!worker) {
  worker = await Promise.race([
    context.waitForEvent('serviceworker'),
    new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  if (!worker) {
    await context.close().catch(() => undefined);
    skip('no extension service worker appeared within 8s');
  }
}
const extensionId = new URL(worker.url()).host;
console.log(`extension ${extensionId} loaded`);

await worker.evaluate(() =>
  chrome.storage.local.set({
    'anyfilter.settings': { provider: 'typesafe', keys: { typesafe: 'fixture-key', vercel: '' } },
  }),
);

// --- the script is registered from the grant, at start ------------------------------
const registered = () =>
  worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((list) => list.map((s) => ({ id: s.id, matches: s.matches, js: s.js }))));
check(
  await waitFor(async () => (await registered()).length === 1, 'registered'),
  'the background registers the Hacker News script from the permission it finds at start',
);
const [script] = await registered();
check(script?.id === 'anyfilter-feed-hn' && script.js?.[0] === 'hn-feed.js' && script.matches?.[0] === 'https://news.ycombinator.com/*', 'with the site-specific match and the built file');

// --- the list page -----------------------------------------------------------------------
const rowState = (page, id) =>
  page.evaluate((itemId) => {
    const row = document.getElementById(itemId);
    if (!row) return null;
    const subtext = row.nextElementSibling;
    const spacer = subtext?.nextElementSibling;
    const hidden = (el) => el !== null && el !== undefined && getComputedStyle(el).display === 'none';
    return { title: hidden(row), subtext: hidden(subtext), spacer: hidden(spacer), spacerIsSpacer: spacer?.classList.contains('spacer') ?? false };
  }, id);
const visibleTitleRows = (page) =>
  page.evaluate(() => [...document.querySelectorAll('tr.athing.submission')].filter((row) => getComputedStyle(row).display !== 'none').length);

const hn = await context.newPage();
await hn.goto('https://news.ycombinator.com/news');
check(
  await waitFor(async () => (await rowState(hn, POLITICAL_ID))?.title === true, 'political row hidden'),
  'a title the model scores as politics is hidden',
);
const hiddenRow = await rowState(hn, POLITICAL_ID);
check(hiddenRow.subtext && hiddenRow.spacer && hiddenRow.spacerIsSpacer, 'its score line and the gap under it go with it, leaving no empty band');
check((await visibleTitleRows(hn)) === 29, 'the other 29 titles stay');
check(modelCalls.length === 30, `each of the 30 titles was asked about once (${modelCalls.length})`);

const first = modelCalls.find((call) => call.state.text.startsWith('Livenerf'));
check(first?.state.text === 'Livenerf: Has Opus 5.5 been nerfed yet? (github.com)', 'what is sent is the title and the host of its link');
check(first?.state.author.handle === '@bryan0', 'and who submitted it');
check(JSON.stringify(Object.keys(first?.state ?? {}).sort()) === JSON.stringify(['author', 'text']), 'nothing else: no points, comment count, age or page text');
check(
  JSON.stringify(Object.keys(first?.questions ?? {}).sort()) === JSON.stringify(['crypto', 'nsfw', 'platitude', 'politics']),
  `only the headline rules are asked: ${Object.keys(first?.questions ?? {}).sort().join(', ')}`,
);
const ask = modelCalls.find((call) => call.state.text.startsWith('Ask HN'));
check(ask?.state.text === 'Ask HN: What are you reading?', 'a post that links to itself has no host after its title');

// --- a page that is not a list is left alone -----------------------------------------
{
  const before = modelCalls.length;
  const item = await context.newPage();
  await item.goto('https://news.ycombinator.com/item?id=49901736');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check(modelCalls.length === before, 'an item page sends nothing');
  check((await visibleTitleRows(item)) === 30, 'and hides nothing, even though the fixture puts the same rows on it');
  await item.close();
}

// --- the panel ----------------------------------------------------------------------------
const panel = await context.newPage();
await panel.setViewportSize({ width: 380, height: 900 });
await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
// Sites are turned on in one place: the "This page" view, next to the authorised sites.
check((await panel.locator('[data-anyfilter-site="hn"]').count()) === 0, 'the overview does not repeat the sites card');
await panel.locator('[data-anyfilter-nav="page"]').click();
check(
  await waitFor(() => panel.locator('[data-anyfilter-site="hn"]').count().then((n) => n === 1), 'sites card'),
  'the panel lists Hacker News under other sites',
);
check((await panel.locator('[data-anyfilter-site="hn"]').getAttribute('data-anyfilter-site-on')) === 'true', 'and shows it as on, because the browser grants it');
check((await panel.locator('[data-anyfilter-sites="toggle"]').getAttribute('aria-pressed')) === 'true', 'the switch agrees');
await panel.locator('[data-anyfilter-nav="home"]').click();

check(
  await waitFor(async () => (await panel.getByText('America.gov (america.gov)').count()) === 0 && (await panel.getByText(/Politics/i).count()) > 0, 'politics group'),
  'the hidden list has a politics group',
);
await panel.getByRole('button', { name: /Politics/i }).first().click();
await panel.getByRole('button', { name: /America\.gov/ }).first().click();
check((await panel.getByText('Hacker News', { exact: false }).count()) > 0, 'the card names the site the title came from');
check(
  (await panel.getByRole('link', { name: /Open on Hacker News/ }).first().getAttribute('href')) === `https://news.ycombinator.com/item?id=${POLITICAL_ID}`,
  'and links to its discussion page, not to X',
);
check(await panel.getByRole('link', { name: /Open on X/ }).count().then((n) => n === 0), 'there is no "Open on X" for it');

await panel.getByRole('button', { name: /Put back in feed/ }).first().click();
check(
  await waitFor(async () => (await rowState(hn, POLITICAL_ID))?.title === false, 'put back'),
  'putting it back in the panel brings the row back on the open Hacker News page',
);
check((await rowState(hn, POLITICAL_ID)).subtext === false && (await visibleTitleRows(hn)) === 30, 'with its score line');

await hn.reload();
await new Promise((resolve) => setTimeout(resolve, 1500));
check((await rowState(hn, POLITICAL_ID)).title === false, 'and after a reload it is still shown: the choice is remembered');

// --- hide it again, then the filter switch --------------------------------------------------
await panel.getByRole('button', { name: /Hide again/ }).first().click();
check(
  await waitFor(async () => (await rowState(hn, POLITICAL_ID))?.title === true, 'hidden again'),
  '"Hide again" in the panel hides the row on the open page again',
);
await worker.evaluate(async () => {
  const key = 'anyfilter.settings';
  const current = (await chrome.storage.local.get(key))[key];
  await chrome.storage.local.set({ [key]: { ...current, filterOn: false } });
});
check(
  await waitFor(async () => (await rowState(hn, POLITICAL_ID))?.title === false && (await visibleTitleRows(hn)) === 30, 'filter off'),
  'switching filtering off in settings shows everything again on the open page',
);

await context.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
