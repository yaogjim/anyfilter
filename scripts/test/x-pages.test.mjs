/**
 * The page gate for the feed filter and review mode. It decides, from the path
 * alone, whether a page is a stream of posts we read and mark.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { xPageOf } from '../../src/domain/capture';
import { isFilteredPage, xFeedPageOf } from '../../src/domain/x-pages';

test('the original three surfaces keep their classification', () => {
  assert.equal(xFeedPageOf('/home'), 'home');
  assert.equal(xFeedPageOf('/home/'), 'home');
  assert.equal(xFeedPageOf('/search'), 'search');
  assert.equal(xFeedPageOf('/ada/status/1001'), 'status');
  assert.equal(xFeedPageOf('/ada/status/1001/photo/1'), 'status');
});

test('a profile is only the Posts tab', () => {
  assert.equal(xFeedPageOf('/FleischmanMena'), 'profile');
  assert.equal(xFeedPageOf('/FleischmanMena/'), 'profile');
  assert.equal(xFeedPageOf('/a_b_1'), 'profile');
  for (const tab of ['with_replies', 'media', 'likes', 'highlights', 'followers', 'following', 'articles']) {
    assert.equal(xFeedPageOf(`/FleischmanMena/${tab}`), null, tab);
  }
});

test('routes that only look like a handle are not profiles', () => {
  for (const root of ['explore', 'notifications', 'messages', 'settings', 'compose', 'i', 'Bookmarks', 'communities', 'grok']) {
    assert.equal(xFeedPageOf(`/${root}`), null, root);
  }
  assert.equal(xFeedPageOf('/'), null);
  assert.equal(xFeedPageOf(''), null);
});

test('handles longer than X allows are not profiles', () => {
  assert.equal(xFeedPageOf('/abcdefghijklmnop'), null);
  assert.equal(xFeedPageOf('/abcdefghijklmno'), 'profile');
  assert.equal(xFeedPageOf('/not-a-handle'), null);
});

test('a list is the list timeline, not its members or followers', () => {
  assert.equal(xFeedPageOf('/i/lists/1585430245762441216'), 'list');
  assert.equal(xFeedPageOf('/i/lists/1585430245762441216/'), 'list');
  assert.equal(xFeedPageOf('/i/lists/1585430245762441216/members'), null);
  assert.equal(xFeedPageOf('/i/lists/1585430245762441216/followers'), null);
  assert.equal(xFeedPageOf('/i/lists'), null);
  assert.equal(xFeedPageOf('/i/lists/abc'), null);
  assert.equal(xFeedPageOf('/i/bookmarks'), null);
});

test('isFilteredPage agrees with the classification', () => {
  assert.equal(isFilteredPage('/FleischmanMena'), true);
  assert.equal(isFilteredPage('/i/lists/1585430245762441216'), true);
  assert.equal(isFilteredPage('/notifications'), false);
});

test('verification capture stays narrower than filtering', () => {
  // Reading what is on screen is not the same as keeping it. A profile or a
  // list is filtered and reviewed but never adds a verification sample.
  assert.equal(xPageOf('https://x.com/FleischmanMena'), null);
  assert.equal(xPageOf('https://x.com/i/lists/1585430245762441216'), null);
  assert.equal(xPageOf('https://x.com/home'), 'home');
});
