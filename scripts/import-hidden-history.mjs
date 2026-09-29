// Optional diagnostic-only supplement: the existing hidden-post history cannot
// estimate a population rate, nor prove that Jev made the correct decision.
// Never mix these rows with random-home samples or send them to a provider here.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const DIR = path.resolve('tmp/evaluation-samples');
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const MARKERS = ['these posts are protected', 'follow to see', 'may contain sensitive content'];

async function main() {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const known = new Set();
  for (const name of await readdir(DIR)) {
    if (!/^(?:canary-home|hard-history)-\d{8}T\d{6}\.jsonl$/.test(name)) continue;
    const file = path.join(DIR, name);
    if (Date.now() - (await stat(file)).mtimeMs > MAX_AGE_MS) continue;
    for (const line of (await readFile(file, 'utf8')).split('\n').slice(1)) {
      if (!line.trim()) continue;
      known.add(JSON.parse(line).postId);
    }
  }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    const panel = browser.contexts().flatMap((c) => c.pages())
      .find((p) => p.url().startsWith('chrome-extension://')
        && new URL(p.url()).pathname === '/sidepanel.html');
    if (!panel) throw new Error('AnyFilter side panel is not open');
    const entries = await panel.evaluate(async () => {
      const stored = await chrome.storage.local.get('anyfilter.panel');
      return Object.values(stored['anyfilter.panel']?.hidden ?? {});
    });
    const now = Date.now();
    const samples = [];
    for (const entry of entries) {
      const post = entry?.post;
      if (!post || !/^\d{1,32}$/.test(post.id ?? '') || known.has(post.id)
        || post.own || entry.shown || !Array.isArray(entry.reasons)
        || !Number.isFinite(entry.at) || now - entry.at > MAX_AGE_MS || entry.at > now) continue;
      if (!/^[A-Za-z0-9_]{1,64}$/.test(post.handle ?? '')
        || !post.text || post.text.length > 2000 || post.quotedText?.length > 1000
        || post.name?.length > 120 || post.parent?.text?.length > 1000) continue;
      const probe = `${post.text} ${post.quotedText ?? ''} ${post.parent?.text ?? ''}`.toLowerCase();
      if (MARKERS.some((m) => probe.includes(m))) continue;
      const input = JSON.stringify({
        author: { handle: `@${post.handle}`, name: post.name ?? '' },
        text: post.text,
        ...(post.quotedText ? { quoted: post.quotedText } : {}),
        ...(post.parent ? { replyingTo: {
          author: `@${post.parent.handle}`, text: post.parent.text,
        } } : {}),
      });
      const sample = {
        sampleId: `${post.id}.${hash(input).slice(0, 16)}`,
        postId: post.id,
        input,
        inputHash: hash(input),
        observedAt: new Date(entry.at).toISOString(),
        source: 'hard-history',
        observedAction: { outcome: 'historical-hidden-unverified',
          // History has no proof that this input was the exact Jev request.
          hiddenSnapshotMatches: false,
          reasons: entry.reasons.map((r) => ({ ruleId: r.categoryId,
            score: Number.isFinite(r.probability) ? r.probability : null })),
        },
      };
      known.add(post.id);
      samples.push(sample);
    }
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15);
    const file = path.join(DIR, `hard-history-${stamp}.jsonl`);
    const header = { type: 'batch', source: 'hard-history',
      createdAt: new Date(now).toISOString(), sampleCount: samples.length,
      limitations: 'History-only biased diagnostics. No kept population, no original request proof, no independent or human labels.' };
    await writeFile(file, [JSON.stringify(header), ...samples.map((s) => JSON.stringify(s)), ''].join('\n'),
      { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ file, newHistoricalHiddenCandidates: samples.length }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error('History import stopped:', error.message); process.exitCode = 1; });