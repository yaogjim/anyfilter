/** E0 preflight (offline, synthetic data only). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { summarise, recordProblems, RETENTION_MS } from '../preflight-evaluation.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
function sample(id, extra = {}) {
  const input = JSON.stringify({ author: { handle: '@a', name: 'A' }, text: `post ${id}` });
  const inputHash = sha(input);
  return { sampleId: `${id}.${inputHash.slice(0, 16)}`, postId: String(id), input, inputHash,
    observedAt: '2026-09-28T08:00:00.000Z', source: 'random-home', observedAction: { outcome: 'kept-unverified' }, ...extra };
}
const NOW = Date.parse('2026-09-29T08:00:00.000Z');
const file = (records, ageMs = 3_600_000, name = 'canary-home-20260928T080000.jsonl') =>
  ({ name, mtimeMs: NOW - ageMs, records });

test('a valid record has no problems and a tampered one is caught', () => {
  const ok = sample(1);
  assert.deepEqual(recordProblems(ok), []);
  assert.ok(recordProblems({ ...ok, input: ok.input.replace('post', 'edit') }).includes('input-hash-mismatch'));
  assert.ok(recordProblems({ ...ok, sampleId: '2.abc' }).includes('sample-id-mismatch'));
  assert.deepEqual(recordProblems({ ...ok, input: '' }), ['no-input']);
});

test('enough fresh, consistent random samples need no re-capture', () => {
  const records = Array.from({ length: 120 }, (_, i) => sample(i + 1));
  const report = summarise([file(records)], NOW);
  assert.equal(report.recaptureNeeded, false);
  assert.equal(report.randomSamples, 120);
  assert.ok(report.hoursUntilFirstExpiry > 100);
});

test('expired files, too few random samples and bad fingerprints all block', () => {
  const few = summarise([file([sample(1)])], NOW);
  assert.match(few.blocking.join(), /only 1 random/);
  const old = summarise([file(Array.from({ length: 120 }, (_, i) => sample(i + 1)), RETENTION_MS + 1)], NOW);
  assert.match(old.blocking.join(), /expired/);
  const broken = sample(1);
  broken.input = broken.input.replace('post', 'x');
  const bad = summarise([file([broken, ...Array.from({ length: 120 }, (_, i) => sample(i + 2))])], NOW);
  assert.match(bad.blocking.join(), /fingerprints/);
});

test('duplicates across files are counted once and hard samples stay separate', () => {
  const a = sample(1);
  const hard = sample(2, { source: 'hard-history', observedAction: { outcome: 'historical-hidden-unverified' } });
  const report = summarise([file([a, hard]), file([a], 0, 'canary-home-20260928T090000.jsonl')], NOW);
  assert.equal(report.uniqueSamples, 2);
  assert.equal(report.duplicates, 1);
  assert.equal(report.hardSamples, 1);
  assert.equal(report.randomSamples, 1);
});
