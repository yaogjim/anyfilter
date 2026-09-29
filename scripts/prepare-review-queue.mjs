// Prepare separate review cohorts without sending raw text to a model.
// Machine consensus is not a human-confirmed label or a quality metric.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = path.resolve('tmp/evaluation-samples');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const pick = (rows, limit) => rows.sort((a, b) =>
  hash(a.sampleId).localeCompare(hash(b.sampleId))).slice(0, limit);

async function main() {
  const rows = [];
  for (const name of await readdir(DIR)) {
    if (!/^(?:canary-home|hard-history)-\d{8}T\d{6}\.jsonl$/.test(name)) continue;
    const lines = (await readFile(path.join(DIR, name), 'utf8')).trim().split('\n');
    rows.push(...lines.slice(1).map(JSON.parse));
  }
  const unique = [...new Map(rows.map((row) => [row.sampleId, row])).values()];
  const groupOf = (row) => hash(JSON.parse(row.input).text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  const diagnosticGroups = new Set(unique.filter((row) => row.source !== 'random-home').map(groupOf));
  const prepared = unique.map((row) => {
    // Deterministic content grouping: exact normalized near repeats share a
    // split. Thread-level grouping is not yet available for the home feed.
    const contentGroup = groupOf(row);
    const random = row.source === 'random-home';
    const split = random && !diagnosticGroups.has(contentGroup)
      && parseInt(contentGroup.slice(0, 8), 16) % 5 === 0
      ? 'holdout' : random ? 'dev' : 'diagnostic';
    return { sampleId: row.sampleId, source: row.source, split,
      groupHash: contentGroup, outcome: row.observedAction?.outcome ?? 'unreported',
      human: 'pending', machines: 'not-run' };
  });
  const holdout = prepared.filter((r) => r.split === 'holdout');
  const randomBlind = pick(holdout, 40);
  const hiddenDiagnostic = pick(prepared.filter((r) => r.split === 'diagnostic'
    && ['hidden', 'historical-hidden-unverified'].includes(r.outcome)), 30);
  const keptDiagnostic = pick(prepared.filter((r) => r.source === 'random-home'
    && r.split === 'dev' && r.outcome === 'kept-unverified'), 30);
  const manifest = { version: 1, createdAt: new Date().toISOString(),
    policy: 'Group by normalized content before split; random holdout first, then separate hidden and kept diagnostics. All labels pending.',
    totals: { all: prepared.length, random: prepared.filter((r) => r.source === 'random-home').length,
      holdout: holdout.length, diagnostic: prepared.filter((r) => r.split === 'diagnostic').length,
      historyOnly: prepared.filter((r) => r.source === 'hard-history').length },
    blindRandomHoldoutIds: randomBlind.map((r) => r.sampleId),
    hiddenDiagnosticIds: hiddenDiagnostic.map((r) => r.sampleId),
    keptDiagnosticIds: keptDiagnostic.map((r) => r.sampleId),
    records: prepared };
  const file = path.join(DIR, 'review-queue.json');
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ file, totals: manifest.totals,
    blindRandom: randomBlind.length, hiddenDiagnostic: hiddenDiagnostic.length,
    keptDiagnostic: keptDiagnostic.length, machineLabels: 0, humanLabels: 0 }));
}

main().catch((error) => { console.error('Review queue failed:', error.message); process.exitCode = 1; });