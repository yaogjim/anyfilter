/**
 * Export import + report (offline, synthetic data): the blind queue hides every
 * machine answer, disputes come from labeller disagreement, and the report only
 * counts human-labelled answers and suggests changes from the dev split.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQueue, disputedSampleIds, machineTable, sampleRows, stateOfResult, validateExport } from '../import-evaluation-export.mjs';
import { buildReport, renderMarkdown, suggestionsFor, recordsFor } from '../evaluation-report.mjs';
import { indexSamples, loadQueue, selectBlindEntries } from '../blind-review.mjs';

const FP = 'fp-1';
const state = (n) => JSON.stringify({ author: { handle: 'h', name: 'n' }, text: `post number ${n}`, quoted: '', replyingTo: null });

function fixture(count = 40) {
  const samples = [];
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const sampleId = `s${i}`;
    samples.push({ sampleId, postId: `p${i}`, threadId: `t${i}`, inputHash: `h${i}`, stateJson: state(i), truncated: false, promoted: false, capturedAt: 0, page: 'home', observed: [] });
    const base = { ruleId: 'bait', sampleId, inputHash: `h${i}`, rulesFingerprint: FP, threshold: 0.7, inputTokens: 10, outputTokens: 1, costMicro: 1, answeredModel: null };
    // Jev always says match; OpenAI agrees except every 4th; DeepSeek says no-match.
    results.push({ ...base, labeller: 'jev', model: 'jev-1.13.0', verdict: { status: 'decided', score: 0.9 } });
    results.push({ ...base, labeller: 'openai', model: 'gpt-6-luna', verdict: { status: 'labelled', state: i % 4 === 0 ? 'no-match' : 'match', reason: 'r' } });
    results.push({ ...base, labeller: 'deepseek', model: 'deepseek-flash', verdict: { status: 'labelled', state: 'no-match', reason: 'r' } });
  }
  return { version: 1, exportedAt: 'x', pricingCheckedOn: 'x', containsPostText: true, rulesFingerprintWithParent: FP, rulesFingerprintWithoutParent: FP, rules: [{ id: 'bait', label: 'Bait', threshold: 0.7, questionWithParent: 'q?', questionWithoutParent: 'q?' }], samples, results, failures: [], spend: [] };
}

test('export validation refuses other files', () => {
  assert.throws(() => validateExport({ version: 2 }));
  assert.throws(() => validateExport({ version: 1, containsPostText: false }));
  assert.doesNotThrow(() => validateExport(fixture(1)));
});

test('one answer covers every sample with an identical input', () => {
  const exported = fixture(3);
  exported.results[0].sampleIds = ['s0', 's1', 's2'];
  const table = machineTable(exported);
  assert.equal(table.s1.bait.jev, 'match');
  assert.equal(table.s2.bait.jev, 'match');
  const human = { records: { s2: { bait: { state: 'no-match', reason: '' } } } };
  const records = recordsFor('jev', exported, human, null);
  assert.deepEqual(records.map((r) => r.sampleId), ['s2']);
});

test('a score is turned into a state with the rule threshold', () => {
  const at = (score, threshold) => stateOfResult({ threshold, verdict: { status: 'decided', score } });
  assert.equal(at(0.7, 0.7), 'match');
  assert.equal(at(0.69, 0.7), 'no-match');
  assert.equal(stateOfResult({ threshold: 0.7, verdict: { status: 'undecided' } }), 'undecided');
});

test('disputed samples are the ones the labellers disagree on', () => {
  const table = machineTable(fixture(4));
  assert.deepEqual(disputedSampleIds(table).sort(), ['s0', 's1', 's2', 's3']);
  const agree = fixture(2);
  for (const r of agree.results) r.verdict = { status: 'labelled', state: 'match', reason: '' };
  assert.deepEqual(disputedSampleIds(machineTable(agree)), []);
});

test('the queue reviews a random holdout first and keeps holdout and disputed apart', () => {
  const exported = fixture(60);
  // Make some samples agree so a random holdout can exist.
  for (const r of exported.results) if (Number(r.sampleId.slice(1)) % 3 === 0) r.verdict = { status: 'labelled', state: 'match', reason: '' };
  for (const r of exported.results.filter((x) => x.labeller === 'jev' && Number(x.sampleId.slice(1)) % 3 === 0)) r.verdict = { status: 'decided', score: 0.9 };
  const queue = buildQueue(exported, { now: 'now' });
  assert.equal(queue.records.length, 60);
  const holdout = new Set(queue.blindRandomHoldoutIds);
  const disputed = new Set(queue.disputedIds);
  assert.ok(holdout.size > 0);
  assert.ok(disputed.size > 0);
  for (const id of holdout) assert.ok(!disputed.has(id));
  assert.ok(queue.records.every((r) => r.human === 'pending'));
});

test('the blind view carries the post state and no machine answer', () => {
  const exported = fixture(10);
  const queue = buildQueue(exported, { now: 'now' });
  const header = JSON.stringify({ kind: 'extension-export' });
  const content = [header, ...sampleRows(exported).map((row) => JSON.stringify(row))].join('\n');
  const { index } = indexSamples([{ content }]);
  assert.equal(index.size, 10);
  const { entries } = selectBlindEntries(loadQueue(queue), index);
  assert.ok(entries.length > 0);
  const text = JSON.stringify(entries);
  assert.ok(!/gpt-6|deepseek|jev-1|labelled|no-match|0\.9/.test(text));
  assert.ok(entries.every((entry) => entry.text.startsWith('post number')));
});

test('the report counts only human-labelled answers and never fills gaps from machines', () => {
  const exported = fixture(40);
  const queue = { records: exported.samples.map((s) => ({ sampleId: s.sampleId, split: 'dev' })), disputedIds: [] };
  const human = { records: { s0: { bait: { state: 'match', reason: '' } }, s1: { bait: { state: 'no-match', reason: '' } } } };
  const records = recordsFor('jev', exported, human, queue);
  assert.equal(records.length, 2);
  const report = buildReport(exported, human, queue, { minSamples: 1 });
  assert.equal(report.humanLabels, 2);
  assert.equal(report.perLabeller.deepseek.labelled, 2);
  const jev = report.perLabeller.jev.groups[0];
  assert.deepEqual(jev.counts, { tp: 1, fp: 1, tn: 0, fn: 0 });
});

test('labels adopted from a model suggestion are excluded unless asked for', () => {
  const exported = fixture(40);
  const queue = { records: exported.samples.map((s) => ({ sampleId: s.sampleId, split: 'dev' })), disputedIds: [] };
  const human = { records: { s0: { bait: { state: 'match', reason: '', suggestedState: 'match' } }, s1: { bait: { state: 'no-match', reason: '' } } } };
  const report = buildReport(exported, human, queue, { minSamples: 1 });
  assert.equal(report.humanLabels, 1);
  assert.equal(report.assistedExcluded, 1);
  assert.equal(buildReport(exported, human, queue, { minSamples: 1, includeAssisted: true }).humanLabels, 2);
});

test('suggestions come from the dev split and are never applied', () => {
  const rec = (i, split) => ({ sampleId: `s${i}`, ruleId: 'bait', split, human: { state: 'no-match' }, jev: { status: 'match' } });
  const dev = Array.from({ length: 12 }, (_, i) => rec(i, 'dev'));
  const holdoutOnly = Array.from({ length: 12 }, (_, i) => rec(i, 'holdout'));
  assert.equal(suggestionsFor('jev', dev).length, 1);
  assert.equal(suggestionsFor('jev', holdoutOnly).length, 0);
  const md = renderMarkdown(buildReport(fixture(2), null, null, { minSamples: 1 }));
  assert.match(md, /not applied/);
});
