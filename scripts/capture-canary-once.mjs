// One bounded, manual collection from an already-running Canary session.
// Never reads credentials, sends samples to a model, or writes to tracked paths.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ENDPOINT = 'http://127.0.0.1:9222';
const HOME = 'https://x.com/home';
const MAX_POSTS = 300;
const RANDOM_QUOTA = 280;
const HARD_QUOTA = 20;
const MAX_OBSERVED = 300;
const SAMPLE_PROBABILITY = 0.9;
const MAX_DURATION_MS = 20 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const OUTPUT = path.resolve('tmp/evaluation-samples'); // tmp/ is gitignored.
const PROTECTED = ['these posts are protected', 'follow to see', 'may contain sensitive content'];
const fingerprint = (s) => createHash('sha256').update(s).digest('hex');

async function cleanOldRuns() {
  await mkdir(OUTPUT, { recursive: true, mode: 0o700 });
  const prior = new Set();
  for (const name of await readdir(OUTPUT)) {
    if (!/^(?:canary-home|hard-history)-\d{8}T\d{6}\.jsonl$/.test(name)) continue;
    const file = path.join(OUTPUT, name);
    if (Date.now() - (await stat(file)).mtimeMs > RETENTION_MS) {
      await unlink(file);
      continue;
    }
    for (const line of (await readFile(file, 'utf8')).split('\n').slice(1)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (typeof record.sampleId === 'string') prior.add(record.sampleId);
    }
  }
  return prior;
}

// Sample before consulting the filter's answer. This is the only group suitable
// for a future population-rate estimate after independent human confirmation.
function selectedByRandomRule(seed, id) {
  const hash = createHmac('sha256', seed).update(id).digest();
  return hash.readUInt32BE(0) / 0x100000000 < SAMPLE_PROBABILITY;
}

async function capturePage(page) {
  return page.evaluate(() => {
    const own = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
      ?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,15})/)?.[1]
      ?? document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
        ?.textContent?.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? '';
    if (!own) return { accountKnown: false, posts: [] };
    const posts = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const href = article.querySelector('time')?.closest('a[href*="/status/"]')
        ?.getAttribute('href') ?? '';
      const id = href.match(/\/status\/(\d+)/)?.[1];
      if (!id) continue;
      const quoted = Array.from(article.querySelectorAll('div[role="link"]'))
        .find((item) => item.querySelector('[data-testid="tweetText"]'));
      const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
        .find((item) => !quoted?.contains(item))?.textContent?.trim() ?? '';
      const quote = quoted?.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? '';
      const userName = article.querySelector('[data-testid="User-Name"]');
      const handle = article.querySelector('[data-testid^="UserAvatar-Container-"]')
        ?.getAttribute('data-testid')?.slice('UserAvatar-Container-'.length)
        ?? userName?.textContent?.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? '';
      if (!handle || handle.toLowerCase() === own.toLowerCase()) continue;
      posts.push({ id, handle, name: userName?.querySelector('span')?.textContent?.trim() ?? '',
        text, quote, promoted: article.closest('[data-testid="placementTracking"]') !== null,
        truncated: article.querySelector('[data-testid="tweet-text-show-more-link"]') !== null });
    }
    return { accountKnown: true, posts };
  });
}

async function readPanel(panel, posts, started) {
  return panel.evaluate(async ({ items, startAt }) => {
    const data = await chrome.storage.local.get(['anyfilter.panel']);
    const state = data['anyfilter.panel'] ?? {};
    return Object.fromEntries(items.map(({ id, text }) => {
      const entry = state.hidden?.[id];
      const sameText = entry?.post?.text === text && entry?.at >= startAt;
      const historical = !!entry && !sameText;
      return [id, {
        // Kept entries have no input/time in the existing panel history. Never
        // promote those into a verified Jev result or a formal negative label.
        outcome: sameText ? (entry.shown ? 'restored' : 'hidden')
          : historical ? 'historical-unverified'
          : state.seen?.[id] === 'kept' ? 'kept-unverified' : 'unreported',
        hiddenSnapshotMatches: sameText === true,
        reasons: sameText ? (entry.reasons ?? []).map(({ categoryId, probability }) => ({
          ruleId: categoryId, score: Number.isFinite(probability) ? probability : null,
        })) : [],
        shownByUser: sameText ? !!entry.shown : false,
      }];
    }));
  }, { items: posts.map(({ id, text }) => ({ id, text })), startAt: started });
}

async function readConfig(panel) {
  return panel.evaluate(async () => {
    const data = await chrome.storage.local.get('anyfilter.settings');
    const s = data['anyfilter.settings'] ?? {};
    const bytes = new TextEncoder().encode(JSON.stringify([s.rules ?? [], s.threshold, s.provider]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { filteringEnabled: s.filterOn === true,
      rulesHash: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(''),
      threshold: s.threshold ?? null, provider: s.provider ?? 'unknown' };
  });
}

async function main() {
  const prior = await cleanOldRuns();
  const seed = randomBytes(16).toString('hex');
  const browser = await chromium.connectOverCDP(ENDPOINT);
  let page;
  const started = Date.now();
  const samples = new Map();
  const hardCandidates = new Map();
  const observed = new Set();
  const oldSeenThisRun = new Set();
  let quotaTruncated = false;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Canary browser context is unavailable');
    const panel = context.pages().find((p) => p.url().startsWith('chrome-extension://')
      && new URL(p.url()).pathname === '/sidepanel.html');
    if (!panel) throw new Error('AnyFilter side panel is not open');
    const config = await readConfig(panel);
    if (!config.filteringEnabled) throw new Error('AnyFilter filtering is off; no run started');
    page = await context.newPage();
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    let idle = 0;
    for (let step = 0; step < 150 && observed.size < MAX_OBSERVED && Date.now() - started < MAX_DURATION_MS; step++) {
      if (new URL(page.url()).origin !== 'https://x.com' || new URL(page.url()).pathname !== '/home') break;
      const current = await capturePage(page);
      if (!current.accountKnown) {
        if (step < 4) { await page.waitForTimeout(1000); continue; }
        throw new Error('Could not confirm signed-in account; no post was saved');
      }
      let added = 0;
      for (const post of current.posts) {
        if (observed.size >= MAX_OBSERVED) break;
        const probe = `${post.text} ${post.quote}`.toLowerCase();
        if (!post.text || post.text.length > 2000 || post.quote.length > 1000
          || post.name.length > 120 || !/^[A-Za-z0-9_]{1,64}$/.test(post.handle)
          || PROTECTED.some((marker) => probe.includes(marker))) continue;
        const input = JSON.stringify({ author: { handle: `@${post.handle}`, name: post.name },
          text: post.text, ...(post.quote ? { quoted: post.quote } : {}) });
        const sampleId = `${post.id}.${fingerprint(input).slice(0, 16)}`;
        if (observed.has(sampleId)) continue;
        if (prior.has(sampleId)) { oldSeenThisRun.add(sampleId); continue; }
        observed.add(sampleId);
        const sample = { sampleId, postId: post.id, input, inputHash: fingerprint(input),
          observedAt: new Date().toISOString(), page: HOME, source: 'random-home',
          promoted: post.promoted, truncated: post.truncated,
          // A missing verdict must not be silently treated as a keep decision.
          observedAction: { outcome: 'unreported', hiddenSnapshotMatches: false, reasons: [] } };
        if (selectedByRandomRule(seed, post.id)) {
          if (samples.size < RANDOM_QUOTA) samples.set(sampleId, sample);
          else quotaTruncated = true;
        } else {
          // Kept strictly separate: hard examples are selected only after we
          // know the page action, and never enter the random-sample denominator.
          hardCandidates.set(sampleId, sample);
        }
        added++;
      }
      idle = added ? 0 : idle + 1;
      if (idle >= 12) break;
      await page.mouse.wheel(0, 640);
      await page.waitForTimeout(950);
    }
    // Read the extension's actions after rendering has had time to settle.
    await page.waitForTimeout(1400);
    const allCandidates = [...samples.values(), ...hardCandidates.values()];
    for (let i = 0; i < allCandidates.length; i += 20) {
      const batch = allCandidates.slice(i, i + 20);
      const actions = await readPanel(panel, batch.map((s) => ({
        id: s.postId, text: JSON.parse(s.input).text,
      })), started);
      for (const s of batch) s.observedAction = actions[s.postId] ?? s.observedAction;
    }
    const extraHidden = [...hardCandidates.values()]
      .filter((s) => s.observedAction.outcome === 'hidden' && s.observedAction.hiddenSnapshotMatches)
      .slice(0, HARD_QUOTA)
      .map((s) => ({ ...s, source: 'hard-hidden' }));
    const items = [...samples.values(), ...extraHidden].slice(0, MAX_POSTS);
    const stamp = new Date(started).toISOString().replace(/[-:]/g, '').slice(0, 15);
    const file = path.join(OUTPUT, `canary-home-${stamp}.jsonl`);
    const header = { type: 'batch', startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(), config,
      sampling: { seed, probability: SAMPLE_PROBABILITY, eligibleNew: observed.size,
        duplicatesFromEarlierRuns: oldSeenThisRun.size, randomStored: samples.size,
        hardHiddenStored: extraHidden.length, quotaTruncated },
      limitations: 'Random and hard-hidden groups must be reported separately. Kept results have no verified Jev score. No independent model or human labels.',
      sampleCount: items.length };
    await writeFile(file, [JSON.stringify(header), ...items.map((s) => JSON.stringify(s)), ''].join('\n'),
      { flag: 'wx', mode: 0o600 });
    const counts = items.reduce((a, s) => {
      a[s.observedAction.outcome] = (a[s.observedAction.outcome] ?? 0) + 1; return a;
    }, {});
    console.log(JSON.stringify({ file, sampled: items.length,
      observedEligible: observed.size, randomStored: samples.size,
      hardHiddenStored: extraHidden.length, duplicatesFromEarlierRuns: oldSeenThisRun.size,
      quotaTruncated, actions: counts,
      elapsedSeconds: Math.ceil((Date.now() - started) / 1000),
      note: 'Only local candidates; model and human labels are not available' }));
  } finally {
    await page?.close().catch(() => {});
    await browser.close();
  }
}

main().catch((error) => { console.error('Capture stopped:', error.message); process.exitCode = 1; });