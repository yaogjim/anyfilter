#!/usr/bin/env node
/**
 * Real-quality report from stored facts: an evaluation export, the human blind
 * labels and the review queue written by `import-evaluation-export.mjs`.
 *
 *   node scripts/evaluation-report.mjs <export.json> [--dir tmp/evaluation-samples] [--min-samples N]
 *
 * - Each labeller (Jev, OpenAI, DeepSeek) is scored against the human labels on
 *   its own; nothing is averaged across labellers, rules, sources or splits.
 * - A machine answer never stands in for a human label. Samples without one are
 *   counted as unreviewed and excluded.
 * - Rule-change suggestions use the `dev` split only. The random holdout is
 *   reported, never used to suggest a change.
 * - Suggestions are text. Nothing is applied until a person confirms.
 *
 * Writes `evaluation-report.json` and `evaluation-report.md` beside the inputs
 * (git-ignored, mode 0600). Never contacts the network.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const LABELLERS = ['jev', 'openai', 'deepseek'];

if (!process.execArgv.some((arg) => arg.includes('ts-loader'))) {
  const loader = path.join(path.dirname(SELF), 'ts-loader.mjs');
  const child = spawnSync(process.execPath, ['--import', loader, SELF, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const { summariseEvaluation } = await import('../src/features/evaluation-metrics.ts');
const { stateOfResult, validateExport } = await import('./import-evaluation-export.mjs');

const pct = (rate) => (rate.point === null ? 'n/a' : `${(rate.point * 100).toFixed(1)}%`);
const ci = (rate) => (rate.interval === null ? '' : ` [${(rate.interval.low * 100).toFixed(0)}-${(rate.interval.high * 100).toFixed(0)}]`);

function judgementOf(result, state) {
  const model = result.answeredModel ?? result.model;
  if (state === 'undecided') return { status: 'undecided', model, tokens: result.inputTokens + result.outputTokens };
  const score = result.verdict.status === 'decided' ? result.verdict.score : state === 'match' ? 1 : 0;
  return { status: state, score, model, tokens: result.inputTokens + result.outputTokens };
}

/** Records for one labeller. Only samples a human labelled are counted. */
export function recordsFor(labeller, exported, human, queue) {
  const splitOf = new Map((queue?.records ?? []).map((r) => [r.sampleId, r.split]));
  const disputed = new Set(queue?.disputedIds ?? []);
  const sampleById = new Map(exported.samples.map((s) => [s.sampleId, s]));
  const records = [];
  const seen = new Set();
  for (const [result, sampleId] of exported.results.flatMap((r) => (r.sampleIds ?? [r.sampleId]).map((id) => [r, id]))) {
    if (result.labeller !== labeller) continue;
    const sample = sampleById.get(sampleId);
    const label = human?.records?.[sampleId]?.[result.ruleId];
    if (!sample || !label) continue;
    const once = `${sampleId}|${result.ruleId}`;
    if (seen.has(once)) continue;
    seen.add(once);
    const question = (exported.rules.find((r) => r.id === result.ruleId) ?? {}).questionWithParent ?? '';
    records.push({
      sampleId,
      postId: sample.postId,
      threadId: sample.threadId,
      source: disputed.has(sampleId) ? 'hard' : 'random',
      split: splitOf.get(sampleId) === 'holdout' ? 'holdout' : 'dev',
      config: { rulesFingerprint: result.rulesFingerprint, model: result.model, threshold: result.threshold },
      ruleId: result.ruleId,
      input: { stateJson: sample.stateJson, question, inputHash: result.inputHash, truncated: sample.truncated },
      jev: judgementOf(result, stateOfResult(result)),
      human: { source: 'human', state: label.state, reason: label.reason ?? '' },
      machine: [],
    });
  }
  return records;
}

/** Suggestions from `dev` only: which rule over- or under-hides, by sample id. */
export function suggestionsFor(labeller, records) {
  const notes = [];
  const byRule = new Map();
  for (const record of records) {
    if (record.split !== 'dev' || record.human.state === 'undecided' || record.jev.status === 'undecided') continue;
    const bucket = byRule.get(record.ruleId) ?? { fp: [], fn: [], n: 0 };
    bucket.n += 1;
    if (record.jev.status === 'match' && record.human.state === 'no-match') bucket.fp.push(record.sampleId);
    if (record.jev.status === 'no-match' && record.human.state === 'match') bucket.fn.push(record.sampleId);
    byRule.set(record.ruleId, bucket);
  }
  for (const [ruleId, { fp, fn, n }] of [...byRule].sort()) {
    if (n < 10) continue;
    if (fp.length / n >= 0.1) {
      notes.push({ labeller, ruleId, kind: 'over-hides', count: fp.length, of: n, sampleIds: fp.slice(0, 5), suggestion: `Narrow the definition of ${ruleId} or raise its threshold; ${fp.length} of ${n} dev answers hid something a person kept.` });
    }
    if (fn.length / n >= 0.1) {
      notes.push({ labeller, ruleId, kind: 'misses', count: fn.length, of: n, sampleIds: fn.slice(0, 5), suggestion: `Broaden the definition of ${ruleId} or lower its threshold; ${fn.length} of ${n} dev answers missed something a person marked as matching.` });
    }
  }
  return notes;
}

/** Keep only labels the reviewer made without a model-suggested default. */
export function independentLabels(human) {
  const records = {};
  let assisted = 0;
  for (const [sampleId, byRule] of Object.entries(human?.records ?? {})) {
    for (const [ruleId, label] of Object.entries(byRule)) {
      if (label.suggestedState) {
        assisted += 1;
        continue;
      }
      (records[sampleId] ??= {})[ruleId] = label;
    }
  }
  return { human: human ? { ...human, records } : human, assisted };
}

export function buildReport(exported, humanAll, queue, { minSamples = 20, includeAssisted = false } = {}) {
  const { human, assisted } = includeAssisted ? { human: humanAll, assisted: 0 } : independentLabels(humanAll);
  const perLabeller = {};
  const suggestions = [];
  for (const labeller of LABELLERS) {
    const records = recordsFor(labeller, exported, human, queue);
    perLabeller[labeller] = {
      labelled: records.length,
      groups: summariseEvaluation(records, { minSamples }).map((m) => ({
        ruleId: m.key.ruleId,
        source: m.key.source,
        split: m.key.split,
        total: m.total,
        counts: { tp: m.counts.tp, fp: m.counts.fp, tn: m.counts.tn, fn: m.counts.fn },
        precision: m.precision,
        recall: m.recall,
        evidence: m.evidence,
        reasons: m.reasons,
      })),
    };
    suggestions.push(...suggestionsFor(labeller, records));
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    assistedExcluded: assisted,
    humanLabels: Object.values(human?.records ?? {}).reduce((sum, byRule) => sum + Object.keys(byRule).length, 0),
    note: 'Rates compare each labeller with human blind labels only. Suggestions come from the dev split; the holdout is never used. Nothing is applied until confirmed.',
    perLabeller,
    suggestions,
  };
}

export function renderMarkdown(report) {
  const lines = ['# AnyFilter real-quality report', '', report.note, '', `Human labels used: ${report.humanLabels}` + (report.assistedExcluded ? ` (${report.assistedExcluded} labels adopted from a model suggestion were excluded)` : ''), ''];
  for (const labeller of LABELLERS) {
    const entry = report.perLabeller[labeller];
    lines.push(`## ${labeller} (${entry.labelled} human-labelled answers)`, '');
    if (entry.groups.length === 0) lines.push('No human-labelled answers yet.', '');
    else {
      lines.push('| rule | source | split | n | precision | recall | evidence |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const g of entry.groups) {
        lines.push(`| ${g.ruleId} | ${g.source} | ${g.split} | ${g.total} | ${pct(g.precision)}${ci(g.precision)} | ${pct(g.recall)}${ci(g.recall)} | ${g.evidence} |`);
      }
      lines.push('');
    }
  }
  lines.push('## Rule-change suggestions (dev split only, not applied)', '');
  if (report.suggestions.length === 0) lines.push('None yet.');
  for (const s of report.suggestions) lines.push(`- **${s.labeller} / ${s.ruleId}** (${s.kind}): ${s.suggestion} Examples: ${s.sampleIds.join(', ')}`);
  return lines.join('\n') + '\n';
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const file = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--dir' && argv[i - 1] !== '--min-samples');
  if (!file) throw new Error('usage: evaluation-report.mjs <export.json> [--dir DIR] [--min-samples N]');
  const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const dir = path.resolve(option('--dir', 'tmp/evaluation-samples'));
  const exported = validateExport(await readJson(file));
  const human = await readJson(path.join(dir, 'human-labels.json'), null);
  const queue = await readJson(path.join(dir, 'review-queue.json'), null);
  const report = buildReport(exported, human, queue, { minSamples: Number(option('--min-samples', 20)), includeAssisted: argv.includes('--include-assisted') });
  await writeFile(path.join(dir, 'evaluation-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'evaluation-report.md'), renderMarkdown(report), { mode: 0o600 });
  console.log(JSON.stringify({ humanLabels: report.humanLabels, assistedExcluded: report.assistedExcluded, suggestions: report.suggestions.length, report: 'evaluation-report.md' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Report failed:', error.message);
    process.exitCode = 1;
  });
}
