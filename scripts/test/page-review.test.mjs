/**
 * The box review mode draws on a judged page: what it says, and when it says nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageReviewData } from '../../src/infrastructure/page-review';

const judged = (outcomes, top = null) => ({ kind: 'judged', truncated: false, paywall: false, outcomes, top });

test('a page that is not an article has nothing to review', () => {
  assert.equal(pageReviewData('en', { kind: 'not-article', reason: 'too-short' }), null);
});

test('a page nothing matched says so, in the kept colour', () => {
  const data = pageReviewData('en', judged([
    { rule: 'marketing', status: 'no-match', probability: 0.1 },
    { rule: 'clickbait', status: 'no-match', probability: 0.2 },
  ]));
  assert.equal(data.tone, 'kept');
  assert.match(data.headline, /No rule matched/);
  assert.equal(data.lines.length, 2);
  assert.match(data.lines[0], /marketing: 10% · threshold 40%/);
  assert.match(data.lines[1], /clickbait: 20% · threshold 50%/);
});

test('a match names the rule with its own threshold, not the default', () => {
  const top = { rule: 'marketing', status: 'match', probability: 0.45 };
  const data = pageReviewData('en', judged([top, { rule: 'clickbait', status: 'no-match', probability: 0.05 }], top));
  assert.equal(data.tone, 'flagged');
  assert.match(data.headline, /marketing · 45% \(threshold 40%\)/);
});

test('an undecided rule is not shown as a zero', () => {
  const data = pageReviewData('en', judged([
    { rule: 'marketing', status: 'undetermined', reason: 'no-answer' },
    { rule: 'clickbait', status: 'no-match', probability: 0.2 },
  ]));
  assert.match(data.lines[0], /marketing: not decided/);
  assert.doesNotMatch(data.lines[0], /0%/);
});

test('the text follows the interface language', () => {
  const data = pageReviewData('zh-CN', judged([{ rule: 'marketing', status: 'no-match', probability: 0.1 }]));
  assert.match(data.title, /复核模式/);
});
