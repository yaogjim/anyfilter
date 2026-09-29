#!/usr/bin/env node
// Replays a candidate rule pack against your review labels through Jev and writes
// a report that says pass / fail / not enough data. It applies nothing.
//
//   pnpm rule:replay --labels <export.json> [--labels <more.json>] --pack <pack.json>
//                    [--base builtin|<pack.json>] [--threshold 0.8] [--out DIR] [--max-calls 600]
//
// Reads JEV_API_KEY from .env (never printed). Every (post, question) answer is
// cached under tmp/, so re-running an unchanged pack costs nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
const USD_PER_TOKEN = 0.042 / 1e6;

function args(argv) {
  const out = { labels: [], threshold: 0.8, out: path.join(ROOT, 'tmp', 'rule-replay'), base: 'builtin', maxCalls: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--labels') out.labels.push(value);
    else if (key === '--pack') out.pack = value;
    else if (key === '--base') out.base = value;
    else if (key === '--threshold') out.threshold = Number(value);
    else if (key === '--out') out.out = path.resolve(value);
    else if (key === '--max-calls') out.maxCalls = Number(value);
    else continue;
    i += 1;
  }
  return out;
}

function readEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.labels.length === 0 || !opts.pack || !(opts.threshold > 0 && opts.threshold <= 1)) {
    console.error('用法：pnpm rule:replay --labels <复核标注导出.json> [--labels ...] --pack <规则包.json> [--base builtin|<规则包.json>] [--threshold 0.8]');
    process.exit(2);
  }
  const core = await import('./rule-replay-core.mjs');
  const exports = opts.labels.map((file) => JSON.parse(readFileSync(path.resolve(file), 'utf8')).records);
  const { labels, conflicts } = core.mergeLabels(exports);
  const base = opts.base === 'builtin' ? core.builtinPack() : core.parseRulePack(readFileSync(path.resolve(opts.base), 'utf8'));
  // The pack is laid over the base the way `rule:apply` lays it over the stored rules.
  const candidate = core.overlayPack(base, core.parseRulePack(readFileSync(path.resolve(opts.pack), 'utf8')));

  const key = readEnv().JEV_API_KEY;
  if (!key) throw new Error('JEV_API_KEY is missing from .env');
  mkdirSync(opts.out, { recursive: true });
  const cacheFile = path.join(ROOT, 'tmp', 'rule-replay-cache.json');
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const spend = { calls: 0, tokens: 0, usd: 0 };
  const scorer = async (stateJson, ruleId, question) => {
    const id = createHash('sha1').update(`${MODEL}\u0000${stateJson}\u0000${question}`).digest('hex');
    if (id in cache) return cache[id];
    if (spend.calls >= opts.maxCalls) throw new Error(`stopped: more than ${opts.maxCalls} new requests (raise --max-calls on purpose)`);
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: JSON.parse(stateJson), questions: { [ruleId]: { type: 'noul', instructions: question } } }),
    });
    if (!response.ok) throw new Error(`Jev answered ${response.status}`);
    const json = await response.json();
    const score = json.answers?.[ruleId]?.noul;
    if (typeof score !== 'number') throw new Error('Jev returned no score');
    spend.calls += 1;
    spend.tokens += json.usage?.input_tokens ?? 0;
    spend.usd = spend.tokens * USD_PER_TOKEN;
    cache[id] = score;
    return score;
  };

  const baseScores = await core.scoreRules(base.rules, labels, scorer);
  const candidateScores = await core.scoreRules(candidate.rules, labels, scorer);
  writeFileSync(cacheFile, JSON.stringify(cache));
  const comparison = core.compareRuleSets({ base, candidate, labels, baseScores, candidateScores, threshold: opts.threshold });
  const judgement = core.judge(comparison);
  const report = core.renderReport({ base, candidate, comparison, judgement, conflicts, spend, labelFiles: opts.labels });
  writeFileSync(path.join(opts.out, 'rule-replay.md'), report);
  writeFileSync(path.join(opts.out, 'rule-replay.json'), `${JSON.stringify({ comparison, judgement, conflicts, spend, candidate: candidate.name }, null, 2)}\n`);
  console.log(report);
  console.log(`已写入 ${path.join(opts.out, 'rule-replay.md')}`);
}

// The core imports the extension's TypeScript, so the loader has to be present.
try {
  await main();
} catch (error) {
  if (process.env.ANYFILTER_REPLAY_RELAUNCHED === '1' || !/Unknown file extension|Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(error))) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  const flags = major === 22 ? ['--experimental-strip-types'] : [];
  const result = spawnSync(
    process.execPath,
    [...flags, '--import', path.join(ROOT, 'scripts', 'ts-loader.mjs'), SELF, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ANYFILTER_REPLAY_RELAUNCHED: '1' } },
  );
  process.exit(result.status ?? 1);
}
