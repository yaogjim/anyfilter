#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const HOME_FIXTURE = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'x-home.html'), 'utf8');
const STATUS_FIXTURE = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'x-status.html'), 'utf8');
const EXECUTABLE = process.env.ANYFILTER_CHROMIUM ?? chromium.executablePath();
const FAKE_KEY = 'vck_offline_fixture_key';

const MOCK_SCORES = [
  { marker: 'Next.js', scores: { promo: 0.2 } },
  { marker: '#connect', scores: { bait: 0.86, platitude: 0.53 } },
  { marker: 'parasites', scores: { hate: 0.98, spam: 0.2 } },
  { marker: 'Splunk Token Meter', scores: { promo: 0.3 } },
  { marker: 'where the money actually goes', scores: { platitude: 0.8 } },
  { marker: 'order of magnitude', scores: {} },
  { marker: '福不黑', scores: { porn: 0.88, spam: 0.44 } },
];

const jevCalls = [];
/** Manual-verification calls to TypeSafe direct. Kept apart from `jevCalls`, which
 * records the production filter's own Vercel calls. */
const typesafeCalls = [];
/** Real-evaluation calls to the two independent machine labellers, with the
 * Authorization header each carried, so key isolation can be asserted. */
const openaiCalls = [];
const deepseekCalls = [];
let failures = 0;
mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });

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

/**
 * Ends local runs with an explicit, visible skip instead of hanging. CI must
 * fail if Chromium cannot run the suite; a skipped check is not a passing test.
 */
function skip(reason) {
  console.log(`\nSKIP: ${reason}`);
  console.log('This end-to-end suite needs a Chromium build that loads an unpacked MV3');
  console.log('extension together with its service worker. Install one, or point at an');
  console.log('existing binary with ANYFILTER_CHROMIUM=/path/to/chrome, then retry.');
  console.log('The offline unit tests and the evaluation script are unaffected.');
  process.exit(process.env.CI ? 1 : 0);
}

if (!existsSync(EXTENSION_DIR)) {
  skip(`${EXTENSION_DIR} does not exist; run "pnpm build" first`);
}

async function launchContext() {
  try {
    return await chromium.launchPersistentContext(
      mkdtempSync(path.join(tmpdir(), 'anyfilter-')),
      {
        headless: true,
        ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
        args: [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
        ],
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return skip(`could not launch Chromium: ${message.split('\n')[0]}`);
  }
}

const context = await launchContext();

await context.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('https://x.com/')) {
    const body = url.includes('/status/') ? STATUS_FIXTURE : HOME_FIXTURE;
    await route.fulfill({ contentType: 'text/html', body });
    return;
  }
  if (url.startsWith('https://ai-gateway.vercel.sh/')) {
    const body = JSON.parse(route.request().postData() ?? '{}');
    jevCalls.push(body);
    const text = body.state?.text ?? '';
    const scores = MOCK_SCORES.find((mock) => text.includes(mock.marker))?.scores ?? {};
    const answers = Object.fromEntries(
      Object.keys(body.questions ?? {}).map((questionId) => [
        questionId,
        {
          type: 'boolean',
          probability: questionId.startsWith('custom:') && text.includes('Next.js')
            ? 0.9
            : scores[questionId] ?? 0.02,
        },
      ]),
    );
    await route.fulfill({ json: { answers, usage: { inputTokens: 600, outputTokens: 100 } } });
    return;
  }
  if (url.startsWith('https://api.typesafe.ai/')) {
    // The manual verification path. It is a separate endpoint from the feed's
    // Vercel gateway, so it is recorded and answered separately. Every request
    // here is one that a human explicitly asked for.
    const body = JSON.parse(route.request().postData() ?? '{}');
    typesafeCalls.push(body);
    const answers = Object.fromEntries(
      Object.keys(body.questions ?? {}).map((questionId) => [
        questionId,
        { type: 'boolean', noul: 0.91 },
      ]),
    );
    await route.fulfill({
      json: { answers, model: 'jev-1.13.0', usage: { input_tokens: 321, output_tokens: 4 } },
    });
    return;
  }
  if (url.startsWith('https://api.openai.com/') || url.startsWith('https://relay.example/')) {
    const body = JSON.parse(route.request().postData() ?? '{}');
    openaiCalls.push({ url, body, authorization: route.request().headers().authorization ?? '' });
    await route.fulfill({
      json: {
        model: `${body.model}-2026-08-01`,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ state: 'match', reason: 'mock openai reason' }) } }],
        usage: { prompt_tokens: 420, completion_tokens: 14 },
      },
    });
    return;
  }
  if (url.startsWith('https://api.deepseek.com/')) {
    const body = JSON.parse(route.request().postData() ?? '{}');
    deepseekCalls.push({ body, authorization: route.request().headers().authorization ?? '' });
    await route.fulfill({
      json: {
        model: 'deepseek-flash',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ state: 'no-match', reason: 'mock deepseek reason' }) } }],
        usage: { prompt_tokens: 380, completion_tokens: 12 },
      },
    });
    return;
  }
  if (url.startsWith('chrome-extension://')) {
    await route.continue();
    return;
  }
  await route.abort();
});

let [worker] = context.serviceWorkers();
if (!worker) {
  const found = await Promise.race([
    context.waitForEvent('serviceworker'),
    new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  if (!found) {
    await context.close().catch(() => undefined);
    skip('no extension service worker appeared within 8s');
  }
  worker = found;
}
const extensionId = new URL(worker.url()).host;
console.log(`extension ${extensionId} loaded`);

const feed = await context.newPage();
await feed.setViewportSize({ width: 1280, height: 4000 });
await feed.goto('https://x.com/home');

const cellHidden = (id) =>
  feed.evaluate(
    (cellId) =>
      document.querySelector(`#${cellId} > div`)?.classList.contains('anyfilter-hidden') ?? false,
    id,
  );

const reviewToolbarCount = (page = feed) => page.locator('[data-anyfilter-host="toolbar"]').count();

// A fresh install opens X in review mode: no switching, nothing hidden.
check(
  await waitFor(async () => (await reviewToolbarCount()) === 1, 'default review mode'),
  'a fresh install opens X in review mode without anyone switching it on',
);
check(!(await cellHidden('cell-ad')), 'and review mode hides nothing');

// Profiles and lists render posts like the home timeline, so they are read and
// marked too. The fake X serves the same posts for every non-status URL. The
// Replies tab and notifications are not post streams the filter reads, and the
// review decoration is the visible proof that a page was read.
{
  const decoratedCount = (page) =>
    page.evaluate(() => document.querySelectorAll('article[data-anyfilter-review]').length);
  for (const [url, read] of [
    ['https://x.com/rauchg', true],
    ['https://x.com/i/lists/1585430245762441216', true],
    ['https://x.com/rauchg/with_replies', false],
    ['https://x.com/notifications', false],
  ]) {
    const other = await context.newPage();
    await other.goto(url);
    if (read) {
      check(
        await waitFor(async () => (await decoratedCount(other)) > 0, `posts read on ${url}`),
        `${new URL(url).pathname} is read and marked like the home timeline`,
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      check((await decoratedCount(other)) === 0, `${new URL(url).pathname} is left alone`);
    }
    await other.close();
  }
}

const panel = await context.newPage();
await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
check((await panel.locator('[data-anyfilter-review="toggle"]').getAttribute('aria-pressed')) === 'true', 'the side panel shows review mode as on');
await panel.locator('[data-anyfilter-review="toggle"]').click();
check(
  await waitFor(async () => (await reviewToolbarCount()) === 0 && (await cellHidden('cell-ad')), 'review off'),
  'turning the switch off leaves review mode on the open page and filtering resumes',
);
check(!(await cellHidden('cell-bait')), 'engagement bait is NOT hidden before a key is configured');
await panel.setViewportSize({ width: 360, height: 800 });
check(
  await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  'home navigation fits a 360px side panel without horizontal overflow',
);
check(await panel.locator('[data-anyfilter-nav="home"]').getAttribute('aria-pressed') === 'true', 'home is the default view');
check((await panel.locator('[data-anyfilter-verification="section"]').count()) === 0, 'home does not mount the long sample list');
await panel.locator('[data-anyfilter-nav="settings"]').click();
check(await panel.locator('#anyfilter-key').isVisible(), 'settings open inside the side panel');
check(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'settings fit a 360px side panel');
await panel.screenshot({ path: path.join(ROOT, 'tmp', 'sidepanel-settings.png'), fullPage: true });
await panel.locator('[data-anyfilter-nav="home"]').click();
check(await panel.locator('#anyfilter-key').isHidden(), 'home navigation hides settings without leaving the panel');
await panel.setViewportSize({ width: 1000, height: 800 });
check(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'home navigation fits a wide panel');
await panel.setViewportSize({ width: 360, height: 800 });
await panel.locator('[data-anyfilter-nav="settings"]').click();
const settingsPageOpened = context.waitForEvent('page');
await panel.getByRole('button', { name: 'Open full page' }).click();
const options = await settingsPageOpened;
await options.waitForLoadState();
check(options.url().endsWith('/options.html'), 'full settings can still open as a separate browser tab');

// ---------------------------------------------------------------------------
// Interface language, end to end: English is the default, 简体中文 is a stored
// preference (its own key, never a filtering setting), the two open pages agree
// without a reload, a reload keeps the choice, and switching back to English
// changes nothing but that one preference.
const readLocale = () =>
  options.evaluate(
    async () => (await chrome.storage.local.get('anyfilter.ui.locale'))['anyfilter.ui.locale'] ?? null,
  );
const readLocalStorage = () => options.evaluate(async () => chrome.storage.local.get(null));

const storageBeforeLanguage = await readLocalStorage();
check((await readLocale()) === null, 'no interface language is stored before the user picks one');
check(
  (await panel.evaluate(() => document.documentElement.lang)) === 'en' &&
    (await options.evaluate(() => document.documentElement.lang)) === 'en',
  'both pages report English before any language choice is made',
);
check(
  ((await panel.locator('[data-anyfilter-nav="settings"]').textContent()) ?? '').trim() === 'Settings' &&
    ((await panel.locator('[data-anyfilter-nav="verification"]').textContent()) ?? '').trim() === 'Verify',
  'the side panel navigation is English by default',
);
check(
  (await options.locator('[data-anyfilter-language="select"]').inputValue()) === 'en' &&
    (await options.getByText('This only changes the language of this interface', { exact: false }).count()) === 1,
  'the settings page offers the language control and is English by default',
);

await panel.locator('[data-anyfilter-language="select"]').selectOption('zh-CN');
check(
  await waitFor(
    async () => ((await panel.locator('[data-anyfilter-nav="settings"]').textContent()) ?? '').trim() === '设置',
    'panel switched to Chinese',
  ),
  'choosing 简体中文 switches the side panel to Chinese',
);
check(
  (await panel.evaluate(() => document.documentElement.lang)) === 'zh-CN',
  'the panel document language follows the choice',
);
check((await readLocale()) === 'zh-CN', 'the choice is stored under its own language preference key');
check(
  await waitFor(
    async () => (await options.locator('[data-anyfilter-language="select"]').inputValue()) === 'zh-CN',
    'options followed to Chinese',
  ),
  'the other open page switches language without a reload',
);
check(
  await waitFor(
    async () => (await options.getByText('这里只切换界面语言', { exact: false }).count()) === 1,
    'options Chinese copy',
  ),
  'the settings page renders its Chinese copy as well',
);
await panel.locator('[data-anyfilter-nav="verification"]').click();
check(
  (await panel.locator('[data-anyfilter-verification="section"]').getByRole('heading', { name: '单条验证' }).count()) === 1 &&
    (await panel.locator('[data-anyfilter-capture="section"]').getByRole('heading', { name: '采集管理' }).count()) === 1,
  'the verification and capture views use Chinese instead of bilingual copy',
);
check(
  ((await panel.locator('[data-anyfilter-verification="section"]').textContent()) ?? '').includes('并非服务商强制执行的消费限额'),
  'the Chinese verification view preserves the local-budget warning',
);
await panel.locator('[data-anyfilter-nav="settings"]').click();

// A reload must keep the choice: it is a stored preference, not per-page state.
await options.reload();
await options.waitForLoadState();
check(
  await waitFor(
    async () => (await options.locator('[data-anyfilter-language="select"]').inputValue()) === 'zh-CN',
    'reloaded settings still Chinese',
  ),
  'reloading the settings page keeps Chinese',
);
check(
  (await options.evaluate(() => document.documentElement.lang)) === 'zh-CN',
  'the reloaded settings page still reports Chinese',
);

// The side panel is a page too: reloading it must not lose the stored choice.
await panel.reload();
check(
  await waitFor(
    async () => (await panel.evaluate(() => document.documentElement.lang)) === 'zh-CN',
    'reloaded panel still Chinese',
  ),
  'reloading the side panel keeps Chinese as well',
);

// Back to English from the settings page; the panel must follow, and no stored
// filtering setting or unrelated local-storage key may change.
await options.locator('[data-anyfilter-language="select"]').selectOption('en');
check(
  await waitFor(
    async () => (await options.getByText('This only changes the language of this interface', { exact: false }).count()) === 1,
    'options English copy restored',
  ),
  'switching back restores the settings page English copy',
);
check(
  await waitFor(
    async () => ((await panel.locator('[data-anyfilter-nav="settings"]').textContent()) ?? '').trim() === 'Settings',
    'panel switched back to English',
  ),
  'the side panel follows back to English',
);
check((await readLocale()) === 'en', 'the stored language preference is English again');
const storageAfterLanguage = await readLocalStorage();
const changedStorageKeys = [
  ...new Set([...Object.keys(storageBeforeLanguage), ...Object.keys(storageAfterLanguage)]),
].filter((key) => JSON.stringify(storageBeforeLanguage[key]) !== JSON.stringify(storageAfterLanguage[key]));
check(
  changedStorageKeys.length === 1 && changedStorageKeys[0] === 'anyfilter.ui.locale',
  `the language round trip changed no filtering setting or stored data (changed: ${changedStorageKeys.join(', ') || 'none'})`,
);

await panel.locator('[data-anyfilter-nav="home"]').click();
await options.locator('#anyfilter-key').fill(FAKE_KEY);

check(await waitFor(() => cellHidden('cell-bait'), 'bait hidden after key'), 'engagement bait is hidden once a key is set (mock Jev)');
check(await waitFor(() => cellHidden('cell-hate'), 'hate hidden after key'), 'hateful reply is hidden (mock Jev)');
check(!(await cellHidden('cell-keep')), 'substantive post stays visible');
check(await waitFor(() => cellHidden('cell-thread-reply'), 'thread reply hidden'), 'platitude reply in a home-timeline thread module is hidden');
check(await waitFor(() => cellHidden('cell-thread-head'), 'thread head hidden'), 'the post it hangs under is hidden with it (whole module goes)');
check(jevCalls.length === 5, `Jev called once per classifiable post (got ${jevCalls.length})`);
check(
  jevCalls.every((call) => Object.keys(call.questions).length === 9),
  'each Jev call carries the 9 built-in intent questions',
);
check(
  jevCalls.some((call) => call.questions.bait?.instructions?.includes('Answer no if:') && call.questions.bait.instructions.includes('Examples that should be answered no:')),
  'built-in questions include exclusion guidance and negative examples',
);
check(
  jevCalls.every((call) => call.state?.author?.handle?.startsWith('@') && typeof call.state?.author?.name === 'string'),
  'Jev receives author handle and display name',
);

const postsSection = panel.locator('[data-anyfilter-section="post"]');
const repliesSection = panel.locator('[data-anyfilter-section="reply"]');
check(
  await waitFor(async () => (await postsSection.getByText('Engagement bait').count()) > 0, 'panel group'),
  'Posts section shows the Engagement bait group',
);
check(
  await waitFor(async () => (await postsSection.getByText('Ads').count()) > 0, 'panel ads group'),
  'Posts section shows the Ads group',
);
check((await repliesSection.count()) === 0, 'Replies section is not shown while no reply is hidden');
check((await panel.getByRole('button', { name: /Roman Shalabanov/ }).count()) === 0, 'reason groups start collapsed');
await postsSection.getByRole('button', { name: /Engagement bait/ }).click();
check(
  await waitFor(async () => (await panel.getByRole('button', { name: /Roman Shalabanov/ }).count()) === 1, 'expanded group'),
  'expanding a reason group lists its rows',
);
const hiddenTile = await panel.locator('div:has(> div:text-is("Hidden posts")) > div:nth-child(2) > span').first().textContent();
check(hiddenTile?.trim() === '4', `Hidden tile counts 4 (got ${hiddenTile?.trim()})`);
const savedTile = await panel.locator('div:has(> div:text-is("Time saved")) > div:nth-child(2) > span').first().textContent();
check(savedTile?.trim() === '32s', `Time saved tile shows 32s (got ${savedTile?.trim()})`);
check((await panel.locator('h1 + p').count()) === 0, 'header shows no status line while everything is fine');

await panel.getByRole('switch').click();
check(await waitFor(async () => !(await cellHidden('cell-ad')) && !(await cellHidden('cell-bait')), 'filter off shows all'), 'switching the filter off shows every hidden post');
const callsWhileOff = jevCalls.length;
await feed.evaluate(() => {
  const cell = document.querySelector('#cell-keep');
  const clone = cell.cloneNode(true);
  clone.id = 'cell-late';
  const article = clone.querySelector('article');
  article.removeAttribute('data-anyfilter');
  article.removeAttribute('data-anyfilter-id');
  clone.querySelector('[data-testid="tweetText"]').textContent = 'people from that country are all parasites and should be kicked out';
  clone.querySelector('a[href*="/status/"]').setAttribute('href', '/rauchg/status/1009');
  cell.parentElement.append(clone);
});
await new Promise((resolve) => setTimeout(resolve, 600));
check(jevCalls.length === callsWhileOff, 'nothing is classified while the filter is off');
check(!(await cellHidden('cell-late')), 'a post that appears while the filter is off stays visible');
await panel.getByRole('switch').click();
check(await waitFor(() => cellHidden('cell-bait'), 'filter on hides again'), 'switching the filter back on hides them again');
check(await waitFor(() => cellHidden('cell-late'), 'late post hidden'), 'posts that appeared while off are classified once the filter is back on');

await panel.getByRole('button', { name: /Roman Shalabanov/ }).first().click();
check((await panel.locator('img[src*="profile_images/roman"]').count()) === 3, 'group header, row and preview card all show the real avatar image');
check((await panel.getByText('Quoted: building in public').count()) === 1, 'preview shows the quoted post');
check((await panel.locator('img[src*="media/connect_banner"]').count()) === 1, 'preview shows the attached image');
check((await panel.locator('img[src*="media/quoted_pic"]').count()) === 0, 'quoted post image is not mistaken for the post image');
check((await panel.getByRole('link', { name: 'Show more' }).count()) === 1, 'preview shows a Show more link for a truncated long post');
check(
  (await panel.getByRole('link', { name: '@RomanShalabanov' }).getAttribute('href')) === 'https://x.com/RomanShalabanov' &&
    (await panel.getByRole('link', { name: '· 13h' }).count()) === 1,
  'preview shows handle (linking to the profile) and time like a native post',
);
check((await panel.getByText('Quoted Person').count()) === 1, 'quote card shows the quoted author');
check((await panel.getByRole('link', { name: 'Open on X ↗' }).getAttribute('href')) === 'https://x.com/RomanShalabanov/status/1002', 'preview links to the original post');
const quotedCall = jevCalls.find((call) => call.state?.text?.includes('#connect'));
check(quotedCall?.state?.quoted === 'Quoted: building in public is the way', 'Jev receives the quoted text as state');
await panel.getByRole('button', { name: 'Put back in feed' }).first().click();
check(await waitFor(async () => !(await cellHidden('cell-bait')), 'put back'), '"Put back in feed" restores that one post');
check(await cellHidden('cell-hate'), 'other hidden posts stay hidden after a single put-back');

// ---------------------------------------------------------------------------
// In-timeline review mode: every post stays visible and carries the judgement,
// nothing new is asked of Jev, no setting changes, and leaving restores hiding.
const setReviewMode = async (on) => {
  // Review mode is one stored setting; every open X page follows it.
  await panel.evaluate(async (flag) => {
    const key = 'anyfilter.settings';
    const current = (await chrome.storage.local.get(key))[key] ?? {};
    await chrome.storage.local.set({ [key]: { ...current, reviewMode: flag } });
  }, on);
  await waitFor(async () => ((await reviewToolbarCount()) === 1) === on, 'review mode followed the setting');
};
const reviewOf = (cellId) =>
  feed.evaluate((id) => document.querySelector(`#${id} article`)?.getAttribute('data-anyfilter-review') ?? null, cellId);
const reviewHostCount = () =>
  feed.evaluate(() => document.querySelectorAll('[data-anyfilter-host="label"], [data-anyfilter-host="toolbar"]').length);
// Every stored setting except the review switch itself, which these steps flip.
const storedSettings = () =>
  options.evaluate(async () => {
    const stored = (await chrome.storage.local.get('anyfilter.settings'))['anyfilter.settings'];
    return JSON.stringify({ ...stored, reviewMode: undefined });
  });
const callsBeforeReview = jevCalls.length;
const settingsBeforeReview = await storedSettings();

check((await reviewOf('cell-hate')) === null, 'no review decoration exists before review mode is turned on');
await setReviewMode(true);
check(
  await waitFor(async () => !(await cellHidden('cell-hate')) && !(await cellHidden('cell-bait')) && !(await cellHidden('cell-ad')), 'review shows everything'),
  'review mode shows every post that was hidden',
);
check((await reviewOf('cell-hate')) === 'flagged', 'a hidden hateful reply is outlined as would-hide');
check((await reviewOf('cell-ad')) === 'flagged', 'a promoted post is outlined as would-hide by the local ad rule');
check((await reviewOf('cell-keep')) === 'kept', 'a fully answered, unmatched post is outlined as would-keep');
check((await reviewOf('cell-bait')) === 'kept', 'a post the person put back is outlined as kept');
const reviewLabel = (cellId) =>
  feed.evaluate(
    (id) => document.querySelector(`#${id} article > [data-anyfilter-host="label"]`)?.shadowRoot?.querySelector('.state')?.textContent ?? null,
    cellId,
  );
check((await reviewLabel('cell-hate')) === 'Would hide', 'the label states the decision in the interface language');
check(
  await feed.evaluate(() => getComputedStyle(document.querySelector('#cell-hate article')).outlineStyle === 'solid'),
  'the outline is drawn on the post itself',
);
check(
  (await feed.locator('[data-anyfilter-host="toolbar"]').count()) === 1,
  'a review toolbar is shown while the mode is on',
);
check(jevCalls.length === callsBeforeReview, 'turning review mode on asks Jev nothing');
await setReviewMode(false);
check(
  await waitFor(async () => (await cellHidden('cell-hate')) && (await cellHidden('cell-ad')), 'review exit hides again'),
  'leaving review mode hides flagged posts again',
);
check(!(await cellHidden('cell-bait')), 'a put-back post stays visible after leaving review mode');
check((await reviewHostCount()) === 0, 'leaving review mode removes every injected node');
check((await reviewOf('cell-hate')) === null, 'leaving review mode removes the outline attribute');
check(jevCalls.length === callsBeforeReview, 'leaving review mode asks Jev nothing');
check((await storedSettings()) === settingsBeforeReview, 'review mode never changes a stored setting');

// One global switch: the side panel and the settings page drive the same setting,
// and a page opened later starts in that state instead of starting over.
await panel.locator('[data-anyfilter-review="toggle"]').click();
check(
  await waitFor(async () => (await reviewToolbarCount()) === 1, 'panel switch on'),
  'the side panel switch turns review mode on for the page that is already open',
);
check(
  await waitFor(async () => (await panel.locator('[data-anyfilter-review="toggle"]').getAttribute('aria-pressed')) === 'true', 'panel pressed'),
  'and shows it as on',
);
const secondFeed = await context.newPage();
await secondFeed.setViewportSize({ width: 1280, height: 1000 });
await secondFeed.goto('https://x.com/home');
check(
  await waitFor(async () => (await reviewToolbarCount(secondFeed)) === 1, 'second page review'),
  'a page opened afterwards starts in review mode too',
);
await options.locator('[data-anyfilter-review="setting-toggle"]').click();
check(
  await waitFor(async () => (await reviewToolbarCount(secondFeed)) === 0 && (await reviewToolbarCount()) === 0, 'settings switch off'),
  'the switch in settings turns review mode off on every open page',
);
check(
  await waitFor(async () => (await options.locator('[data-anyfilter-review="setting-toggle"]').getAttribute('aria-pressed')) === 'false', 'settings pressed'),
  'and shows it as off',
);
await secondFeed.reload();
await secondFeed.waitForTimeout(1200);
check((await reviewToolbarCount(secondFeed)) === 0, 'a reload keeps it off');
await secondFeed.close();

// ---------------------------------------------------------------------------
// Labelling inside the timeline: the single-post panel, saved labels, the
// worth-reading flag, undo, collapse and a reload that finds the labels again.
const reviewRecords = () =>
  options.evaluate(async () => (await chrome.storage.local.get('anyfilter.review.records'))['anyfilter.review.records']?.records ?? []);
const labelButton = feed.locator('#cell-hate [data-anyfilter-host="label"] button.label');
const reviewPanelRoot = feed.locator('[data-anyfilter-host="panel"] .panel');
const callsBeforeLabelling = jevCalls.length;

await setReviewMode(true);
check(await waitFor(async () => (await labelButton.count()) === 1, 'label button'), 'the label on a post is a keyboard-reachable button');
await feed.evaluate(() => {
  window.__docClicks = 0;
  document.addEventListener('click', () => { window.__docClicks += 1; });
});
await labelButton.click();
check(await reviewPanelRoot.isVisible(), 'clicking the label opens the single-post panel');
check((await reviewPanelRoot.getAttribute('role')) === 'dialog', 'the panel is a dialog for assistive technology');
check(
  (await reviewPanelRoot.getByText('Hate & insults', { exact: false }).count()) >= 1 &&
    (await reviewPanelRoot.locator('label.rule[title*="98% (threshold 70%)"]').count()) >= 1 &&
    (await reviewPanelRoot.locator('label.rule .score', { hasText: '98%' }).count()) >= 1,
  'the panel shows each rule with its score, and the threshold in its tooltip',
);
const overlap = await feed.evaluate(() => {
  const panelRect = document.querySelector('[data-anyfilter-host="panel"]').getBoundingClientRect();
  return ['reply', 'retweet', 'like'].some((name) => {
    const r = document.querySelector(`#cell-hate [data-testid="${name}"]`).getBoundingClientRect();
    return !(r.right <= panelRect.left || r.left >= panelRect.right || r.bottom <= panelRect.top || r.top >= panelRect.bottom);
  });
});
check(!overlap, 'the panel does not cover X\'s reply, repost or like buttons');
// The fixture feed spans the whole window; X keeps posts in a narrow centre column, so
// give the fixture the same shape before checking which side the panel takes.
await feed.addStyleTag({ content: '#cell-hate { max-width: 600px; }' });
await feed.evaluate(() => window.dispatchEvent(new Event('resize')));
await feed.waitForTimeout(150);
const placement = await feed.evaluate(() => {
  const panel = document.querySelector('[data-anyfilter-host="panel"]');
  const article = document.querySelector('#cell-hate article');
  return {
    floating: getComputedStyle(panel).position === 'fixed' && panel.parentElement === document.body,
    outsideFeed: !document.querySelector('#cell-hate').contains(panel),
    right: panel.getBoundingClientRect().left >= article.getBoundingClientRect().right,
    inWindow: panel.getBoundingClientRect().right <= document.documentElement.clientWidth && panel.getBoundingClientRect().top >= 0,
  };
});
check(placement.floating && placement.outsideFeed, 'the panel floats over the page and adds no height to the feed');
check(placement.right, 'the panel sits to the right of the post');
check(placement.inWindow, 'the panel stays inside the window');
check((await feed.evaluate(() => window.__docClicks)) === 0, 'clicks on the label never reach X\'s own handlers');

check(
  await reviewPanelRoot.getByRole('button', { name: 'Save label' }).isHidden(),
  'there is no Save button: a complete choice is stored as soon as it is made',
);
check((await reviewRecords()).length === 0, 'opening the panel stores nothing');
await reviewPanelRoot.getByRole('button', { name: 'Should hide' }).click();
check(
  await waitFor(async () => (await reviewRecords()).length === 1, 'record stored'),
  'choosing Should hide on a post the model flagged stores it with one click',
);
check(
  (await reviewRecords())[0].rules.length === 1 && (await reviewRecords())[0].rules[0].ruleId === 'hate',
  'the rules the model itself hit are ticked and stored',
);
await reviewPanelRoot.locator('label.rule', { hasText: 'Hate & insults' }).locator('input').uncheck();
check(
  await waitFor(async () => (await reviewPanelRoot.getByText('Tick a rule', { exact: false }).count()) === 1, 'problem'),
  'clearing the last rule of a hide verdict says what is missing',
);
check((await reviewRecords())[0].rules.length === 1, 'and the stored label is left as it was');
await reviewPanelRoot.locator('label.rule', { hasText: 'Hate & insults' }).locator('input').check();
check(
  await waitFor(async () => (await reviewPanelRoot.getByText('Tick a rule', { exact: false }).count()) === 0, 'problem gone'),
  'ticking it again clears the message',
);
const stored = (await reviewRecords())[0];
check(
  stored.overall === 'hide' && stored.rules.length === 1 && stored.rules[0].ruleId === 'hate' && stored.rules[0].label === 'match',
  'only the ticked rule is labelled',
);
check(stored.source === 'in-timeline-assisted', 'the stored label is marked as assisted, never blind');
check(
  stored.stateJson.includes('parasites') && stored.snapshot.state === 'flagged',
  'the label keeps the exact post text and what the feed had decided',
);
check(
  (await reviewPanelRoot.getByText('Saved').count()) === 1 &&
    await waitFor(
      () => feed.evaluate(() => document.querySelector('#cell-hate [data-anyfilter-host="label"]').shadowRoot.querySelector('.chips').textContent.includes('Labeled')),
      'labeled chip',
    ),
  'the label shows "Labeled" only after it was stored',
);

await reviewPanelRoot.getByRole('button', { name: 'Worth reading', exact: true }).click();
check(
  await waitFor(() => feed.evaluate(() => document.querySelector('#cell-hate article').hasAttribute('data-anyfilter-valuable')), 'gold'),
  'marking a post worth reading turns its outline gold',
);
check(
  await waitFor(
    () => feed.evaluate(() => getComputedStyle(document.querySelector('#cell-hate article')).outlineColor === 'rgb(201, 151, 0)'),
    'gold outline',
  ),
  'the gold outline is really drawn',
);
check((await reviewLabel('cell-hate')) === 'Would hide', 'the label still shows the model\'s own judgement next to the gold flag');
check((await reviewRecords())[0].valuable === true && (await reviewRecords())[0].overall === 'hide', 'the flag is stored next to the verdict');

// Collapse is a display state only.
const recordsBeforeCollapse = JSON.stringify(await reviewRecords());
await reviewPanelRoot.getByRole('button', { name: 'Hide for now' }).click();
check(
  await waitFor(() => feed.evaluate(() => document.querySelector('#cell-hate article').hasAttribute('data-anyfilter-collapsed')), 'collapsed'),
  'a post can be hidden for now from its panel',
);
check(
  await feed.evaluate(() => document.querySelector('#cell-hate [data-testid="like"]').getBoundingClientRect().height === 0),
  'the collapsed post takes no space',
);
check(JSON.stringify(await reviewRecords()) === recordsBeforeCollapse, 'collapsing writes no label');
await feed.locator('#cell-hate [data-anyfilter-host="label"] button.restore').click();
check(
  await waitFor(() => feed.evaluate(() => !document.querySelector('#cell-hate article').hasAttribute('data-anyfilter-collapsed')), 'restored'),
  'the collapsed post can be shown again from the bar left in its place',
);

// One-click verdicts on the post itself.
const quickButton = (cellId, verdict) => feed.locator(`#${cellId} [data-anyfilter-host="label"] button.quick.${verdict}`);
const recordFor = async (needle) => (await reviewRecords()).find((r) => r.stateJson.includes(needle));
const targetPx = await quickButton('cell-keep', 'keep').boundingBox();
check(targetPx.height >= 24 && (await labelButton.boundingBox()).height >= 24, `the label and the quick buttons are at least 24px tall (${Math.round(targetPx.height)}px)`);
check(
  (await quickButton('cell-keep', 'keep').getAttribute('data-agree')) === 'true' && (await quickButton('cell-keep', 'hide').getAttribute('data-agree')) === 'false',
  'the button that agrees with the model is drawn stronger',
);
await quickButton('cell-keep', 'keep').click();
check(
  await waitFor(async () => (await recordFor('Next.js 16.2'))?.overall === 'keep', 'quick keep'),
  'one click on Should keep stores the verdict',
);
check((await quickButton('cell-keep', 'keep').getAttribute('aria-pressed')) === 'true', 'and the button shows it is pressed');
check(await feed.locator('[data-anyfilter-host="panel"]').count() === 0, 'without opening a panel');
await quickButton('cell-keep', 'keep').click();
check(
  await waitFor(async () => (await recordFor('Next.js 16.2')) === undefined, 'quick keep undone'),
  'clicking the pressed verdict again takes the label back',
);
await quickButton('cell-keep', 'hide').click();
check(await reviewPanelRoot.isVisible(), 'Should hide on a post the model did not flag opens the panel to pick a rule');
check(
  (await reviewPanelRoot.getByRole('button', { name: 'Should hide' }).getAttribute('aria-pressed')) === 'true' && (await recordFor('Next.js 16.2')) === undefined,
  'with hide already chosen and nothing stored yet',
);
await reviewPanelRoot.locator('label.rule', { hasText: 'Spam' }).locator('input').check();
check(
  await waitFor(async () => (await recordFor('Next.js 16.2'))?.overall === 'hide', 'rule click stored'),
  'one rule click stores it, so two clicks in total',
);
check((await recordFor('Next.js 16.2')).rules.map((r) => r.ruleId).join() === 'spam', 'with exactly the clicked rule');
await reviewPanelRoot.getByRole('button', { name: 'Undo label' }).click();
check(await waitFor(async () => (await recordFor('Next.js 16.2')) === undefined, 'undone'), 'the label can be undone from the panel');
if ((await feed.locator('#cell-bait article').getAttribute('data-anyfilter-review')) === 'flagged') {
  await quickButton('cell-bait', 'hide').click();
  check(
    await waitFor(async () => (await recordFor('connect with people'))?.overall === 'hide', 'quick hide'),
    'one click on Should hide on a flagged post stores the rules the model hit',
  );
  check((await recordFor('connect with people')).rules.length >= 1, 'and it has at least one rule');
  await quickButton('cell-bait', 'hide').click();
  check(await waitFor(async () => (await recordFor('connect with people')) === undefined, 'quick hide undone'), 'and a second click undoes it');
}
check((await reviewRecords()).length === 1, 'the quick clicks left only the first label behind');
await feed.keyboard.press('Escape');

// A reload keeps review mode on, and finds the labels again.
await feed.reload();
check(
  await waitFor(async () => (await reviewToolbarCount()) === 1 && !(await cellHidden('cell-hate')), 'review after reload'),
  'review mode is still on after a reload, and the post is still shown',
);
check(
  await waitFor(
    () => feed.evaluate(() => (document.querySelector('#cell-hate [data-anyfilter-host="label"]')?.shadowRoot?.querySelector('.chips')?.textContent ?? '').includes('Labeled')),
    'label found after reload',
  ),
  'stored labels are matched to the same post again after a reload',
);
check(
  await feed.evaluate(() => document.querySelector('#cell-hate article').hasAttribute('data-anyfilter-valuable')) &&
    await feed.evaluate(() => !document.querySelector('#cell-ad article').hasAttribute('data-anyfilter-valuable')),
  'only the labelled post carries the gold outline',
);

// A DOM node reused for other text must not carry the old label along.
await feed.evaluate(() => {
  document.querySelector('#cell-hate [data-testid="tweetText"]').textContent = 'a completely different body of text';
});
check(
  await waitFor(
    () => feed.evaluate(() => !(document.querySelector('#cell-hate [data-anyfilter-host="label"]')?.shadowRoot?.querySelector('.chips')?.textContent ?? '').includes('Labeled')),
    'label dropped for new text',
  ),
  'an edited or reused post does not inherit the old label',
);
await feed.reload();
await setReviewMode(true);
await waitFor(() => labelButton.count().then((count) => count === 1), 'label again');

// Undo, then remove the flag.
await labelButton.click();
await reviewPanelRoot.getByRole('button', { name: 'Undo label' }).click();
check(
  await waitFor(async () => { const r = await reviewRecords(); return r.length === 1 && r[0].overall === null && r[0].valuable === true; }, 'undo'),
  'undoing the label keeps the worth-reading flag',
);
await reviewPanelRoot.getByRole('button', { name: 'Not worth reading' }).click();
check(await waitFor(async () => (await reviewRecords()).length === 0, 'removed'), 'removing the flag from an unlabelled post deletes the record');

// "No existing rule covers it" needs a sentence.
await reviewPanelRoot.getByRole('button', { name: 'Should hide' }).click();
await reviewPanelRoot.getByLabel('No existing rule covers it').check();
await reviewPanelRoot.getByRole('button', { name: 'Save label' }).click();
check((await reviewPanelRoot.getByText('Write one sentence', { exact: false }).count()) === 1, 'the reason is required');
await reviewPanelRoot.getByLabel('Why, in one sentence').fill('Coordinated harassment, no rule for it');
await reviewPanelRoot.getByRole('button', { name: 'Save label' }).click();
check(
  await waitFor(async () => { const r = await reviewRecords(); return r.length === 1 && r[0].noRuleCovers === 'Coordinated harassment, no rule for it' && r[0].rules.length === 0; }, 'noRule stored'),
  'a hide verdict with no covering rule stores the reason and no rule',
);
await reviewPanelRoot.press('Escape');
check(await waitFor(async () => (await reviewPanelRoot.count()) === 0, 'panel closed'), 'Escape closes the panel');

// Deleting everything from the side panel empties the store and the page.
await panel.locator('[data-anyfilter-nav="verification"]').click();
check(
  await waitFor(async () => ((await panel.locator('[data-anyfilter-review="count"]').textContent()) ?? '').includes('1 labels'), 'count shown'),
  'the verification view counts the stored review labels',
);
await panel.locator('[data-anyfilter-review="delete-all"]').click();
check(await waitFor(async () => (await reviewRecords()).length === 0, 'all deleted'), 'one button deletes every review label');
check(
  await waitFor(
    () => feed.evaluate(() => !(document.querySelector('#cell-hate [data-anyfilter-host="label"]')?.shadowRoot?.querySelector('.chips')?.textContent ?? '').includes('Labeled')),
    'page refreshed',
  ),
  'the open page drops the deleted labels',
);
await panel.locator('[data-anyfilter-nav="home"]').click();
check(jevCalls.length - callsBeforeLabelling <= 6, 'labelling asks Jev for nothing beyond re-reading posts after reloads');
await setReviewMode(false);

// ---------------------------------------------------------------------------
// Toolbar: scope filter, rule filter, score slider, pause and keyboard use. All
// of it is display only.
const toolbarRoot = feed.locator('[data-anyfilter-host="toolbar"]');
const visibleReviewed = () =>
  feed.evaluate(() =>
    [...document.querySelectorAll('article[data-anyfilter-review]')]
      .filter((article) => article.getClientRects().length > 0)
      .map((article) => article.closest('[data-testid="cellInnerDiv"]').id)
      .sort(),
  );
const loadedReviewed = () => feed.evaluate(() => document.querySelectorAll('article[data-anyfilter-review]').length);
const countsText = async () => (await toolbarRoot.locator('.counts').textContent())?.trim() ?? '';
const setSlider = (percent) =>
  toolbarRoot.locator('input[type="range"]').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, percent);
const callsBeforeToolbar = jevCalls.length;
const settingsBeforeToolbar = await storedSettings();

await setReviewMode(true);
check(await waitFor(async () => (await toolbarRoot.count()) === 1 && (await loadedReviewed()) >= 5, 'toolbar and decorations'), 'the toolbar appears with review mode');
const loaded = await loadedReviewed();
check((await countsText()).startsWith(`${loaded} loaded · 0 filtered out`), `the toolbar counts the loaded posts (${await countsText()})`);

check(await toolbarRoot.locator('select').first().isHidden(), 'the filters start folded, so the bar is one short line');
await toolbarRoot.getByRole('button', { name: 'Filters' }).click();
check(await toolbarRoot.locator('select').first().isVisible(), 'the Filters button opens the scope, rule and score controls');

// The bar can be dragged by its head, stays inside the window, and its buttons still work.
const barBox = () => feed.evaluate(() => {
  const r = document.querySelector('[data-anyfilter-host="toolbar"]').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, vw: document.documentElement.clientWidth, vh: window.innerHeight };
});
const headBox = await toolbarRoot.locator('.head').boundingBox();
const beforeDrag = await barBox();
await feed.mouse.move(headBox.x + 8, headBox.y + headBox.height / 2);
await feed.mouse.down();
await feed.mouse.move(headBox.x + 8 - 240, headBox.y + headBox.height / 2 - 200, { steps: 6 });
await feed.mouse.up();
const afterDrag = await barBox();
check(
  Math.abs(afterDrag.x - (beforeDrag.x - 240)) <= 2 && Math.abs(afterDrag.y - (beforeDrag.y - 200)) <= 2,
  `dragging the head moves the bar (${Math.round(afterDrag.x - beforeDrag.x)}, ${Math.round(afterDrag.y - beforeDrag.y)})`,
);
await feed.mouse.move(afterDrag.x + 8, afterDrag.y + 12);
await feed.mouse.down();
await feed.mouse.move(-500, -500, { steps: 4 });
await feed.mouse.up();
const clamped = await barBox();
check(clamped.x >= 0 && clamped.y >= 0, 'the bar cannot be dragged out of the window');
await toolbarRoot.locator('.head').focus();
await feed.keyboard.press('ArrowRight');
check((await barBox()).x === clamped.x + 16, 'arrow keys nudge the bar');
await toolbarRoot.locator('.head').dblclick({ position: { x: 6, y: 6 } });
const reset = await barBox();
check(Math.abs(reset.x - beforeDrag.x) <= 2 && Math.abs(reset.y - beforeDrag.y) <= 2, 'double clicking the head puts the bar back');

await toolbarRoot.locator('select').first().selectOption('flagged');
const flaggedIds = await feed.evaluate(() =>
  [...document.querySelectorAll('article[data-anyfilter-review="flagged"]')].map((article) => article.closest('[data-testid="cellInnerDiv"]').id).sort(),
);
check(
  await waitFor(async () => JSON.stringify(await visibleReviewed()) === JSON.stringify(flaggedIds), 'flagged only'),
  'the "would hide" scope keeps exactly the would-hide posts on screen',
);
check(
  (await countsText()).includes(`${loaded - flaggedIds.length} filtered out`),
  'the filtered-out count matches what left the screen',
);
check(flaggedIds.length >= 2 && flaggedIds.length < loaded, 'the scope actually narrowed the page');

await toolbarRoot.locator('select').first().selectOption('all');
const rulePicker = toolbarRoot.locator('select').nth(1);
check(await toolbarRoot.locator('input[type="range"]').isDisabled(), 'the slider is off until a scored rule is chosen');
await rulePicker.selectOption({ label: 'Hate & insults' });
check(await waitFor(async () => !(await toolbarRoot.locator('input[type="range"]').isDisabled()), 'slider on'), 'choosing a scored rule turns the slider on');
await setSlider(95);
check(
  await waitFor(async () => JSON.stringify(await visibleReviewed()) === JSON.stringify(['cell-hate']), 'slider 95'),
  'a score of at least 95% for the rule keeps only the post that reaches it',
);
check((await toolbarRoot.getByText('Score at least 95%').count()) === 1, 'the slider shows its value');
await setSlider(99);
check(await waitFor(async () => (await visibleReviewed()).length === 0, 'slider 99'), 'a stricter slider filters everything out');
check((await countsText()).includes(`${loaded} filtered out`), 'the count follows the slider');
await toolbarRoot.getByRole('button', { name: 'Show all' }).click();
check(await waitFor(async () => (await visibleReviewed()).length === loaded, 'show all'), '"Show all" brings every post back');
check(await toolbarRoot.locator('input[type="range"]').isDisabled(), 'and resets the slider');

await rulePicker.selectOption({ label: 'Ads' });
check(await toolbarRoot.locator('input[type="range"]').isDisabled(), 'the local ad rule has no score, so the slider stays off');
check(
  await waitFor(async () => JSON.stringify(await visibleReviewed()) === JSON.stringify(['cell-ad']), 'ads only'),
  'choosing the ad rule keeps the promoted post',
);
await toolbarRoot.getByRole('button', { name: 'Show all' }).click();

// Pause shows the plain feed; resume restores the decorations.
await toolbarRoot.locator('select').first().selectOption('flagged');
await toolbarRoot.getByRole('button', { name: 'Pause' }).click();
check(
  await waitFor(async () => (await visibleReviewed()).length === loaded, 'paused all visible'),
  'pausing shows every post again',
);
check(
  await feed.evaluate(() => getComputedStyle(document.querySelector('#cell-hate article')).outlineStyle === 'none'),
  'pausing removes the outlines',
);
check(await feed.locator('[data-anyfilter-host="label"]').first().isHidden(), 'and the labels');
await toolbarRoot.getByRole('button', { name: 'Resume' }).click();
check(await waitFor(async () => (await visibleReviewed()).length === flaggedIds.length, 'resumed'), 'resuming brings the filter and outlines back');
await toolbarRoot.getByRole('button', { name: 'Show all' }).click();

// The filters fold away and back.
await toolbarRoot.getByRole('button', { name: 'Filters' }).click();
check(await toolbarRoot.locator('select').first().isHidden(), 'the filters can be folded away again');
await toolbarRoot.getByRole('button', { name: 'Filters' }).click();
check(await toolbarRoot.locator('select').first().isVisible(), 'and opened again');

// Non-current posts are quiet; hover or focus shows the full outline.
check(
  await feed.evaluate(() => getComputedStyle(document.querySelector('#cell-keep article')).outlineWidth === '1px'),
  'a post that is not under the pointer keeps a quiet outline',
);
await feed.locator('#cell-keep article').hover();
check(
  await waitFor(() => feed.evaluate(() => getComputedStyle(document.querySelector('#cell-keep article')).outlineWidth === '2px'), 'hover'),
  'the full outline appears on hover',
);
check(
  await feed.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches === false) &&
    (await feed.evaluate(() => document.getElementById('anyfilter-review-style').textContent.includes('prefers-reduced-motion'))),
  'animation is only declared for people who have not asked for reduced motion',
);

check(jevCalls.length === callsBeforeToolbar, 'filtering and dragging the slider ask Jev for nothing');
check((await storedSettings()) === settingsBeforeToolbar, 'the slider never touches the stored threshold or any setting');

// Keyboard only: focus the label, open, choose (stored at once), close, and exit.
const hateLabel = feed.locator('#cell-hate [data-anyfilter-host="label"] button.label');
await hateLabel.focus();
await feed.keyboard.press('Enter');
check(await reviewPanelRoot.isVisible(), 'Enter on the focused label opens the panel');
check(
  await feed.evaluate(() => document.activeElement?.getAttribute('data-anyfilter-host') === 'panel'),
  'focus moves into the panel',
);
await reviewPanelRoot.getByRole('button', { name: 'Should keep' }).focus();
await feed.keyboard.press('Space');
check(
  await waitFor(async () => { const r = await reviewRecords(); return r.length === 1 && r[0].overall === 'keep' && r[0].rules.length === 0; }, 'keyboard label'),
  'a label can be saved with the keyboard alone, and a plain keep tags no rule',
);
await feed.keyboard.press('Escape');
check(
  await waitFor(() => feed.evaluate(() => document.activeElement?.getAttribute('data-anyfilter-host') === 'label'), 'focus back'),
  'Escape closes the panel and returns focus to the label',
);
// X drops posts far off screen from the page. The labelled total must not fall.
const labeledTotal = async () => Number(/(\d+) labeled in total/.exec(await countsText())?.[1] ?? -1);
check(await waitFor(async () => (await labeledTotal()) === 1, 'labeled total'), `the toolbar counts the stored label (${await countsText()})`);
const loadedNow = Number(/^(\d+) loaded/.exec(await countsText())?.[1]);
await feed.evaluate(() => {
  const cell = document.querySelector('#cell-hate');
  window.__afCell = { cell, parent: cell.parentNode, next: cell.nextSibling };
  cell.remove();
});
await toolbarRoot.locator('select').first().selectOption('kept');
check(
  await waitFor(async () => (await countsText()).startsWith(`${loadedNow - 1} loaded`), 'post left the page'),
  'a post leaving the page lowers the loaded count',
);
check((await labeledTotal()) === 1, 'but the labelled total stays');
await feed.evaluate(() => {
  const { cell, parent, next } = window.__afCell;
  parent.insertBefore(cell, next);
});

await toolbarRoot.getByRole('button', { name: 'Exit' }).focus();
await feed.keyboard.press('Enter');
check(await waitFor(async () => (await toolbarRoot.count()) === 0 && (await cellHidden('cell-hate')), 'exited'), 'the toolbar Exit works from the keyboard and hides flagged posts again');
check(
  (await panel.locator('[data-anyfilter-review="toggle"]').getAttribute('aria-pressed')) === 'false',
  'Exit on the toolbar turns the global switch off, not just this page',
);
await panel.locator('[data-anyfilter-nav="verification"]').click();
await panel.locator('[data-anyfilter-review="delete-all"]').click();
await panel.locator('[data-anyfilter-nav="home"]').click();

const callsBeforeConversation = jevCalls.length;
await feed.goto('https://x.com/yann_shi_/status/2001');
check(await waitFor(() => cellHidden('cell-porn-bot'), 'porn bot reply hidden'), 'porn-bot reply is hidden on a conversation page');
check(!(await cellHidden('cell-focal')), 'the focal post stays visible');
check(!(await cellHidden('cell-own-reply')), "the logged-in user's own reply is never hidden");
check(!(await cellHidden('cell-real-reply')), 'a genuine reply stays visible');
const conversationCalls = jevCalls.slice(callsBeforeConversation);
check(conversationCalls.length === 2, `only the two other people's replies are sent to Jev (got ${conversationCalls.length})`);
check(
  conversationCalls.every((call) => call.state?.replyingTo?.text?.includes('Jev speed test') && call.state?.replyingTo?.author === '@yann_shi_'),
  'replies carry the parent post as replyingTo context',
);
check(
  !conversationCalls.some((call) => call.state?.text?.includes('yeah true')),
  'own reply is not classified at all',
);
check(
  await waitFor(async () => (await repliesSection.getByText('Porn bots').count()) > 0, 'replies group'),
  'Replies section shows the Porn bots group',
);
await repliesSection.getByRole('button', { name: /Porn bots/ }).click();
check(
  await waitFor(async () => (await repliesSection.getByText('Jev speed test: 428 posts').count()) === 1, 'parent line'),
  'reply group names the post it was under',
);
check((await repliesSection.locator('img[src*="profile_images/karen"]').count()) === 2, 'avatar read from a background-image style (group header + row)');
const sectionCount = (section) => section.locator('h2 + span').first().textContent();
check(await waitFor(async () => (await sectionCount(postsSection))?.trim() === '5', 'posts count'), 'Posts section keeps its own count');
check((await sectionCount(repliesSection))?.trim() === '1', 'Replies section shows its own count');

await feed.goto('https://x.com/notifications');
await new Promise((resolve) => setTimeout(resolve, 800));
check(jevCalls.length === callsBeforeConversation + 2, 'nothing is scanned on pages other than home and conversations');

await feed.goto('https://x.com/home');
const adRule = options.locator('[data-rule-choice="ads"]');
check((await adRule.count()) === 1, 'the local ads rule is visible in Settings');
await options.getByRole('searchbox', { name: 'Search rules' }).fill('Politics');
check((await options.getByRole('list', { name: 'Rules' }).getByRole('listitem').count()) === 1, 'rule search narrows the list');
await options.locator('[data-rule-choice="politics"]').click();
check((await options.locator('[data-anyfilter-rule="politics"]').getByRole('textbox', { name: 'Hide when' }).count()) === 1, 'selecting a rule opens its editor');
await options.getByRole('searchbox', { name: 'Search rules' }).fill('');
await adRule.click();
check((await options.locator('[data-anyfilter-rule="ads"]').getByRole('textbox', { name: 'Hide when' }).count()) === 0, 'the local ad detector is not a model prompt editor');
await options.getByRole('button', { name: 'New rule' }).click();
const customRule = options.locator('[data-anyfilter-rule^="custom:"]');
check((await customRule.count()) === 1, 'a custom rule can be created');
await customRule.getByRole('textbox', { name: 'Hide when' }).fill('A temporary draft that should be discarded');
await options.getByRole('button', { name: 'Cancel' }).click();
check((await customRule.count()) === 0, 'cancel discards a new unsaved rule');
await options.getByRole('button', { name: 'New rule' }).click();
await customRule.getByRole('textbox', { name: 'Rule name' }).fill('Next.js benchmark posts');
await customRule.getByRole('textbox', { name: 'Hide when' }).fill('Hide posts about Next.js benchmarks.');
await options.getByRole('button', { name: 'Save and apply' }).click();
check(
  await waitFor(() => cellHidden('cell-keep'), 'custom rule hides matching post'),
  'saved custom rule hides a matching post through mock Jev',
);
await options.getByRole('textbox', { name: 'Text to test' }).fill('Next.js benchmarks improved today');
await options.getByRole('button', { name: 'Test text' }).click();
check(
  await waitFor(async () => (await options.getByText('Next.js benchmark posts').count()) === 1, 'preview custom result'),
  'text preview includes the custom rule',
);
check(
  await waitFor(async () => (await options.getByText('would hide', { exact: true }).count()) >= 1, 'preview matched score'),
  'text preview shows a matching score against the threshold',
);

await options.screenshot({ path: path.join(ROOT, 'tmp', 'settings.png'), fullPage: true });
await panel.setViewportSize({ width: 360, height: 900 });
await panel.screenshot({ path: path.join(ROOT, 'tmp', 'sidepanel.png'), fullPage: true });
await feed.screenshot({ path: path.join(ROOT, 'tmp', 'feed.png'), fullPage: true });

// ---------------------------------------------------------------------------
// Phase 2 capture slice, end to end against the fixture page (no real X, no
// model call): off by default, opt-in, read-only, local and deletable.
const SAMPLES_KEY = 'anyfilter.capture.samples';
const CAPTURE_STATE_KEY = 'anyfilter.capture.state';

const readCapture = () =>
  options.evaluate(
    async (keys) => {
      const stored = await chrome.storage.local.get(keys);
      return { state: stored[keys[1]], samples: stored[keys[0]] };
    },
    [SAMPLES_KEY, CAPTURE_STATE_KEY],
  );

const captureSection = options.locator('[data-anyfilter-capture="section"]');
const beforeCapture = await readCapture();
check(
  beforeCapture.state === undefined && beforeCapture.samples === undefined,
  'capture stores nothing before the user switches it on',
);

const callsBeforeCapture = jevCalls.length;
await captureSection.getByRole('button', { name: 'Start capturing' }).click();
check(
  await waitFor(async () => ((await readCapture()).samples?.length ?? 0) >= 5, 'capture samples'),
  'starting capture stores the public posts the page had already loaded',
);
check(
  jevCalls.length === callsBeforeCapture,
  `capture itself calls no model (got ${jevCalls.length - callsBeforeCapture} extra calls)`,
);
check(
  await waitFor(() => cellHidden('cell-hate'), 'hate still hidden'),
  'the filter still hides a flagged post while capture is on',
);

const capturedState = await readCapture();
check(capturedState.state?.runState === 'active', 'the run state reports active');
check(
  capturedState.state?.stored === capturedState.samples.length,
  'the reported count matches the stored samples',
);
check(
  capturedState.samples.every(
    (sample) =>
      typeof sample.stateJson === 'string' &&
      sample.stateJson.includes('"text":"') &&
      sample.excerpt !== '' &&
      sample.pageUrl.startsWith('https://x.com/'),
  ),
  'every sample carries the exact input text, an excerpt and an X-only source',
);
check(
  capturedState.samples.some((sample) => sample.promoted === true),
  'a promoted post is stored and flagged instead of being treated as an ad to drop',
);
check(
  capturedState.samples.some((sample) => sample.postId === '1002'),
  'a post the page really rendered is captured by id',
);

const pausedCount = capturedState.samples.length;
await captureSection.getByRole('button', { name: 'Pause capturing' }).click();
check(
  await waitFor(async () => (await readCapture()).state?.runState === 'paused', 'capture paused'),
  'pausing is reported back to the UI',
);
await new Promise((resolve) => setTimeout(resolve, 700));
check(
  (await readCapture()).samples.length === pausedCount,
  'nothing is collected while paused',
);

await options.locator('[data-anyfilter-capture="clear"]').click();
check(
  await waitFor(async () => (await readCapture()).samples.length === 0, 'capture cleared'),
  'deleting samples empties the verification library',
);
const afterDelete = await options.evaluate(async () => {
  const local = await chrome.storage.local.get(null);
  const session = await chrome.storage.session.get(null);
  const settings = local['anyfilter.settings'] ?? {};
  return {
    key: settings.keys?.vercel ?? '',
    labels: Array.isArray(settings.rules) ? settings.rules.map((rule) => rule.label) : [],
    panel: typeof local['anyfilter.panel'] === 'object' && local['anyfilter.panel'] !== null,
    captureKeys: Object.keys(local).filter((key) => key.startsWith('anyfilter.capture')),
    sessionCapture: Object.keys(session).filter((key) => key.startsWith('anyfilter.capture')),
  };
});
check(afterDelete.key === FAKE_KEY, 'deleting samples keeps the provider key');
check(
  afterDelete.labels.length >= 10 && afterDelete.labels.includes('Next.js benchmark posts'),
  'deleting samples keeps every rule, including the custom one saved earlier',
);
check(afterDelete.panel, 'deleting samples keeps the production panel state');
check(afterDelete.captureKeys.length === 2, 'only the two capture keys exist after a delete');
check(afterDelete.sessionCapture.length === 0, 'no capture data is ever written to the score cache');

// ---------------------------------------------------------------------------
// Phase 3 manual single-sample verification, end to end against mocked TypeSafe
// (no real network, no real account): the entry point lives on the trusted side
// panel, sends nothing on its own, and one click makes exactly one request to the
// pinned endpoint for the one sample and the one rule a human picked.
const TS_KEY = 'ts_offline_fixture_key';

// Store the TypeSafe key the way the settings store would, without switching the
// production provider: switching it would invalidate the score cache and make the
// feed re-classify against the verification endpoint.
const keyState = await options.evaluate(async (key) => {
  const stored = await chrome.storage.local.get('anyfilter.settings');
  const settings = stored['anyfilter.settings'] ?? {};
  settings.keys = { ...(settings.keys ?? {}), typesafe: key };
  await chrome.storage.local.set({ 'anyfilter.settings': settings });
  const back = await chrome.storage.local.get('anyfilter.settings');
  const current = back['anyfilter.settings'] ?? {};
  return { typesafe: current.keys?.typesafe ?? '', provider: current.provider };
}, TS_KEY);
check(
  keyState.typesafe === TS_KEY && keyState.provider === 'vercel',
  'a TypeSafe key is stored without changing the production provider',
);

await panel.locator('[data-anyfilter-nav="verification"]').click();
const verification = panel.locator('[data-anyfilter-verification="section"]');
check(
  await waitFor(async () => (await verification.count()) === 1, 'verification section'),
  'verification navigation opens manual verification in the side panel',
);
check(await panel.locator('[data-anyfilter-capture="section"]').isVisible(), 'capture and verification share one view');

// The sampler deliberately never re-offers a post it already handled, even after
// a delete. Fresh page content is therefore added so there is something new to
// verify, exactly as a user scrolling the feed would produce.
await feed.evaluate(() => {
  const cell = document.querySelector('#cell-keep');
  for (let n = 0; n < 4; n += 1) {
    const clone = cell.cloneNode(true);
    clone.id = `cell-verify-${n}`;
    const article = clone.querySelector('article');
    article.removeAttribute('data-anyfilter');
    article.removeAttribute('data-anyfilter-id');
    clone.querySelector('[data-testid="tweetText"]').textContent =
      `manual verification candidate number ${n} about compilers ${'with enough padding to exceed the short preview window '.repeat(6)}`;
    clone.querySelector('a[href*="/status/"]').setAttribute('href', `/ada/status/${9100 + n}`);
    cell.parentElement.append(clone);
  }
});
await new Promise((resolve) => setTimeout(resolve, 600));
await options.getByRole('button', { name: /(Resume|Start) capturing/ }).click();
check(
  await waitFor(async () => ((await readCapture()).samples?.length ?? 0) >= 4, 'recaptured'),
  'newly loaded posts become verification candidates once capture is resumed',
);
await options.getByRole('button', { name: 'Pause capturing' }).click();
check(
  await waitFor(
    async () => (await verification.locator('[data-anyfilter-verification="sample"]').count()) >= 4,
    'verification candidates',
  ),
  'the panel lists the local samples as candidates',
);
const sampleSearch = verification.locator('[data-anyfilter-verification="search"]');
await sampleSearch.fill('manual verification candidate number 1');
check(await verification.locator('[data-anyfilter-verification="sample"]').count() === 1, 'search narrows only the visible sample list');
await sampleSearch.fill('');
check(await verification.locator('[data-anyfilter-verification="sample"]').count() >= 4, 'clearing search restores all samples');
check(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'verification fits a 360px side panel');
await panel.evaluate(() => window.scrollTo(0, 0));
await panel.screenshot({ path: path.join(ROOT, 'tmp', 'sidepanel-verification.png'), fullPage: true });
await panel.setViewportSize({ width: 1000, height: 800 });
check(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'verification fits a wide panel');
await panel.setViewportSize({ width: 360, height: 800 });
const disclosure = verification.locator('[data-anyfilter-verification="disclosure"]');
check(
  await waitFor(
    async () =>
      (await disclosure.getByText('TypeSafe Jev 1.13', { exact: false }).count()) === 1,
    'disclosure pinned model',
  ),
  'the disclosure names the pinned TypeSafe Jev 1.13 model before anything can be sent',
);
check(
  (await disclosure.getByText('cannot be recalled', { exact: false }).count()) === 1,
  'the disclosure says a real request may be charged and cannot be recalled',
);
check(
  (await disclosure.getByText('third-party content', { exact: false }).count()) === 1,
  'the disclosure warns that the sample may contain third-party content',
);
check(
  await verification.locator('[data-anyfilter-verification="run"]').isDisabled(),
  'nothing can be sent before the budget is switched on',
);

await verification.locator('[data-anyfilter-verification="enable"]').click();
check(
  await waitFor(
    async () =>
      (await verification.locator('[data-anyfilter-verification="status"]').textContent())?.includes(
        'Budget on for jev-1.13.0',
      ) ?? false,
    'budget enabled',
  ),
  'enabling the budget shows the pinned model',
);
check(typesafeCalls.length === 0, 'switching the budget on makes no request');

check(
  await verification.locator('[data-anyfilter-verification="confirm"]').isDisabled(),
  'the confirmation stays disabled before any sample is selected and previewed',
);
check(
  (await verification.locator('[data-anyfilter-verification="preview"]').count()) === 0,
  'no stored body is shown until a sample is selected',
);

await verification.locator('[data-anyfilter-verification="sample"]').first().check();
const storedForPreview = (await readCapture()).samples;
await waitFor(
  async () =>
    (await verification.locator('[data-anyfilter-verification="preview-text"]').count()) === 1,
  'exact preview text',
);
const previewText = (
  (await verification.locator('[data-anyfilter-verification="preview-text"]').textContent()) ?? ''
).trim();
check(
  previewText.length > 140,
  `selecting a sample shows more than the short excerpt (got ${previewText.length} chars)`,
);
check(
  storedForPreview.some((sample) => JSON.parse(sample.stateJson).text.trim() === previewText),
  'the preview is the exact stored body that would be sent, read back in full',
);
check(
  ((await verification.locator('[data-anyfilter-verification="preview-author"]').textContent()) ?? '')
    .includes('@'),
  'the preview names the post author as a handle',
);
check(
  (await verification.locator('[data-anyfilter-verification="preview-flag-exact-state"]').count()) === 1,
  'the preview states that this is the exact state a verification would send',
);
check(
  await verification.locator('[data-anyfilter-verification="confirm"]').isDisabled(),
  'the confirmation stays disabled until an enabled rule is also chosen',
);

await verification.locator('[data-anyfilter-verification="rule"]').selectOption('bait');
check(
  await verification.locator('[data-anyfilter-verification="run"]').isDisabled(),
  'the run button stays disabled until the user confirms this one sample may be sent',
);
await verification.locator('[data-anyfilter-verification="confirm"]').check();
check(
  await verification.locator('[data-anyfilter-verification="run"]').isEnabled(),
  'after confirming, exactly one run becomes possible',
);

const samplesBeforeRun = (await readCapture()).samples.length;
await verification.locator('[data-anyfilter-verification="run"]').click();
check(
  await waitFor(
    async () => (await verification.locator('[data-anyfilter-verification="result"]').count()) === 1,
    'verification result',
  ),
  'the outcome of the one call is shown in the panel',
);
check(
  typesafeCalls.length === 1,
  `clicking once makes exactly one TypeSafe request (got ${typesafeCalls.length})`,
);
const verificationCall = typesafeCalls.at(-1);
check(
  verificationCall?.model === 'jev-1.13.0' && verificationCall?.model !== 'jev-latest',
  'the verification request pins the versioned Jev 1.13 model',
);
check(
  Object.keys(verificationCall?.questions ?? {}).length === 1 &&
    !Object.keys(verificationCall?.questions ?? {}).includes('ads'),
  'exactly one enabled semantic rule is asked, and the local ad detector never becomes a question',
);
check(
  (await readCapture()).samples.length === samplesBeforeRun,
  'a verification neither adds nor removes a sample',
);
const verificationText = await verification.locator('[data-anyfilter-verification="result"]').textContent();
check(
  verificationText?.includes('not an accuracy rate') ?? false,
  'the shown score is labelled as the model’s judgement, not an accuracy rate',
);
check(
  (await verification.locator('[data-anyfilter-verification="enable"]').isDisabled()),
  'the budget switch cannot be pressed twice while it is on',
);

// The explicit stop: our own page may switch the budget off, and stopping is
// local only. A request that was already sent may still be charged, so an
// unknown reservation stays held rather than being refunded.
const callsBeforeStop = typesafeCalls.length;
check(
  await verification.locator('[data-anyfilter-verification="disable"]').isEnabled(),
  'the stop control is offered while the budget is on',
);
await verification.locator('[data-anyfilter-verification="disable"]').click();
check(
  await waitFor(
    async () =>
      (await verification.locator('[data-anyfilter-verification="status"]').textContent())?.includes(
        'Verification budget off',
      ) ?? false,
    'budget stopped',
  ),
  'stopping the budget is shown in the panel',
);
check(typesafeCalls.length === callsBeforeStop, 'stopping the budget makes no request');
check(
  await verification.locator('[data-anyfilter-verification="run"]').isDisabled(),
  'no new request can be sent once the budget is stopped',
);
check(
  await verification.locator('[data-anyfilter-verification="disable"]').isDisabled(),
  'the stop control cannot be pressed twice',
);
check(
  await verification.locator('[data-anyfilter-verification="enable"]').isEnabled(),
  'the budget can be switched back on after a stop',
);

// ---------------------------------------------------------------------------
// Real evaluation: budget for three isolated labellers, keys that can be set but
// never read, batch runs with progress, and an export a person saves by hand.
const evaluation = panel.locator('[data-anyfilter-evaluation="section"]');
const OPENAI_KEY = 'sk-e2e-openai-secret';
const DEEPSEEK_KEY = 'sk-e2e-deepseek-secret';
const evaluationState = () =>
  worker.evaluate(async () => (await chrome.storage.local.get('anyfilter.evaluation.jobs'))['anyfilter.evaluation.jobs'] ?? null);
check(
  await waitFor(async () => (await evaluation.locator('[data-anyfilter-evaluation="size"]').count()) === 1, 'evaluation section'),
  'the verification view offers the real-evaluation section',
);
check(
  ((await evaluation.locator('[data-anyfilter-evaluation="size"]').textContent()) ?? '').includes('stored samples'),
  'it states how many requests one model would need',
);
check(await evaluation.locator('[data-anyfilter-evaluation="run-jev"] [data-anyfilter-evaluation="start"]').isDisabled(), 'no run can start before the budget is on');
check(
  ((await evaluation.locator('[data-anyfilter-evaluation="budget-state"]').textContent()) ?? '').includes('budget is off'),
  'the section says the budget is off',
);
const callsBeforeEvaluation = { feed: jevCalls.length, typesafe: typesafeCalls.length };

await evaluation.locator('[data-anyfilter-evaluation="budget-on"]').click();
check(
  await waitFor(async () => ((await evaluation.locator('[data-anyfilter-evaluation="budget-state"]').textContent()) ?? '').includes('budget is on'), 'budget on'),
  'turning the budget on is shown',
);
const spendRows = await evaluation.locator('[data-anyfilter-evaluation="spend"] li').allTextContents();
check(
  spendRows.length === 4 &&
    spendRows[0].includes('TypeSafe Jev 1.13') &&
    spendRows[1].includes('OpenAI GPT-6 Luna') &&
    spendRows[2].includes('OpenAI GPT-6 Sol') &&
    spendRows[3].includes('DeepSeek Flash') &&
    spendRows.every((row) => row.includes('USD 1.000000')),
  'each labeller has its own price row and USD 1 cap',
);
const budgetRows = await evaluationState();
check(
  budgetRows.prices.map((row) => row.model).join() === 'jev-1.13.0,gpt-6-luna,gpt-6-sol,deepseek-flash' &&
    budgetRows.limits.every((limit) => limit.currency === 'USD' && limit.capMicro === 1_000_000),
  'the stored budget carries one isolated row per model',
);
check(typesafeCalls.length === callsBeforeEvaluation.typesafe, 'turning the budget on makes no request');

// Keys: set through the background, never shown again.
check(
  await evaluation.locator('[data-anyfilter-evaluation="run-openai"] [data-anyfilter-evaluation="start"]').isDisabled(),
  'a model without a key cannot be run',
);
const openaiKey = evaluation.locator('[data-anyfilter-evaluation="key-openai"]');
await openaiKey.locator('input').fill(OPENAI_KEY);
await openaiKey.getByRole('button', { name: 'Save' }).click();
check(
  await waitFor(async () => ((await openaiKey.locator('[data-anyfilter-evaluation="key-state"]').textContent()) ?? '').includes('Stored'), 'openai key stored'),
  'a stored key is reported as set',
);
await evaluation.locator('[data-anyfilter-evaluation="key-deepseek"] input').fill(DEEPSEEK_KEY);
await evaluation.locator('[data-anyfilter-evaluation="key-deepseek"]').getByRole('button', { name: 'Save' }).click();
await waitFor(async () => ((await evaluation.locator('[data-anyfilter-evaluation="key-deepseek"] [data-anyfilter-evaluation="key-state"]').textContent()) ?? '').includes('Stored'), 'deepseek key stored');
check((await openaiKey.locator('input').inputValue()) === '', 'the key field empties once the key is stored');
const panelHtml = await panel.content();
check(!panelHtml.includes(OPENAI_KEY) && !panelHtml.includes(DEEPSEEK_KEY), 'a stored key never appears in the panel');
const settingsJson = await storedSettings();
check(!settingsJson.includes(OPENAI_KEY) && !settingsJson.includes(DEEPSEEK_KEY), 'the machine keys never enter the normal settings');
await openaiKey.locator('input').fill('two words');
await openaiKey.getByRole('button', { name: 'Save' }).click();
check(
  await waitFor(async () => (await openaiKey.getByRole('alert').count()) === 1, 'invalid key'),
  'something that is not a key is refused',
);
await openaiKey.locator('input').fill('');

// A run needs an explicit authorization tick.
const jevRun = evaluation.locator('[data-anyfilter-evaluation="run-jev"]');
check(await jevRun.locator('[data-anyfilter-evaluation="start"]').isDisabled(), 'a run stays disabled until the person authorizes it');
await jevRun.getByRole('checkbox').check();
await jevRun.locator('[data-anyfilter-evaluation="start"]').click();
check(
  await waitFor(
    async () => ((await jevRun.locator('[data-anyfilter-evaluation="progress"]').textContent()) ?? '').includes('Finished.'),
    'jev batch finished',
    60_000,
  ),
  'the Jev batch reports that it finished',
);
const jevProgress = (await jevRun.locator('[data-anyfilter-evaluation="progress"]').textContent()) ?? '';
const semanticRuleCount = Number(((await evaluation.locator('[data-anyfilter-evaluation="size"]').textContent()) ?? '').match(/(\d+) enabled semantic/)?.[1] ?? 0);
const evaluationSamples = (await readCapture()).samples.length;
const jevAnswered = Number(jevProgress.match(/(\d+) answered/)?.[1] ?? -1);
const jevSkipped = Number(jevProgress.match(/(\d+) skipped/)?.[1] ?? -1);
// The one manual verification made earlier already settled a task; the batch finds
// its answer stored and does not pay for it again.
const jevRepeats = Number(jevProgress.match(/(\d+) already had an answer/)?.[1] ?? -1);
check(
  typesafeCalls.length - callsBeforeEvaluation.typesafe === jevAnswered &&
    jevRepeats === 1 &&
    jevAnswered + jevRepeats + jevSkipped === evaluationSamples * semanticRuleCount &&
    jevAnswered > 0,
  `the Jev batch requests each sample and rule once, except the one already answered (${jevAnswered} answered, ${jevRepeats} repeat, ${jevSkipped} skipped of ${evaluationSamples} x ${semanticRuleCount})`,
);
check(typesafeCalls.slice(callsBeforeEvaluation.typesafe).every((call) => call.model === 'jev-1.13.0'), 'every Jev request pins the versioned model');
check(jevCalls.length === callsBeforeEvaluation.feed, 'an evaluation run never touches the feed gateway');

// The OpenAI labeller is pointed at a relay and its dearer model from the panel.
const openaiConnection = evaluation.locator('[data-anyfilter-evaluation="connection-openai"]');
check(
  (await openaiConnection.locator('[data-anyfilter-evaluation="connection-url"]').inputValue()) === 'https://api.openai.com/v1',
  'the OpenAI connection starts at the provider default',
);
await openaiConnection.locator('[data-anyfilter-evaluation="connection-url"]').fill('http://relay.example/v1');
await openaiConnection.locator('[data-anyfilter-evaluation="connection-save"]').click();
check(
  await waitFor(async () => (await openaiConnection.getByRole('alert').count()) === 1, 'connection refused'),
  'a plain http base URL is refused',
);
await openaiConnection.locator('[data-anyfilter-evaluation="connection-url"]').fill('https://relay.example/v1/');
await openaiConnection.locator('[data-anyfilter-evaluation="connection-model"]').selectOption('gpt-6-sol');
await openaiConnection.locator('[data-anyfilter-evaluation="connection-save"]').click();
check(
  await waitFor(async () => (await openaiConnection.locator('[data-anyfilter-evaluation="connection-url"]').inputValue()) === 'https://relay.example/v1', 'connection saved'),
  'the saved base URL is shown without its trailing slash',
);
check(
  ((await evaluation.locator('[data-anyfilter-evaluation="run-openai"]').textContent()) ?? '').includes('OpenAI GPT-6 Sol'),
  'the run row names the model now in use',
);

const openaiRun = evaluation.locator('[data-anyfilter-evaluation="run-openai"]');
await openaiRun.getByRole('checkbox').check();
await openaiRun.locator('[data-anyfilter-evaluation="start"]').click();
check(
  await waitFor(async () => ((await openaiRun.locator('[data-anyfilter-evaluation="progress"]').textContent()) ?? '').includes('Finished.'), 'openai batch finished', 60_000),
  'the OpenAI batch finishes',
);
const deepseekRun = evaluation.locator('[data-anyfilter-evaluation="run-deepseek"]');
await deepseekRun.getByRole('checkbox').check();
await deepseekRun.locator('[data-anyfilter-evaluation="start"]').click();
check(
  await waitFor(async () => ((await deepseekRun.locator('[data-anyfilter-evaluation="progress"]').textContent()) ?? '').includes('Finished.'), 'deepseek batch finished', 60_000),
  'the DeepSeek batch finishes',
);
const machineTasks = jevAnswered + jevRepeats;
check(openaiCalls.length === machineTasks && deepseekCalls.length === machineTasks, `each machine labeller made one request per task (${openaiCalls.length}, ${deepseekCalls.length}, expected ${machineTasks})`);
check(openaiCalls.every((call) => call.authorization === `Bearer ${OPENAI_KEY}`), 'OpenAI requests carry only the OpenAI key');
check(deepseekCalls.every((call) => call.authorization === `Bearer ${DEEPSEEK_KEY}`), 'DeepSeek requests carry only the DeepSeek key');
check(
  openaiCalls.every((call) => call.url === 'https://relay.example/v1/chat/completions' && call.body.model === 'gpt-6-sol' && call.body.reasoning_effort === 'none' && call.body.max_completion_tokens === 256) &&
    deepseekCalls.every((call) => call.body.model === 'deepseek-flash' && call.body.thinking?.type === 'disabled' && call.body.max_tokens === 256),
  'both machine requests pin their model, switch reasoning off and cap output',
);
check(
  openaiCalls.every((call) => !JSON.stringify(call.body).includes('mock deepseek') && !JSON.stringify(call.body).includes('0.91')) &&
    deepseekCalls.every((call) => !JSON.stringify(call.body).includes('mock openai') && !JSON.stringify(call.body).includes('0.91')),
  'neither machine labeller was shown another labeller’s answer or score',
);
const afterRuns = await evaluationState();
check(
  ['jev-1.13.0', 'gpt-6-sol', 'deepseek-flash'].every((model) => (afterRuns.spentMicro[model] ?? 0) > 0) &&
    (afterRuns.spentMicro['gpt-6-luna'] ?? 0) === 0 &&
    afterRuns.spentMicro['gpt-6-sol'] === machineTasks * (Math.ceil((420 * 2_000_000) / 1e6) + Math.ceil((14 * 10_000_000) / 1e6)),
  'each model was billed to its own bucket at its own price',
);

// A repeat costs nothing: every task already has an answer.
const callsBeforeRepeat = openaiCalls.length;
await openaiRun.locator('[data-anyfilter-evaluation="start"]').click();
check(
  await waitFor(
    async () => ((await openaiRun.locator('[data-anyfilter-evaluation="progress"]').textContent()) ?? '').includes(`${machineTasks} already had an answer`),
    'repeat counted',
    60_000,
  ),
  'a repeated run finds every answer already stored',
);
check(openaiCalls.length === callsBeforeRepeat, 'and pays for none of them again');

// The export is one file saved by hand.
const [download] = await Promise.all([panel.waitForEvent('download'), evaluation.locator('[data-anyfilter-evaluation="export"]').click()]);
const exportPath = await download.path();
const exported = JSON.parse(readFileSync(exportPath, 'utf8'));
check(download.suggestedFilename().startsWith('anyfilter-evaluation-'), 'the export is a named JSON file');
check(
  exported.version === 1 && exported.containsPostText === true && exported.samples.length === evaluationSamples,
  'the export holds every stored sample and says it contains post text',
);
check(
  ['jev', 'openai', 'deepseek'].every((labeller) => exported.results.some((row) => row.labeller === labeller)) &&
    exported.results.filter((row) => row.labeller === 'openai').every((row) => row.verdict.status === 'labelled' && row.verdict.state === 'match'),
  'it holds the real answers of all three labellers, kept apart by labeller',
);
check(
  exported.results.filter((row) => row.labeller === 'jev').every((row) => row.verdict.status === 'decided' && row.verdict.score === 0.91),
  'Jev answers keep their score',
);
const exportText = JSON.stringify(exported);
check(!exportText.includes(OPENAI_KEY) && !exportText.includes(DEEPSEEK_KEY) && !exportText.includes(TS_KEY), 'the export holds no key');

// Stopping the budget refuses everything after it. The verification section read its
// status before the evaluation section turned the budget on, so open the page again.
await panel.reload();
await panel.locator('[data-anyfilter-nav="verification"]').click();
await verification.locator('[data-anyfilter-verification="disable"]').waitFor();
await waitFor(async () => await verification.locator('[data-anyfilter-verification="disable"]').isEnabled(), 'verification sees the budget on');
await verification.locator('[data-anyfilter-verification="disable"]').click();
await waitFor(async () => ((await verification.locator('[data-anyfilter-verification="status"]').textContent()) ?? '').includes('Verification budget off'), 'budget stopped for evaluation');
const callsBeforeOffRun = openaiCalls.length + deepseekCalls.length + typesafeCalls.length;
check(
  await waitFor(async () => ((await evaluation.locator('[data-anyfilter-evaluation="budget-state"]').textContent()) ?? '').includes('budget is off'), 'section sees budget off', 10_000),
  'the evaluation section notices that the budget was switched off',
);
check(await deepseekRun.locator('[data-anyfilter-evaluation="start"]').isDisabled(), 'and no run can be started');
check(openaiCalls.length + deepseekCalls.length + typesafeCalls.length === callsBeforeOffRun, 'nothing is sent once the budget is off');

// Deleting the library must also clear anything the panel was showing for the
// deleted samples: no preview and no verdict may outlive the record it describes.
await options.locator('[data-anyfilter-capture="clear"]').click();
check(
  await waitFor(async () => (await readCapture()).samples.length === 0, 'samples deleted at the end'),
  'the samples can still be deleted after a verification',
);
check(
  await waitFor(
    async () => (await verification.locator('[data-anyfilter-verification="result"]').count()) === 0,
    'result cleared after delete',
  ),
  'a shown verdict disappears once the sample it belongs to is deleted',
);
check(
  (await verification.locator('[data-anyfilter-verification="preview"]').count()) === 0,
  'the exact-text preview disappears once its sample is deleted',
);

// ---------------------------------------------------------------------------
// Phase 4 large library. 65 synthetic samples are written straight to the same
// two local keys the capture store owns (no page, no model, no network), so the
// bounded paging, the search box, the source filter, selection consistency and
// the 360px/wide layouts are all exercised at a realistic list size.
const BULK_COUNT = 65;
const BULK_PAGE_SIZE = 10;

const bulk = await options.evaluate(async (count) => {
  const pages = ['home', 'search', 'status'];
  const now = Date.now();
  const samples = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const page = pages[i % pages.length];
    const text = `Synthetic ${page} sample number ${n} about compilers`;
    const state = { author: { handle: `@synthetic${n}`, name: `Synthetic Author ${n}` }, text };
    if (i % 5 === 4) state.replyingTo = { author: '@synthetic-parent', text: `parent post ${n}` };
    if (i % 7 === 6) state.quoted = `quoted post ${n}`;
    return {
      sampleId: `9${String(n).padStart(3, '0')}.synthetic${n}`,
      postId: `9${String(n).padStart(3, '0')}`,
      threadId: `thread-${n}`,
      handle: `synthetic${n}`,
      page,
      pageUrl: `https://x.com/synthetic${n}/status/9${String(n).padStart(3, '0')}`,
      stateJson: JSON.stringify(state),
      inputHash: `synthetic-hash-${n}`,
      contentKey: `synthetic-content-${n}`,
      excerpt: text,
      truncated: false,
      promoted: i % 4 === 3,
      publishedAt: `${(i % 12) + 1}h`,
      capturedAt: now - (count - i) * 1000,
    };
  });
  const [samplesKey, stateKey] = ['anyfilter.capture.samples', 'anyfilter.capture.state'];
  const stored = await chrome.storage.local.get([samplesKey, stateKey]);
  const existing = Array.isArray(stored[samplesKey]) ? stored[samplesKey] : [];
  const state = stored[stateKey] ?? {};
  const next = [...existing, ...samples].slice(-300);
  await chrome.storage.local.set({
    [samplesKey]: next,
    [stateKey]: { ...state, stored: next.length, updatedAt: Date.now() },
  });
  const byPage = { home: 0, search: 0, status: 0 };
  for (const sample of samples) byPage[sample.page] += 1;
  return { total: next.length, byPage, pageCount: Math.max(1, Math.ceil(next.length / 10)) };
}, BULK_COUNT);

check(
  (await readCapture()).samples.length === bulk.total,
  `the synthetic library holds ${bulk.total} samples`,
);

// Narrow first, with no sample selected: the list, the pager, the search box and
// the source filter are the only panes on screen.
await panel.setViewportSize({ width: 360, height: 800 });
const sampleRows = () => verification.locator('[data-anyfilter-verification="sample"]');
const pageLabel = (page) => verification.getByText(`Page ${page} / ${bulk.pageCount}`, { exact: true });

check(
  await waitFor(async () => (await sampleRows().count()) === BULK_PAGE_SIZE, 'first bulk page'),
  `the large library renders only one bounded page of ${BULK_PAGE_SIZE} rows`,
);
check((await pageLabel(1).count()) === 1, 'the pager names the first page and the page count');
check(
  await verification.locator('[data-anyfilter-verification="previous-page"]').isDisabled(),
  'the first page cannot page backwards',
);
const firstPageIds = await sampleRows().evaluateAll((nodes) => nodes.map((node) => node.value));

await verification.locator('[data-anyfilter-verification="next-page"]').click();
check(await waitFor(async () => (await pageLabel(2).count()) === 1, 'second bulk page'), 'next moves to page two');
const secondPageIds = await sampleRows().evaluateAll((nodes) => nodes.map((node) => node.value));
check(
  secondPageIds.length === BULK_PAGE_SIZE && secondPageIds.every((id) => !firstPageIds.includes(id)),
  'page two shows a different, non-overlapping set of samples',
);
await verification.locator('[data-anyfilter-verification="previous-page"]').click();
check(await waitFor(async () => (await pageLabel(1).count()) === 1, 'back to first bulk page'), 'previous moves back to page one');
for (let page = 2; page <= bulk.pageCount; page += 1) {
  await verification.locator('[data-anyfilter-verification="next-page"]').click();
  await waitFor(async () => (await pageLabel(page).count()) === 1, `bulk page ${page}`);
}
check(
  await waitFor(
    async () => verification.locator('[data-anyfilter-verification="next-page"]').isDisabled(),
    'last bulk page',
  ),
  'the last page disables the next control',
);
check(
  (await sampleRows().count()) === bulk.total - (bulk.pageCount - 1) * BULK_PAGE_SIZE,
  'the last page holds only the remaining samples',
);

// The search box narrows the visible list only; the stored library is untouched.
await sampleSearch.fill('sample number 65');
check(
  await waitFor(async () => (await sampleRows().count()) === 1, 'bulk search'),
  'searching the large list narrows it to the one matching sample',
);
check(
  (await verification.getByText('Page 1 / 1', { exact: true }).count()) === 1,
  'a narrowed list reports a single page',
);
check((await readCapture()).samples.length === bulk.total, 'searching hides rows but never deletes a stored sample');
await sampleSearch.fill('');
check(
  await waitFor(async () => (await sampleRows().count()) === BULK_PAGE_SIZE, 'cleared bulk search'),
  'clearing the search restores the first full page',
);
check(await waitFor(async () => (await pageLabel(1).count()) === 1, 'search reset the page'), 'clearing the search starts the list back at page one');

// The source filter narrows by the captured surface and reports the subset.
const sourceFilter = verification.locator('[data-anyfilter-verification="source-filter"]');
await sourceFilter.selectOption('search');
check(
  await waitFor(
    async () => (await verification.getByText(`${bulk.byPage.search} / ${bulk.total}`, { exact: true }).count()) === 1,
    'source filter count',
  ),
  'the source filter reports how many samples came from only that surface',
);
check((await sampleRows().count()) === BULK_PAGE_SIZE, 'the filtered list is still one bounded page');
check((await readCapture()).samples.length === bulk.total, 'filtering by source never deletes a stored sample');
await sourceFilter.selectOption('all');
check(
  await waitFor(
    async () => (await verification.getByText(String(bulk.total), { exact: true }).count()) === 1,
    'source filter cleared',
  ),
  'clearing the source filter restores the whole library',
);

// Selection consistency across pages, checked on the wide layout where the list
// and the detail pane are both on screen.
await panel.setViewportSize({ width: 1000, height: 800 });
const selectedBulkId = firstPageIds[0];
await verification.locator(`[data-anyfilter-verification="sample"][value="${selectedBulkId}"]`).check();
check(
  await waitFor(
    async () => (await verification.locator('[data-anyfilter-verification="preview-text"]').count()) === 1,
    'bulk preview text',
  ),
  'selecting one bulk sample loads its exact stored text',
);
check(
  await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  'the large sample list and the detail pane fit a wide panel',
);
check(
  (await verification.locator('[data-anyfilter-verification="candidates"]').isVisible()) &&
    (await verification.locator('[data-anyfilter-verification="preview"]').isVisible()),
  'the wide panel shows the list and the selected sample side by side',
);
await verification.locator('[data-anyfilter-verification="next-page"]').click();
check(await waitFor(async () => (await pageLabel(2).count()) === 1, 'page two after selection'), 'paging away from a selected sample moves to page two');
check(
  (await verification.locator('[data-anyfilter-verification="preview-text"]').count()) === 1,
  'the selected sample keeps its exact text while its row is on another page',
);
await verification.locator('[data-anyfilter-verification="previous-page"]').click();
check(await waitFor(async () => (await pageLabel(1).count()) === 1, 'page one again'), 'paging back returns to the selected page');
check(
  await verification.locator(`[data-anyfilter-verification="sample"][value="${selectedBulkId}"]`).isChecked(),
  'the selected sample is still selected after moving pages',
);
check(
  (await verification.locator('[data-anyfilter-verification="preview-text"]').count()) === 1,
  'the selected sample keeps its exact text on screen after moving pages',
);

// Narrow layout with the same large library: the detail pane must be usable and
// the list must still fit once it is restored.
await panel.setViewportSize({ width: 360, height: 800 });
check(
  await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  'the selected sample and its detail pane fit a 360px panel',
);
check(
  (await verification.locator('[data-anyfilter-verification="preview"]').isVisible()) &&
    (await verification.locator('[data-anyfilter-verification="back-to-samples"]').isVisible()),
  'the narrow panel shows the detail with a way back to the list',
);
await verification.locator('[data-anyfilter-verification="back-to-samples"]').click();
check(
  await waitFor(
    async () => verification.locator('[data-anyfilter-verification="candidates"]').isVisible(),
    'back to bulk list',
  ),
  'the narrow panel can go back from the detail to the list',
);
check(
  await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  'the large list fits a 360px panel without horizontal overflow',
);
check(
  await verification.locator(`[data-anyfilter-verification="sample"][value="${selectedBulkId}"]`).isChecked(),
  'going back to the list keeps the same sample selected',
);

// Deleting the library while a sample is selected must not leave a stale
// selection, preview or pager behind.
await panel.locator('[data-anyfilter-capture="clear"]').click();
check(
  await waitFor(async () => (await readCapture()).samples.length === 0, 'bulk library deleted'),
  'deleting the large library empties it',
);
check(await waitFor(async () => (await sampleRows().count()) === 0, 'bulk rows gone'), 'no sample row survives the delete');
check(
  (await verification.locator('[data-anyfilter-verification="preview"]').count()) === 0 &&
    (await verification.locator('[data-anyfilter-verification="preview-text"]').count()) === 0,
  'the selection and its exact text are dropped with the deleted samples',
);
check(
  (await verification.locator('[data-anyfilter-verification="next-page"]').count()) === 0 &&
    (await verification.locator('[data-anyfilter-verification="previous-page"]').count()) === 0,
  'the pager disappears instead of showing a stale page',
);
check(
  (await verification.locator('[data-anyfilter-verification="empty-detail"]').count()) === 1,
  'the detail pane goes back to asking for a sample',
);

await context.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
