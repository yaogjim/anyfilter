/**
 * The Hacker News side that needs no browser: which pages are read, which of the
 * person's rules apply to a headline, and the `Post` a row becomes. The DOM read is
 * covered by `pnpm e2e:hn` against a real page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HN_RULE_IDS,
  hnItemUrl,
  hnPost,
  hnRulesOf,
  hnSettings,
  hnSiteOf,
  hnTextOf,
  isHnListingPath,
  isHnPostId,
} from '../../src/domain/hn';
import { authorUrl, isPost, postContentKey, postSource, postUrl } from '../../src/domain/post';
import { builtInRules } from '../../src/domain/rule';
import { compileRules } from '../../src/domain/rule-compiler';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { matchRuleReasons } from '../../src/domain/verdict';
import { makePost } from './harness.mjs';

const item = { id: '49901736', title: 'Livenerf: Has Opus 5.5 been nerfed yet?', site: 'github.com', user: 'bryan0' };

test('only the list pages are read; an item page, comments and jobs are not', () => {
  for (const path of ['/', '/news', '/newest', '/front', '/ask', '/show', '/shownew', '/best', '/active', '/classic', '/from', '/submitted', '/over', '/news/']) {
    assert.equal(isHnListingPath(path), true, path);
  }
  for (const path of ['/item', '/jobs', '/user', '/threads', '/newcomments', '/login', '/reply', '/submit', '/hide', '/news2', '/newest/x']) {
    assert.equal(isHnListingPath(path), false, path);
  }
});

test('the rules that apply are the headline ones, in the state the person left them', () => {
  const custom = (id, scope, enabled = true) => ({
    id, label: id, source: 'custom', kind: 'semantic', enabled, include: 'Is this about X?',
    exclude: '', examplesYes: [], examplesNo: [], scope,
  });
  const rules = [...builtInRules(), custom('custom:a', 'all'), custom('custom:b', 'replies'), custom('custom:c', 'all', false)];
  const applicable = hnRulesOf(rules);
  assert.deepEqual(
    applicable.filter((rule) => rule.source === 'builtin').map((rule) => rule.id).sort(),
    [...HN_RULE_IDS].sort(),
  );
  for (const left of ['ads', 'bait', 'hate', 'porn', 'spam', 'promo']) {
    assert.equal(applicable.some((rule) => rule.id === left), false, `${left} is not asked about a headline`);
  }
  assert.deepEqual(applicable.filter((rule) => rule.source === 'custom').map((rule) => rule.id), ['custom:a', 'custom:c']);
  assert.equal(applicable.find((rule) => rule.id === 'custom:c').enabled, false, 'a rule the person turned off stays off');
});

test('a rule the person disabled is not asked, and a disabled politics rule never hides a title', () => {
  const off = builtInRules().map((rule) => (rule.id === 'politics' ? { ...rule, enabled: false } : rule));
  const settings = hnSettings({ ...DEFAULT_SETTINGS, rules: off });
  assert.equal('politics' in compileRules(settings.rules).questions, false);
  const reasons = matchRuleReasons(hnPost(item), { politics: 0.99, nsfw: 0.1 }, settings.rules, settings.threshold);
  assert.deepEqual(reasons, []);
});

test('a political title is matched by the politics rule at the usual threshold', () => {
  const settings = hnSettings(DEFAULT_SETTINGS);
  const questions = compileRules(settings.rules).questions;
  assert.deepEqual(Object.keys(questions).sort(), [...HN_RULE_IDS].sort());
  const hit = matchRuleReasons(hnPost(item), { politics: 0.97 }, settings.rules, settings.threshold);
  assert.deepEqual(hit.map((reason) => reason.categoryId), ['politics']);
  assert.deepEqual(matchRuleReasons(hnPost(item), { politics: 0.6 }, settings.rules, settings.threshold), []);
});

test('the link host is shown without www, and is empty when the link stays on the site', () => {
  assert.equal(hnSiteOf('https://www.nytimes.com/2026/x'), 'nytimes.com');
  assert.equal(hnSiteOf('https://github.com/a/b'), 'github.com');
  assert.equal(hnSiteOf('item?id=1'), '');
  assert.equal(hnSiteOf('https://news.ycombinator.com/item?id=1'), '');
  assert.equal(hnSiteOf('javascript:alert(1)'), '');
  assert.equal(hnSiteOf(''), '');
});

test('what is sent is the title and where it links, with whitespace tidied, and nothing else', () => {
  assert.equal(hnTextOf(item), 'Livenerf: Has Opus 5.5 been nerfed yet? (github.com)');
  assert.equal(hnTextOf({ ...item, site: '' , title: '  Ask HN:   how do you\n read? ' }), 'Ask HN: how do you read?');
});

test('a row becomes a post with a site-specific id, link and author page', () => {
  const post = hnPost(item);
  assert.equal(post.id, 'hn:49901736');
  assert.equal(isHnPostId(post.id), true);
  assert.equal(isHnPostId('49901736'), false, 'an X id is not an HN id');
  assert.equal(postSource(post), 'hn');
  assert.equal(postUrl(post), 'https://news.ycombinator.com/item?id=49901736');
  assert.equal(postUrl(post), hnItemUrl('49901736'));
  assert.equal(authorUrl(post), 'https://news.ycombinator.com/user?id=bryan0');
  assert.equal(isPost(post), true);
  assert.equal(post.kind, 'post');
  assert.equal(post.parent, null);
});

test('an X post is unchanged: same link, same author page, same content key as before', () => {
  const post = makePost({ id: '1001', handle: 'ada', text: 'hello' });
  assert.equal(postSource(post), 'x');
  assert.equal(postUrl(post), 'https://x.com/ada/status/1001');
  assert.equal(authorUrl(post), 'https://x.com/ada');
  const expected = JSON.stringify([
    post.kind, post.own, post.promoted, post.name, post.handle, post.text, post.truncated,
    post.quotedName, post.quotedText, post.hasVideo, post.imageUrls, post.thread, null,
  ]);
  assert.equal(postContentKey(post), expected, 'storing scores under this key keeps working');
  assert.notEqual(postContentKey({ ...post, source: 'hn' }), expected);
});

test('a post with a made-up source or a non-string link is refused', () => {
  const post = hnPost(item);
  assert.equal(isPost({ ...post, source: 'reddit' }), false);
  assert.equal(isPost({ ...post, url: 5 }), false);
  assert.equal(isPost(makePost({})), true, 'an X post with neither field is still valid');
});
