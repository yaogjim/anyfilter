#!/usr/bin/env node
// Puts a rule pack into the extension running in a debuggable Chrome, or puts the
// previous rules back. Nothing happens without --yes: read the replay report and
// decide first.
//
//   pnpm rule:apply --pack <pack.json> --yes          # add or update the pack's rules
//   pnpm rule:apply --rollback <backup.json> --yes    # restore the rules saved before
//
// Rules of the pack replace rules with the same id and are appended otherwise;
// no other rule is touched. The rules that were in place go to tmp/rule-backups/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const CDP = process.env.ANYFILTER_CDP ?? 'http://127.0.0.1:9222';

const argv = process.argv.slice(2);
const pick = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const packFile = pick('--pack');
const rollbackFile = pick('--rollback');

async function main() {
  if ((!packFile && !rollbackFile) || !argv.includes('--yes')) {
    console.error('用法：pnpm rule:apply --pack <规则包.json> --yes  或  --rollback <备份.json> --yes');
    console.error('不带 --yes 不会改任何东西：先看重放报告，再决定。');
    process.exit(2);
  }
  const core = await import('./rule-replay-core.mjs');
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  let extensionId = process.env.ANYFILTER_EXTENSION_ID;
  for (const worker of context.serviceWorkers()) {
    if (extensionId || !worker.url().startsWith('chrome-extension://')) continue;
    // Other extensions have workers too: only ours is named AnyFilter.
    const name = await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
    if (name === 'AnyFilter') extensionId = new URL(worker.url()).host;
  }
  if (!extensionId) throw new Error('no AnyFilter service worker found; is the extension loaded (and awake) in that Chrome? Set ANYFILTER_EXTENSION_ID to skip the search.');
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const stored = await page.evaluate(async () => (await chrome.storage.local.get('anyfilter.settings'))['anyfilter.settings']);
    if (!stored || !Array.isArray(stored.rules)) throw new Error('the extension has no stored rules yet');
    mkdirSync(path.join(ROOT, 'tmp', 'rule-backups'), { recursive: true });
    const backup = path.join(ROOT, 'tmp', 'rule-backups', `rules-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}.json`);
    writeFileSync(backup, JSON.stringify({ revision: stored.revision, rules: stored.rules, ruleGroups: stored.ruleGroups }, null, 2));

    // Rules and categories are saved together. A record from before categories
    // existed has none stored, which the extension reads as its default four.
    const DEFAULT_GROUPS = ['marketing', 'engagement', 'harmful', 'politics'].map((id) => ({ id, name: '' }));
    let groups = Array.isArray(stored.ruleGroups) ? stored.ruleGroups : DEFAULT_GROUPS;
    let next;
    if (rollbackFile) {
      const saved = JSON.parse(readFileSync(path.resolve(rollbackFile), 'utf8'));
      next = saved.rules;
      if (Array.isArray(saved.ruleGroups)) groups = saved.ruleGroups;
    } else {
      const pack = core.parseRulePack(readFileSync(path.resolve(packFile), 'utf8'));
      const byId = new Map(pack.rules.map((rule) => [rule.id, rule]));
      next = stored.rules.map((rule) => byId.get(rule.id) ?? rule);
      for (const rule of pack.rules) if (!stored.rules.some((existing) => existing.id === rule.id)) next.push(rule);
    }
    const result = await page.evaluate(
      ({ rules, revision, groups }) =>
        chrome.runtime.sendMessage({ type: 'save-rules', rules, expectedRevision: revision, groups }),
      { rules: next, revision: stored.revision, groups },
    );
    if (!result?.ok) throw new Error(`the extension refused the rules: ${result?.detail ?? 'no answer'}`);
    console.log(`已保存 ${next.length} 条规则；改动前的规则备份在 ${backup}`);
  } finally {
    await page.close();
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  if (process.env.ANYFILTER_APPLY_RELAUNCHED === '1' || !/Unknown file extension|Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(error))) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  const flags = major === 22 ? ['--experimental-strip-types'] : [];
  const result = spawnSync(
    process.execPath,
    [...flags, '--import', path.join(ROOT, 'scripts', 'ts-loader.mjs'), SELF, ...argv],
    { stdio: 'inherit', env: { ...process.env, ANYFILTER_APPLY_RELAUNCHED: '1' } },
  );
  process.exit(result.status ?? 1);
}
