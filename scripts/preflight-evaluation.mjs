// E0 preflight for the real quality evaluation. Read-only and offline: it never
// contacts a model, a browser or X. It prints counts only, never post text.
//
//   node scripts/preflight-evaluation.mjs [--dir tmp/evaluation-samples] [--now ISO]
//
// Exit code 0 means the existing samples can be evaluated as they are. Exit
// code 1 means a hard problem (broken fingerprint, expired file, no random
// sample) that needs a re-capture inside the authorised range first.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MIN_RANDOM_SAMPLES = 100;
export const FILE_PATTERN = /^(?:canary-home|hard-history)-\d{8}T\d{6}\.jsonl$/;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Pure check of one parsed record. Returns a list of problem codes. */
export function recordProblems(record) {
  const problems = [];
  if (typeof record.sampleId !== 'string' || typeof record.postId !== 'string') problems.push('identity');
  if (typeof record.input !== 'string' || record.input.length === 0) return [...problems, 'no-input'];
  if (sha256(record.input) !== record.inputHash) problems.push('input-hash-mismatch');
  if (record.sampleId !== `${record.postId}.${String(record.inputHash).slice(0, 16)}`) problems.push('sample-id-mismatch');
  try {
    const state = JSON.parse(record.input);
    if (typeof state?.text !== 'string') problems.push('input-shape');
  } catch {
    problems.push('input-not-json');
  }
  if (Number.isNaN(Date.parse(record.observedAt))) problems.push('observed-at');
  return problems;
}

/** Pure summary of parsed files: `{ name, mtimeMs, records }[]`. */
export function summarise(files, nowMs) {
  const problems = {};
  const bump = (code) => { problems[code] = (problems[code] ?? 0) + 1; };
  const seen = new Map();
  const bySource = {};
  const byOutcome = {};
  const perFile = [];
  let truncated = 0;
  let promoted = 0;
  let duplicates = 0;
  let earliestExpiry = Infinity;
  const expired = [];
  for (const file of files) {
    const age = nowMs - file.mtimeMs;
    const expiresAt = file.mtimeMs + RETENTION_MS;
    earliestExpiry = Math.min(earliestExpiry, expiresAt);
    if (age > RETENTION_MS) expired.push(file.name);
    let bad = 0;
    for (const record of file.records) {
      const codes = recordProblems(record);
      for (const code of codes) bump(code);
      if (codes.length > 0) bad += 1;
      if (seen.has(record.sampleId)) {
        duplicates += 1;
        continue;
      }
      seen.set(record.sampleId, record);
      bySource[record.source] = (bySource[record.source] ?? 0) + 1;
      const outcome = record.observedAction?.outcome ?? 'unreported';
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
      if (record.truncated === true) truncated += 1;
      if (record.promoted === true) promoted += 1;
    }
    perFile.push({
      name: file.name,
      records: file.records.length,
      invalid: bad,
      ageHours: Math.round(age / 360_000) / 10,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }
  const random = Object.entries(bySource)
    .filter(([source]) => source === 'random-home' || source === 'bounded-canary-home')
    .reduce((sum, [, count]) => sum + count, 0);
  const hardFiles = Object.entries(bySource).filter(([source]) => source.startsWith('hard')).reduce((s, [, c]) => s + c, 0);
  const blocking = [];
  if (expired.length > 0) blocking.push(`expired files: ${expired.join(', ')}`);
  if ((problems['input-hash-mismatch'] ?? 0) > 0) blocking.push('input fingerprints do not match the stored text');
  if ((problems['sample-id-mismatch'] ?? 0) > 0) blocking.push('sample ids do not match their fingerprints');
  if (random < MIN_RANDOM_SAMPLES) blocking.push(`only ${random} random samples (need ${MIN_RANDOM_SAMPLES})`);
  return {
    files: perFile,
    uniqueSamples: seen.size,
    duplicates,
    bySource,
    byOutcome,
    randomSamples: random,
    hardSamples: hardFiles,
    truncated,
    promoted,
    problems,
    earliestExpiry: Number.isFinite(earliestExpiry) ? new Date(earliestExpiry).toISOString() : null,
    hoursUntilFirstExpiry: Number.isFinite(earliestExpiry) ? Math.round((earliestExpiry - nowMs) / 360_000) / 10 : null,
    blocking,
    recaptureNeeded: blocking.length > 0,
  };
}

async function load(dir) {
  const files = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!FILE_PATTERN.test(name)) continue;
    const full = path.join(dir, name);
    const lines = (await readFile(full, 'utf8')).split('\n').filter((line) => line.trim());
    files.push({ name, mtimeMs: (await stat(full)).mtimeMs, records: lines.slice(1).map((line) => JSON.parse(line)) });
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const dir = path.resolve(option('--dir', 'tmp/evaluation-samples'));
  const now = option('--now') ? Date.parse(option('--now')) : Date.now();
  const report = summarise(await load(dir), now);
  console.log(JSON.stringify(report, null, 2));
  if (report.recaptureNeeded) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Preflight failed:', error.message);
    process.exitCode = 2;
  });
}
