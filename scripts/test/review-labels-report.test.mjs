/** The report over an exported set of in-timeline review labels. Offline. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, parseReviewExport, renderMarkdown } from '../review-labels-report.mjs';

function record(id, state, overall, rules, ruleTags, extra = {}) {
  return {
    sampleId: id,
    inputHash: 'h',
    postId: id,
    threadId: id,
    overall,
    rules: ruleTags,
    valuable: false,
    revision: 1,
    source: 'in-timeline-assisted',
    at: 1,
    stateJson: JSON.stringify({ text: `post ${id}` }),
    snapshot: { state, direct: false, rulesFingerprint: 'f', rules },
    ...extra,
  };
}

const promo = (score, hit) => ({ ruleId: 'promo', score, threshold: 0.8, hit });

test('the report compares the filter with the person, per post and per rule', () => {
  const records = [
    record('1', 'flagged', 'hide', [promo(0.9, true)], [{ ruleId: 'promo', label: 'match' }]),
    record('2', 'flagged', 'keep', [promo(0.85, true)], [{ ruleId: 'promo', label: 'no-match' }]),
    record('3', 'kept', 'hide', [promo(0.6, false)], [{ ruleId: 'promo', label: 'match' }]),
    record('4', 'kept', 'keep', [promo(0.1, false)], []),
    record('5', 'kept', 'uncertain', [promo(0.5, false)], []),
    record('6', 'kept', null, [promo(0.5, false)], [], { valuable: true }),
    record('7', 'kept', 'hide', [], [], { noRuleCovers: 'a scam no rule names' }),
  ];
  const report = buildReport(records);
  assert.equal(report.total, 7);
  assert.equal(report.judged, 6);
  assert.equal(report.valuableOnly, 1);
  assert.deepEqual(report.byOverall, { hide: 3, keep: 2, uncertain: 1 });
  assert.equal(report.postLevel.compared, 5, 'an uncertain verdict is not compared');
  assert.equal(report.postLevel.agree, 2);
  assert.deepEqual(report.postLevel.overHidden.map((item) => item.sampleId), ['2']);
  assert.deepEqual(report.postLevel.missed.map((item) => item.sampleId), ['3', '7']);
  const stat = report.perRule.promo;
  assert.deepEqual([stat.tp, stat.fp, stat.fn, stat.tn], [1, 1, 1, 0]);
  assert.deepEqual(stat.fnScores, [0.6], 'a missed post shows how close it came to the threshold');
  assert.deepEqual(stat.fpScores, [0.85]);
  assert.equal(report.noRule.length, 1);
  assert.match(renderMarkdown(report), /辅助标注/);
});

test('only an AnyFilter review export is accepted', () => {
  assert.throws(() => parseReviewExport('{"kind":"other","records":[]}'));
  assert.deepEqual(parseReviewExport({ kind: 'anyfilter-review-labels', records: [] }), []);
});
