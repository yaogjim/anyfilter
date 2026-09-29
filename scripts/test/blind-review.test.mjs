/**
 * Blind review (offline): labels are per sample+rule to match the
 * `RuleEvaluation` contract, the HTML must reveal only the captured state and
 * the rule spec, and the CLI must reject duplicate/unknown IDs and must never
 * overwrite an existing human label. All data here is synthetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATES,
  recordKey,
  loadQueue,
  parseRuleSpec,
  indexSamples,
  selectBlindEntries,
  renderHtml,
  buildTemplate,
  validateSubmission,
  storeKeys,
  mergeReviews,
} from '../blind-review.mjs';
// The authoritative rule source: the code the app actually ships.
import { BUILT_IN_CATEGORIES } from '../../src/domain/category';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'blind-review.mjs');
const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'filter-rules.md');
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');

const SYNTHETIC_SPEC = `# Rules

## 2. Boundaries
drop-before

## 3. The ten rules

Status text.

### 1. Ads — \`ads\` (local)

- **Definition.** A promoted post.
- **Inputs.** Page signals only.

### 3. Promo / selling — \`promo\` (semantic)

- **Definition.** Selling a product.

## 4. Preview
drop-after
`;

function makeQueue() {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    totals: { all: 4, random: 2, holdout: 2, diagnostic: 2, historyOnly: 0 },
    blindRandomHoldoutIds: ['holdout-1', 'holdout-2'],
    hiddenDiagnosticIds: ['hidden-1', 'hidden-2'],
    keptDiagnosticIds: ['kept-1', 'kept-2'],
    records: [
      { sampleId: 'holdout-1', outcome: 'SENTINEL-OUTCOME-holdout', machines: 'SENTINEL-MACHINE', groupHash: 'SENTINEL-GROUP' },
      { sampleId: 'hidden-1', outcome: 'SENTINEL-OUTCOME-hidden', machines: 'SENTINEL-MACHINE', groupHash: 'SENTINEL-GROUP' },
    ],
  };
}

function row(sampleId, state) {
  return JSON.stringify({
    sampleId,
    postId: 'p-' + sampleId,
    input: JSON.stringify(state),
    observedAction: { outcome: 'SENTINEL-OUTCOME-machine', reasons: ['SENTINEL-JEV-SCORE'], shownByUser: true },
  });
}

function makeFiles() {
  return [
    {
      name: 'canary-home-20260101T000000.jsonl',
      content: [
        JSON.stringify({ type: 'batch', sampleCount: 4 }),
        row('holdout-1', { author: { handle: '@SENTINEL-AUTHOR', name: 'SENTINEL-NAME' }, text: 'TEXT-HOLDOUT-ONE', quoted: 'QUOTE-HOLDOUT-ONE' }),
        row('holdout-2', { author: { handle: '@a' }, text: 'TEXT-HOLDOUT-TWO', replyingTo: { author: '@parent', text: 'TEXT-PARENT-TWO' } }),
        row('kept-1', { text: 'TEXT-KEPT-ONE' }),
        row('hidden-1', { text: 'TEXT-HIDDEN-ONE' }),
      ].join('\n') + '\n',
    },
    {
      name: 'hard-history-20260101T000000.jsonl',
      content: [
        JSON.stringify({ type: 'batch', source: 'hard-history', sampleCount: 2 }),
        row('hidden-2', { text: 'TEXT-HIDDEN-TWO' }),
        row('kept-2', { text: 'TEXT-KEPT-TWO' }),
        row('unknown-99', { text: 'TEXT-UNKNOWN-NINETY-NINE' }),
      ].join('\n') + '\n',
    },
  ];
}

function syntheticRules() {
  return parseRuleSpec(SYNTHETIC_SPEC);
}

test('parseRuleSpec reads ids from the heading token, never the ordinal', () => {
  const rules = syntheticRules();
  assert.deepEqual(rules.map((rule) => rule.id), ['ads', 'promo']);
  assert.deepEqual(rules.map((rule) => rule.kind), ['local', 'semantic']);
  assert.deepEqual(rules.map((rule) => rule.label), ['Ads', 'Promo / selling']);
  assert.equal(rules[0].notes[0].key, 'Definition');
  assert.equal(rules[1].notes[0].value, 'Selling a product.');
});

test('the doc-parsed rule ids equal the code built-in ids', () => {
  const fromDocs = parseRuleSpec(readFileSync(DOCS, 'utf8')).map((rule) => rule.id).sort();
  const fromCode = BUILT_IN_CATEGORIES.map((category) => category.id).sort();
  assert.deepEqual(fromDocs, fromCode);
  assert.equal(fromDocs.length, 10);
});

test('parseRuleSpec rejects a spec whose ids are unsafe or duplicated', () => {
  assert.throws(() => parseRuleSpec('## 3. R\n\n### 1. X — `bad id` (semantic)\n'), /plain id/);
  assert.throws(() => parseRuleSpec('## 3. R\n\n### 1. A — `dup` (semantic)\n\n### 2. B — `dup` (semantic)\n'), /duplicate rule id/);
  assert.throws(() => parseRuleSpec('# none\n'), /not found/);
});

test('indexSamples exposes only state context and flags unknown keys', () => {
  const { index, unknownKeys } = indexSamples(makeFiles());
  assert.deepEqual(unknownKeys, [], 'all synthetic state keys are known');
  assert.deepEqual(Object.keys(index.get('holdout-1')).sort(), ['author', 'quoted', 'replyingTo', 'text']);
  assert.equal(index.get('holdout-2').replyingTo.text, 'TEXT-PARENT-TWO');
  // indexSamples indexes every row; queue membership is applied later.
  assert.ok(index.has('unknown-99'));

  const { unknownKeys: flagged } = indexSamples([
    { name: 'x', content: JSON.stringify({ type: 'batch' }) + '\n' + row('s1', { text: 't', jev: 'SENTINEL' }) },
  ]);
  assert.deepEqual(flagged, ['jev']);
});

test('selectBlindEntries keeps holdout/diagnostic split and machine fields out', () => {
  const queue = loadQueue(makeQueue());
  const { index } = indexSamples(makeFiles());
  const { entries, missing } = selectBlindEntries(queue, index);

  assert.deepEqual(missing, []);
  assert.equal(entries.length, 6);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['author', 'group', 'quoted', 'replyingTo', 'sampleId', 'text']);
  }
  assert.deepEqual(entries.filter((e) => e.group === 'holdout').map((e) => e.sampleId), ['holdout-1', 'holdout-2']);
  const expected = ['hidden-1', 'hidden-2', 'kept-1', 'kept-2'].sort((a, b) => sha(a).localeCompare(sha(b)));
  assert.deepEqual(entries.filter((e) => e.group === 'diagnostic').map((e) => e.sampleId), expected);
  const flat = JSON.stringify(entries);
  for (const sentinel of ['SENTINEL-OUTCOME', 'SENTINEL-MACHINE', 'SENTINEL-GROUP', 'SENTINEL-JEV-SCORE']) {
    assert.ok(!flat.includes(sentinel));
  }
});

test('selectBlindEntries reports blind ids that have no sample row', () => {
  const queue = loadQueue(makeQueue());
  const { index } = indexSamples([{ name: 'canary-home-20260101T000000.jsonl', content: JSON.stringify({ type: 'batch' }) + '\n' }]);
  const { entries, missing } = selectBlindEntries(queue, index);
  assert.equal(entries.length, 0);
  assert.equal(missing.length, 6);
});

test('renderHtml embeds per-sample state, the rule spec, and no machine sentinel', () => {
  const queue = loadQueue(makeQueue());
  const { index } = indexSamples(makeFiles());
  const { entries } = selectBlindEntries(queue, index);
  const html = renderHtml(entries, { rules: syntheticRules(), generatedAt: '2026-01-01T00:00:00.000Z' });

  assert.ok(html.includes('TEXT-HOLDOUT-ONE'));
  assert.ok(html.includes('QUOTE-HOLDOUT-ONE'));
  assert.ok(html.includes('TEXT-PARENT-TWO'));
  assert.ok(html.includes('<script id="blind-data"'));
  for (const sentinel of ['SENTINEL-OUTCOME', 'SENTINEL-MACHINE', 'SENTINEL-GROUP', 'SENTINEL-JEV-SCORE', 'shownByUser', 'observedAction', 'outcome']) {
    assert.ok(!html.includes(sentinel), `html must not contain ${sentinel}`);
  }
  const match = html.match(/<script id="blind-data" type="application\/json">([\s\S]*?)<\/script>/);
  const data = JSON.parse(match[1].replace(/\\u003c/g, '<'));
  assert.deepEqual(data.states, STATES);
  assert.deepEqual(data.rules.map((rule) => rule.id), ['ads', 'promo']);
  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), ['author', 'group', 'quoted', 'replyingTo', 'sampleId', 'text']);
  }
  // One radio group per sample+rule, so multiple rules can hit the same sample.
  assert.ok(html.includes("input.name = 's-' + item.sampleId + '-r-' + rule.id"));
});

test('renderHtml cannot be broken out of by post text', () => {
  const html = renderHtml(
    [{ sampleId: 'x', group: 'holdout', author: null, text: '</script><script>alert(1)</script>', quoted: '', replyingTo: null }],
    { rules: syntheticRules(), generatedAt: 'now' },
  );
  assert.ok((html.match(/<script/g) || []).length <= 3, 'post text does not add script tags');
  assert.ok(html.includes('\\u003c/script'));
});

test('buildTemplate carries one empty row per sample+rule', () => {
  const template = buildTemplate([{ sampleId: 'a', group: 'holdout' }], syntheticRules(), 'now');
  assert.equal(template.annotations.length, 2);
  assert.deepEqual(template.annotations.map((a) => `${a.sampleId}:${a.ruleId}`), ['a:ads', 'a:promo']);
  assert.equal(template.annotations.every((a) => a.state === ''), true);
  assert.deepEqual(template.states, STATES);
});

test('validateSubmission keys on sample+rule and rejects bad rows', () => {
  const blindSampleIds = new Set(['a', 'b']);
  const ruleIds = new Set(['ads', 'promo']);
  const { accepted, rejected } = validateSubmission(
    {
      annotations: [
        { sampleId: 'a', ruleId: 'ads', state: 'match', reason: 'ok', group: 'holdout' },
        { sampleId: 'a', ruleId: 'promo', state: 'no-match', group: 'holdout' },
        { sampleId: 'a', ruleId: 'ads', state: 'no-match' },
        { sampleId: 'zzz', ruleId: 'ads', state: 'match' },
        { sampleId: 'a', ruleId: 'ghost', state: 'match' },
        { sampleId: 'b', ruleId: 'ads', state: 'match', group: 'holdout' },
        { sampleId: 'b', ruleId: 'ads', state: 'sideways', group: 'diagnostic' },
        { sampleId: 'b', ruleId: 'promo' },
      ],
    },
    { blindSampleIds, groupBySample: new Map([['a', 'holdout'], ['b', 'diagnostic']]), ruleIds, existingKeys: new Set() },
  );
  assert.deepEqual(accepted.map((entry) => `${entry.sampleId}:${entry.ruleId}`), ['a:ads', 'a:promo']);
  assert.deepEqual(rejected.map((entry) => entry.reason).sort(), [
    'bad-state', 'duplicate-in-submission', 'empty-state', 'group-mismatch', 'unknown-rule', 'unknown-sample',
  ]);
});

test('validateSubmission refuses to overwrite an existing sample+rule label', () => {
  const args = { blindSampleIds: new Set(['a']), ruleIds: new Set(['ads']) };
  const existingKeys = new Set([recordKey('a', 'ads')]);
  const blocked = validateSubmission({ annotations: [{ sampleId: 'a', ruleId: 'ads', state: 'no-match' }] }, { ...args, existingKeys });
  assert.equal(blocked.accepted.length, 0);
  assert.equal(blocked.rejected[0].reason, 'already-reviewed');
  const allowed = validateSubmission({ annotations: [{ sampleId: 'a', ruleId: 'ads', state: 'no-match' }] }, { ...args, existingKeys, allowRereview: true });
  assert.equal(allowed.accepted.length, 1);
});

test('mergeReviews nests records per sample and never drops an existing label', () => {
  const store = mergeReviews(null, [{ sampleId: 'a', ruleId: 'ads', state: 'match', reason: 'first' }], { now: 't0' });
  assert.equal(store.version, 2);
  assert.equal(store.records.a.ads.state, 'match');
  assert.deepEqual([...storeKeys(store)], [recordKey('a', 'ads')]);

  const merged = mergeReviews(store, [{ sampleId: 'a', ruleId: 'promo', state: 'undecided', reason: 'second' }], { now: 't1' });
  assert.equal(merged.records.a.ads.state, 'match');
  assert.equal(merged.records.a.ads.reason, 'first');
  assert.equal(merged.records.a.promo.state, 'undecided');
});

test('CLI prepare then apply is per-rule and never leaks text to stdout', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blind-review-'));
  try {
    writeFileSync(path.join(dir, 'review-queue.json'), JSON.stringify(makeQueue()));
    for (const file of makeFiles()) writeFileSync(path.join(dir, file.name), file.content);
    const specPath = path.join(dir, 'filter-rules.md');
    writeFileSync(specPath, SYNTHETIC_SPEC);

    const prepare = spawnSync(process.execPath, [SCRIPT, 'prepare', '--dir', dir, '--rules', specPath], { encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    const summary = JSON.parse(prepare.stdout);
    assert.equal(summary.entries, 6);
    assert.equal(summary.rules, 2);
    assert.equal(summary.totalPairs, 12);
    assert.equal(summary.withQuoted, 1);
    assert.equal(summary.withParent, 1);
    assert.ok(!prepare.stdout.includes('TEXT-HOLDOUT'), 'stdout has no post text');
    assert.ok(existsSync(path.join(dir, 'blind-review.html')));
    assert.ok(existsSync(path.join(dir, 'annotations-template.json')));

    const submission = path.join(dir, 'submission.json');
    writeFileSync(submission, JSON.stringify({ annotations: [
      { sampleId: 'not-blind', ruleId: 'ads', state: 'match' },
      { sampleId: 'holdout-1', ruleId: 'ghost', state: 'match' },
      { sampleId: 'holdout-1', ruleId: 'ads', group: 'holdout', state: 'no-match', reason: 'ok' },
    ] }));
    const apply = spawnSync(process.execPath, [SCRIPT, 'apply', submission, '--dir', dir, '--rules', specPath], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    const report = JSON.parse(apply.stdout);
    assert.equal(report.accepted, 1);
    assert.equal(report.rejectReasons['unknown-sample'], 1);
    assert.equal(report.rejectReasons['unknown-rule'], 1);

    // Re-applying cannot overwrite the stored sample+rule label.
    const again = spawnSync(process.execPath, [SCRIPT, 'apply', submission, '--dir', dir, '--rules', specPath], { encoding: 'utf8' });
    const second = JSON.parse(again.stdout);
    assert.equal(second.accepted, 0);
    assert.equal(second.rejectReasons['already-reviewed'], 1);
    assert.equal(second.storeRecords, 1);

    const store = JSON.parse(readFileSync(path.join(dir, 'human-labels.json'), 'utf8'));
    assert.equal(store.records['holdout-1'].ads.state, 'no-match');

    const verify = spawnSync(process.execPath, [SCRIPT, 'verify', '--dir', dir], { encoding: 'utf8' });
    const verified = JSON.parse(verify.stdout);
    assert.equal(verified.storeRecords, 1);
    assert.deepEqual(verified.byState, { 'no-match': 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('parseRuleSpec joins a wrapped bullet into one sentence', () => {
  const rules = parseRuleSpec('## 3. R\n\n### 1. A — `a` (semantic)\n\n- **Limits.** First part\n  second part\n  third part.\n- **Inputs.** Text.\n');
  assert.equal(rules[0].notes[0].value, 'First part second part third part.');
  assert.equal(rules[0].notes[1].value, 'Text.');
});

test('suggested defaults are embedded only when supplied and keep provenance on apply', () => {
  const { index } = indexSamples(makeFiles());
  const { entries } = selectBlindEntries(loadQueue(makeQueue()), index);
  const rules = syntheticRules();
  const plain = renderHtml(entries, { rules, generatedAt: 'x' });
  assert.ok(plain.includes('"suggested":{}'));
  const suggestions = { model: 'm-x', records: { [entries[0].sampleId]: { ads: { state: 'match', reason: 'because' }, promo: { state: 'bogus' } } } };
  const html = renderHtml(entries, { rules, generatedAt: 'x', suggestions });
  assert.ok(html.includes('"suggestionModel":"m-x"'));
  assert.ok(html.includes('"reason":"because"'));
  assert.ok(!html.includes('bogus'), 'an unknown state is dropped, not embedded');
  const { accepted } = validateSubmission(
    { annotations: [{ sampleId: entries[0].sampleId, ruleId: 'ads', state: 'no-match', suggested: 'match' }] },
    { blindSampleIds: new Set([entries[0].sampleId]), ruleIds: new Set(['ads']), existingKeys: new Set() },
  );
  assert.equal(accepted[0].suggestedState, 'match');
  const store = mergeReviews(null, accepted);
  assert.equal(store.records[entries[0].sampleId].ads.suggestedState, 'match');
  assert.equal(store.records[entries[0].sampleId].ads.state, 'no-match');
});
