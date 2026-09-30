#!/usr/bin/env node
/**
 * Takes the README screenshots, in English and in 简体中文, from the built
 * extension. Run `pnpm build` first, then `pnpm docs:screenshots`.
 *
 * It is fully offline, like `pnpm e2e`: X is a fixture page and every provider is
 * a mock, so nothing is sent anywhere and no key is real. The fixture stands in
 * for a timeline, so the pictures show the extension's own interface only; the
 * hidden-post lists are left collapsed so no post text appears in them.
 *
 * Output: screenshots/<locale>/<name>.png
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const HOME_FIXTURE = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'x-home.html'), 'utf8');
const EXECUTABLE = process.env.ANYFILTER_CHROMIUM ?? chromium.executablePath();

if (!existsSync(EXTENSION_DIR)) {
  console.error(`${EXTENSION_DIR} does not exist; run "pnpm build" first`);
  process.exit(1);
}

const MOCK_SCORES = [
  { marker: 'Next.js', scores: { promo: 0.2 } },
  { marker: '#connect', scores: { bait: 0.86, platitude: 0.53 } },
  { marker: 'parasites', scores: { hate: 0.98, spam: 0.2 } },
  { marker: 'Splunk Token Meter', scores: { promo: 0.3 } },
  { marker: 'where the money actually goes', scores: { platitude: 0.8 } },
  { marker: 'order of magnitude', scores: {} },
  { marker: '福不黑', scores: { porn: 0.88, spam: 0.44 } },
];

/** What each locale needs that is not already in the interface: the words on the
 * buttons the script presses, the requirement typed into the rule assistant, and
 * the drafted rule the mocked assistant model answers with. */
const LOCALES = {
  en: {
    newRule: 'New rule',
    requirement: 'Posts that only exist to sell a course or a paid community',
    draft: {
      label: 'Course sellers',
      group: 'Marketing',
      include: 'Is this post mainly selling or promoting a paid course, bootcamp or paid community?',
      exclude: 'the post only shares free learning material',
      examplesYes: ['Join my 8-week bootcamp, 50% off until Friday', 'My course is live. Link in bio'],
      examplesNo: ['Here is a free guide to get started with Rust'],
      scope: 'all',
    },
  },
  'zh-CN': {
    newRule: '新建规则',
    requirement: '只是为了卖课程或付费社群的帖子',
    draft: {
      label: '卖课程',
      group: '营销推广',
      include: 'Is this post mainly selling or promoting a paid course, bootcamp or paid community?',
      exclude: '只是分享免费学习资料',
      examplesYes: ['我的 8 周训练营限时五折，周五截止', '课程上线了，链接在主页'],
      examplesNo: ['这是一份免费的 Rust 入门指南'],
      scope: 'all',
    },
  },
};

const PANEL_WIDTH = 400;
const OPTIONS_WIDTH = 1280;

async function waitFor(fn, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function capture(locale) {
  const spec = LOCALES[locale];
  const outDir = path.join(ROOT, 'screenshots', locale);
  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), 'anyfilter-shots-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('https://x.com/')) {
        await route.fulfill({ contentType: 'text/html', body: HOME_FIXTURE });
        return;
      }
      if (url.startsWith('https://ai-gateway.vercel.sh/')) {
        const body = JSON.parse(route.request().postData() ?? '{}');
        const text = body.state?.text ?? '';
        const scores = MOCK_SCORES.find((mock) => text.includes(mock.marker))?.scores ?? {};
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((id) => [id, { type: 'boolean', probability: scores[id] ?? 0.02 }]),
        );
        await route.fulfill({ json: { answers, usage: { inputTokens: 600, outputTokens: 100 } } });
        return;
      }
      if (url.startsWith('https://api.openai.com/')) {
        const body = JSON.parse(route.request().postData() ?? '{}');
        await route.fulfill({
          json: {
            model: `${body.model}-2026-08-01`,
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(spec.draft) } }],
            usage: { prompt_tokens: 500, completion_tokens: 160 },
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
    worker ??= await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extensionId = new URL(worker.url()).host;
    const base = `chrome-extension://${extensionId}`;

    // Seed the stored state through an extension page: the interface language, a
    // demo filtering key with review mode off (so posts are really hidden), and a
    // demo key for the rule assistant. None of these keys is real or leaves the browser.
    const options = await context.newPage();
    await options.setViewportSize({ width: OPTIONS_WIDTH, height: 1400 });
    await options.goto(`${base}/options.html`);
    await options.evaluate(
      async (chosen) => {
        await chrome.storage.local.set({
          'anyfilter.ui.locale': chosen,
          'anyfilter.settings': { filterOn: true, reviewMode: false, keys: { vercel: 'vck_demo_not_a_real_key', typesafe: '' } },
          'anyfilter.evaluation.keys': { openai: 'sk-demo-not-a-real-key', deepseek: '' },
        });
        await chrome.runtime.sendMessage({ type: 'capture-set-state', runState: 'active' });
      },
      locale,
    );
    await options.reload();

    // A timeline to filter: this hides posts, fills the counters and, with capture on,
    // stores a few samples for the Verify page.
    const feed = await context.newPage();
    await feed.setViewportSize({ width: 1280, height: 4000 });
    await feed.goto('https://x.com/home');
    await waitFor(
      () => feed.evaluate(() => document.querySelector('#cell-bait > div')?.classList.contains('anyfilter-hidden') ?? false),
      'posts hidden',
    );

    // Side panel: home, then Verify.
    const panel = await context.newPage();
    await panel.setViewportSize({ width: PANEL_WIDTH, height: 900 });
    await panel.goto(`${base}/sidepanel.html`);
    await panel.locator('[data-anyfilter-nav="home"]').waitFor();
    await waitFor(
      async () => ((await panel.locator('[data-anyfilter-section="post"]').count()) > 0),
      'hidden posts listed in the panel',
    );
    await new Promise((resolve) => setTimeout(resolve, 1200)); // let the counters finish counting up
    await panel.screenshot({ path: path.join(outDir, 'panel-home.png'), fullPage: true });

    await panel.locator('[data-anyfilter-nav="verification"]').click();
    await panel.locator('[data-anyfilter-verify="strip"]').waitFor();
    await waitFor(
      async () => Number((await panel.locator('[data-anyfilter-strip="samples"] div').last().textContent()) ?? '0') > 0,
      'samples captured',
    );
    await panel.screenshot({ path: path.join(outDir, 'panel-verify.png'), fullPage: true });

    // Settings page: the top of it, then the rules section in three states.
    await options.bringToFront();
    await options.locator('#anyfilter-key').waitFor();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await options.screenshot({ path: path.join(outDir, 'settings.png'), clip: { x: 0, y: 0, width: OPTIONS_WIDTH, height: 1180 } });

    const rules = options.locator('#rules');
    await options.locator('[data-rule-choice="crypto"]').click();
    await rules.screenshot({ path: path.join(outDir, 'rules.png') });

    await options.locator('[data-anyfilter-groups="toggle"]').click();
    await options.locator('[data-anyfilter-groups="manager"]').waitFor();
    await rules.screenshot({ path: path.join(outDir, 'categories.png') });
    await options.locator('[data-anyfilter-groups="toggle"]').click();

    await options.getByRole('button', { name: spec.newRule, exact: true }).click();
    const generator = options.locator('[data-anyfilter-generator="section"]');
    await generator.locator('[data-anyfilter-generator="requirement"]').fill(spec.requirement);
    await waitFor(async () => !(await generator.locator('[data-anyfilter-generator="generate"]').isDisabled()), 'generate enabled');
    await generator.locator('[data-anyfilter-generator="generate"]').click();
    await generator.locator('[data-anyfilter-generator="filled"]').waitFor();
    await rules.screenshot({ path: path.join(outDir, 'rule-assistant.png') });

    console.log(`${locale}: 6 screenshots written to ${path.relative(ROOT, outDir)}`);
  } finally {
    await context.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}

for (const locale of Object.keys(LOCALES)) {
  await capture(locale);
}
