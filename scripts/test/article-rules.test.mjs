/**
 * Single-article judgement, offline: the extraction shape check, the code gate,
 * the per-rule thresholds and the "undetermined is not no-match" rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTICLE_MIN_UNITS,
  ARTICLE_TEXT_CAP_UNITS,
  countUnits,
  headUnits,
  isExtractedArticle,
  stripSiteSuffix,
} from '../../src/domain/article';
import { checkArticleGate } from '../../src/domain/article-gate';
import {
  ARTICLE_RULES,
  articleQuestions,
  articleState,
  DEFAULT_ARTICLE_THRESHOLD,
  judgeArticle,
  READABLE_QUESTION_ID,
  READABLE_THRESHOLD,
} from '../../src/domain/article-rules';

function words(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

function article(overrides = {}) {
  const units = overrides.units ?? 800;
  return {
    url: 'https://example.com/blog/a-post',
    title: 'A post about things',
    author: '',
    site: '',
    published: '',
    description: '',
    language: 'en',
    headings: [],
    text: words(units),
    units,
    paywallDetected: false,
    ...overrides,
  };
}

const ruleOf = (id) => ARTICLE_RULES.find((rule) => rule.id === id);

test('every rule carries its own threshold; the default is only a fallback', () => {
  assert.equal(ruleOf('marketing').threshold, 0.4);
  assert.equal(ruleOf('clickbait').threshold, 0.5);
  assert.equal(DEFAULT_ARTICLE_THRESHOLD, 0.7);
  assert.equal(ARTICLE_RULES.length, 2);
});

test('units: words for spaced text, one per CJK character', () => {
  assert.equal(countUnits('hello big world'), 3);
  assert.equal(countUnits('科技爱好者周刊'), 7);
  assert.equal(countUnits('AI 缓存 cache'), 4);
  assert.equal(countUnits(''), 0);
});

test('headUnits keeps the start, cuts on a unit boundary and returns a short text whole', () => {
  assert.equal(headUnits('a b c d e', 3), 'a b c');
  assert.equal(headUnits('a b c', 10), 'a b c');
  assert.equal(headUnits('a b c', 3), 'a b c');
  assert.equal(headUnits('你好世界', 2), '你好');
  assert.equal(headUnits('anything', 0), '');
});

test('the site suffix is removed from a title, a real subtitle is not', () => {
  assert.equal(stripSiteSuffix('How it works - Example Blog'), 'How it works');
  assert.equal(stripSiteSuffix('How it works | Example'), 'How it works');
  assert.equal(stripSiteSuffix('Plain title'), 'Plain title');
});

test('an extraction from a page is accepted only in the exact shape', () => {
  assert.equal(isExtractedArticle(article()), true);
  assert.equal(isExtractedArticle(null), false);
  assert.equal(isExtractedArticle({ ...article(), units: -1 }), false);
  assert.equal(isExtractedArticle({ ...article(), units: 1.5 }), false);
  assert.equal(isExtractedArticle({ ...article(), headings: Array(31).fill('h') }), false);
  assert.equal(isExtractedArticle({ ...article(), title: 'x'.repeat(501) }), false);
  assert.equal(isExtractedArticle({ ...article(), paywallDetected: 'no' }), false);
  assert.equal(isExtractedArticle({ ...article(), text: 'x'.repeat(400_001) }), false);
  const { url: _url, ...withoutUrl } = article();
  assert.equal(isExtractedArticle(withoutUrl), false);
});

test('the gate refuses bot walls, root pages, sign-in pages and short pages', () => {
  assert.deepEqual(checkArticleGate(article()), { ok: true });
  assert.deepEqual(checkArticleGate(article({ title: 'Just a moment...' })), { ok: false, reason: 'blocked' });
  assert.deepEqual(checkArticleGate(article({ title: 'Attention Required! | Cloudflare' })), { ok: false, reason: 'blocked' });
  assert.deepEqual(checkArticleGate(article({ title: 'Access Denied' })), { ok: false, reason: 'blocked' });
  assert.deepEqual(checkArticleGate(article({ url: 'https://example.com/' })), { ok: false, reason: 'root-page' });
  assert.deepEqual(checkArticleGate(article({ url: 'https://example.com' })), { ok: false, reason: 'root-page' });
  assert.deepEqual(checkArticleGate(article({ url: 'not a url' })), { ok: false, reason: 'root-page' });
  assert.deepEqual(checkArticleGate(article({ url: 'https://example.com/account/login' })), { ok: false, reason: 'login-page' });
  assert.deepEqual(checkArticleGate(article({ url: 'https://example.com/users/sign_in' })), { ok: false, reason: 'login-page' });
  assert.deepEqual(checkArticleGate(article({ units: ARTICLE_MIN_UNITS - 1 })), { ok: false, reason: 'too-short' });
  assert.deepEqual(checkArticleGate(article({ units: ARTICLE_MIN_UNITS })), { ok: true });
});

test('a page about signing in is not a sign-in page, and a real page called "not found" is judged by title only at the start', () => {
  assert.deepEqual(checkArticleGate(article({ url: 'https://example.com/docs/auth/oauth' })), { ok: true });
  assert.deepEqual(checkArticleGate(article({ url: 'https://example.com/blog/login-flows-explained' })), { ok: true });
  // X is read by the feed filter; its pages are never judged as one article.
  for (const url of ['https://x.com/home', 'https://x.com/someone/status/123', 'https://mobile.twitter.com/someone/status/1']) {
    assert.deepEqual(checkArticleGate(article({ url })), { ok: false, reason: 'x-page' }, url);
  }
  assert.deepEqual(checkArticleGate(article({ url: 'https://box.com/blog/how-we-work' })), { ok: true }, 'a host merely ending in x.com is not X');
  assert.deepEqual(checkArticleGate(article({ title: 'Why "page not found" pages matter' })), { ok: true });
});

test('the questions asked are the two rules plus readability, and nothing else', () => {
  const questions = articleQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ['clickbait', 'marketing', READABLE_QUESTION_ID].sort());
  for (const text of Object.values(questions)) assert.ok(text.length > 30);
});

test('the state sent to the model is capped, suffix-stripped and marks truncation', () => {
  const long = article({ units: ARTICLE_TEXT_CAP_UNITS + 500, title: 'Deep dive - Example' });
  const state = articleState(long);
  assert.equal(state.title, 'Deep dive');
  assert.equal(state.truncated, true);
  assert.equal(state.word_count, ARTICLE_TEXT_CAP_UNITS + 500);
  assert.equal(countUnits(state.text), ARTICLE_TEXT_CAP_UNITS);
  const short = articleState(article({ units: 300 }));
  assert.equal(short.truncated, false);
  assert.equal(countUnits(short.text), 300);
});

test('a rule matches at its own threshold, not at the global default', () => {
  const at = (marketing, clickbait) => judgeArticle(article(), { readable: 0.9, marketing, clickbait });
  // marketing 0.45 is over its 0.4 threshold but under the 0.7 default.
  const v = at(0.45, 0.1);
  assert.equal(v.kind, 'judged');
  assert.equal(v.top?.rule, 'marketing');
  // 0.39 misses; 0.4 matches (threshold is inclusive).
  assert.equal(at(0.39, 0.1).top, null);
  assert.equal(at(0.4, 0.1).top?.rule, 'marketing');
  // clickbait needs 0.5.
  assert.equal(at(0.1, 0.49).top, null);
  assert.equal(at(0.1, 0.5).top?.rule, 'clickbait');
});

test('only the highest matching rule is the top one, all outcomes stay available', () => {
  const v = judgeArticle(article(), { readable: 0.9, marketing: 0.6, clickbait: 0.9 });
  assert.equal(v.kind, 'judged');
  assert.equal(v.top?.rule, 'clickbait');
  assert.equal(v.outcomes.length, 2);
  assert.deepEqual(
    v.outcomes.map((o) => o.status),
    ['match', 'match'],
  );
});

const FULL_TEXT_RULE = { id: 'clickbait', label: 'x', question: 'q', threshold: 0.5, needsFullText: true };

test('no shipped rule needs the whole text: a long page or a paywall does not blur a miss', () => {
  assert.ok(ARTICLE_RULES.every((rule) => rule.needsFullText === false));
  const long = judgeArticle(article({ units: ARTICLE_TEXT_CAP_UNITS + 1 }), { readable: 0.9, marketing: 0.05, clickbait: 0.1 });
  assert.equal(long.kind, 'judged');
  assert.deepEqual(long.outcomes.map((o) => o.status), ['no-match', 'no-match']);
});

test('a truncated page: a hit stands, a miss on a full-text rule is undetermined, not no-match', () => {
  const long = article({ units: ARTICLE_TEXT_CAP_UNITS + 1 });
  const rules = [FULL_TEXT_RULE];
  const missed = judgeArticle(long, { readable: 0.9, clickbait: 0.1 }, rules);
  assert.equal(missed.kind, 'judged');
  const clickbait = missed.outcomes.find((o) => o.rule === 'clickbait');
  assert.equal(clickbait?.status, 'undetermined');
  assert.equal(clickbait?.reason, 'truncated');
  const hit = judgeArticle(long, { readable: 0.9, clickbait: 0.8 }, rules);
  assert.equal(hit.top?.rule, 'clickbait');
});

test('a paywall preview is never read as a clean miss on a full-text rule', () => {
  const paywalled = judgeArticle(article({ paywallDetected: true }), { readable: 0.9, clickbait: 0.1 }, [FULL_TEXT_RULE]);
  assert.equal(paywalled.kind, 'judged');
  const clickbait = paywalled.outcomes.find((o) => o.rule === 'clickbait');
  assert.equal(clickbait?.status, 'undetermined');
  assert.equal(clickbait?.reason, 'paywall');
});

test('a missing or invalid answer is undetermined, never zero', () => {
  const v = judgeArticle(article(), { readable: 0.9, marketing: Number.NaN });
  assert.equal(v.kind, 'judged');
  for (const o of v.outcomes) {
    assert.equal(o.status, 'undetermined');
    assert.equal(o.reason, 'no-answer');
  }
  assert.equal(v.top, null);
  const out = judgeArticle(article(), { readable: 0.9, marketing: 1.4, clickbait: -0.2 });
  assert.equal(out.outcomes.every((o) => o.status === 'undetermined'), true);
});

test('the gate runs first: a page it refuses is never scored, whatever the model said', () => {
  const v = judgeArticle(article({ title: 'Just a moment...' }), { readable: 0.99, marketing: 0.99, clickbait: 0.99 });
  assert.deepEqual(v, { kind: 'not-article', reason: 'blocked' });
  const short = judgeArticle(article({ units: 50 }), { readable: 0.99, marketing: 0.99 });
  assert.deepEqual(short, { kind: 'not-article', reason: 'too-short' });
});

test('the model readability answer only refuses when it is fairly sure', () => {
  const low = judgeArticle(article(), { readable: READABLE_THRESHOLD - 0.01, marketing: 0.9 });
  assert.deepEqual(low, { kind: 'not-article', reason: 'model' });
  // A real weekly digest scored 0.29 in the trials; it must still be judged.
  const digest = judgeArticle(article(), { readable: 0.29, marketing: 0.05, clickbait: 0.05 });
  assert.equal(digest.kind, 'judged');
  // No answer at all does not refuse the page.
  assert.equal(judgeArticle(article(), { marketing: 0.05, clickbait: 0.05 }).kind, 'judged');
});
