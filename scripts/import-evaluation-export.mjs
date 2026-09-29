#!/usr/bin/env node
/**
 * Turn a file exported from the side panel's "Real evaluation" section into the
 * inputs of the human blind review.
 *
 *   node scripts/import-evaluation-export.mjs <anyfilter-evaluation-*.json> [--dir tmp/evaluation-samples]
 *
 * Writes, under `tmp/` only (git-ignored, mode 0600):
 *   - `extension-export-<stamp>.jsonl`  header + one row per sample, the same row
 *     shape `blind-review.mjs` already reads. It carries the stored post state and
 *     nothing a machine said.
 *   - `machine-results.json`            per sample and rule, what each labeller
 *     answered. Only this script and the report read it; the blind review never
 *     does, so a reviewer cannot see it.
 *   - `review-queue.json`               the review order: first a random holdout
 *     batch, then the disputed batch (samples where the labellers disagree).
 *
 * Nothing here reaches the network. The export contains post text: keep it private.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOLDOUT_LIMIT = 40;
export const DISPUTED_LIMIT = 60;

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const byHash = (a, b) => sha256(a).localeCompare(sha256(b));

/** What a labeller said, reduced to the shared three states. */
export function stateOfResult(result) {
  const verdict = result.verdict ?? {};
  if (verdict.status === 'labelled') return verdict.state;
  if (verdict.status === 'decided') return verdict.score >= result.threshold ? 'match' : 'no-match';
  return 'undecided';
}

export function validateExport(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('the file is not an evaluation export');
  if (raw.version !== 1) throw new Error(`unsupported export version: ${raw.version}`);
  if (raw.containsPostText !== true) throw new Error('not an AnyFilter evaluation export');
  for (const key of ['samples', 'results', 'rules']) {
    if (!Array.isArray(raw[key])) throw new Error(`the export has no ${key} list`);
  }
  return raw;
}

const normalisedText = (stateJson) => {
  try {
    return String(JSON.parse(stateJson).text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  } catch {
    return String(stateJson);
  }
};

/** sampleId -> ruleId -> labeller -> state */
export function machineTable(exported) {
  const table = {};
  for (const result of exported.results) {
    // One answer covers every sample whose input for the rule is identical.
    for (const sampleId of result.sampleIds ?? [result.sampleId]) {
      const byRule = (table[sampleId] ??= {});
      (byRule[result.ruleId] ??= {})[result.labeller] = stateOfResult(result);
    }
  }
  return table;
}

/** A sample is disputed when two labellers answered a rule differently. */
export function disputedSampleIds(table) {
  const ids = [];
  for (const [sampleId, byRule] of Object.entries(table)) {
    const disputed = Object.values(byRule).some((byLabeller) => new Set(Object.values(byLabeller)).size > 1);
    if (disputed) ids.push(sampleId);
  }
  return ids;
}

export function buildQueue(exported, { now = new Date().toISOString() } = {}) {
  const table = machineTable(exported);
  const disputed = new Set(disputedSampleIds(table));
  // Near-identical posts share one group so they can never straddle the split.
  const groups = new Map(exported.samples.map((s) => [s.sampleId, sha256(normalisedText(s.stateJson))]));
  const disputedGroups = new Set([...disputed].map((id) => groups.get(id)));
  const records = exported.samples.map((sample) => {
    const group = groups.get(sample.sampleId);
    const holdout = !disputedGroups.has(group) && parseInt(group.slice(0, 8), 16) % 5 === 0;
    return {
      sampleId: sample.sampleId,
      split: disputed.has(sample.sampleId) ? 'diagnostic' : holdout ? 'holdout' : 'dev',
      groupHash: group,
      human: 'pending',
    };
  });
  const holdoutIds = records.filter((r) => r.split === 'holdout').map((r) => r.sampleId).sort(byHash);
  return {
    version: 1,
    createdAt: now,
    policy:
      'Random holdout is reviewed first and never used to tune rules. Disputed samples (labellers disagree) are a separate diagnostic batch. Labels stay pending until a person records them.',
    totals: {
      all: records.length,
      holdout: holdoutIds.length,
      disputed: disputed.size,
      dev: records.filter((r) => r.split === 'dev').length,
    },
    blindRandomHoldoutIds: holdoutIds.slice(0, HOLDOUT_LIMIT),
    disputedIds: [...disputed].sort(byHash).slice(0, DISPUTED_LIMIT),
    records,
  };
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

export function sampleRows(exported) {
  return exported.samples.map((sample) => ({
    sampleId: sample.sampleId,
    source: 'extension-capture',
    input: sample.stateJson,
    observedAction: { outcome: 'unreported' },
  }));
}

export async function main(argv = process.argv.slice(2)) {
  const file = argv.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('usage: import-evaluation-export.mjs <export.json> [--dir DIR]');
  const dirIndex = argv.indexOf('--dir');
  const dir = path.resolve(dirIndex >= 0 ? argv[dirIndex + 1] : 'tmp/evaluation-samples');
  const exported = validateExport(JSON.parse(await readFile(file, 'utf8')));
  const now = new Date();
  await mkdir(dir, { recursive: true });
  const header = { kind: 'extension-export', exportedAt: exported.exportedAt, samples: exported.samples.length };
  const rows = [header, ...sampleRows(exported)].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const batch = `extension-export-${stamp(now)}.jsonl`;
  await writeFile(path.join(dir, batch), rows, { mode: 0o600 });
  await writeFile(path.join(dir, 'machine-results.json'), JSON.stringify({ version: 1, table: machineTable(exported) }, null, 2) + '\n', {
    mode: 0o600,
  });
  const queue = buildQueue(exported, { now: now.toISOString() });
  await writeFile(path.join(dir, 'review-queue.json'), JSON.stringify(queue, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ batch, totals: queue.totals, blindRandom: queue.blindRandomHoldoutIds.length, disputed: queue.disputedIds.length, humanLabels: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Import failed:', error.message);
    process.exitCode = 1;
  });
}
