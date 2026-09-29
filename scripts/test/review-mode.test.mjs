/**
 * Review mode on the feed: posts stay visible and are decorated, nothing new is
 * asked of the provider, no setting changes, and leaving restores normal hiding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings } from '../../src/domain/settings';
import { FeedFilter } from '../../src/features/feed-filter';
import { installChrome, makePost } from './harness.mjs';

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeTimeline {
  constructor(posts) {
    this.posts = new Map(posts.map((post) => [post.id, post]));
    this.actions = [];
    this.decorations = new Map();
  }
  scan() { return [...this.posts.values()]; }
  read(id) { return this.posts.get(id) ?? null; }
  unmark() {}
  hide(id) { this.actions.push(['hide', id]); }
  show(id) { this.actions.push(['show', id]); }
  decorate(id, snapshot) { this.decorations.set(id, snapshot); this.actions.push(['decorate', id]); }
  clearDecoration(id) { this.decorations.delete(id); this.actions.push(['clear', id]); }
  onChange() { return () => {}; }
  count(kind) { return this.actions.filter(([action]) => action === kind).length; }
}

function fixture({ threadPosts = null, scoresFor } = {}) {
  installChrome({ local: {} });
  const settings = normalizeSettings({ keys: { vercel: 'k', typesafe: '' } });
  const bad = makePost({ id: '10', text: 'buy my course now' });
  const good = makePost({ id: '11', text: 'a post about compilers' });
  const view = new FakeTimeline(threadPosts ?? [bad, good]);
  const calls = [];
  const pendingResolvers = [];
  const classifier = {
    classify: async (post, questions) => {
      calls.push(post.id);
      if (scoresFor === 'defer') {
        return new Promise((resolve) => pendingResolvers.push(() => resolve({
          ok: true, scores: Object.fromEntries(Object.keys(questions).map((id) => [id, post.id === '10' && id === 'promo' ? 0.95 : 0.1])), tokens: 1,
        })));
      }
      return {
        ok: true,
        scores: Object.fromEntries(Object.keys(questions).map((id) => [id, post.id === '10' && id === 'promo' ? 0.95 : 0.1])),
        tokens: 1,
      };
    },
  };
  const filter = new FeedFilter(view, classifier, { report: () => {} }, settings);
  return { view, filter, calls, settings, bad, good, pendingResolvers };
}

test('with review mode on a flagged post is shown and decorated, never hidden', async () => {
  const { view, filter } = fixture();
  filter.setReviewMode(true);
  filter.start();
  await settle();
  assert.equal(view.count('hide'), 0);
  assert.equal(view.decorations.get('10').state, 'flagged');
  assert.equal(view.decorations.get('11').state, 'kept');
});

test('turning it on and off never asks the provider again or changes the settings', async () => {
  const { view, filter, calls, settings } = fixture();
  filter.start();
  await settle();
  const requests = calls.length;
  assert.ok(view.count('hide') > 0, 'normal mode hides the flagged post');
  view.actions.length = 0;

  filter.setReviewMode(true);
  await settle();
  assert.equal(view.count('hide'), 0);
  assert.equal(view.decorations.get('10').state, 'flagged');

  filter.setReviewMode(false);
  await settle();
  assert.equal(view.decorations.size, 0, 'decorations are cleared on exit');
  assert.ok(view.actions.some(([action, id]) => action === 'hide' && id === '10'), 'flagged post is hidden again');
  assert.equal(calls.length, requests, 'no new classification request');
  assert.equal(settings.filterOn, true);
  filter.setReviewMode(true);
  filter.setReviewMode(false);
  assert.equal(calls.length, requests);
});

test('a response that lands after leaving review mode does not decorate again', async () => {
  const { view, filter, pendingResolvers } = fixture({ scoresFor: 'defer' });
  filter.setReviewMode(true);
  filter.start();
  await settle();
  assert.equal(view.decorations.get('10').state, 'undecided');
  assert.equal(view.decorations.get('10').undecidedReason, 'pending');
  filter.setReviewMode(false);
  assert.equal(view.decorations.size, 0);
  for (const resolve of pendingResolvers) resolve();
  await settle();
  assert.equal(view.decorations.size, 0, 'late answers do not draw outside review mode');
  assert.ok(view.actions.some(([action, id]) => action === 'hide' && id === '10'), 'normal hiding resumes');
});

test('the filter being off shows no decoration and hides nothing', async () => {
  installChrome({ local: {} });
  const settings = normalizeSettings({ filterOn: false, keys: { vercel: 'k', typesafe: '' } });
  const post = makePost({ id: '12', text: 'buy my course now' });
  const view = new FakeTimeline([post]);
  const filter = new FeedFilter(view, { classify: async () => { throw new Error('no request expected'); } }, { report: () => {} }, settings);
  filter.setReviewMode(true);
  filter.start();
  await settle();
  assert.equal(view.decorations.size, 0);
  assert.equal(view.count('hide'), 0);
});

test('a thread with one flagged post decorates the others as thread-linked', async () => {
  const head = makePost({ id: '20', thread: 't', text: 'buy my course now' });
  const reply = makePost({ id: '21', thread: 't', text: 'a post about compilers' });
  const scores = (post, questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, post.id === '20' && id === 'promo' ? 0.95 : 0.1]));
  installChrome({ local: {} });
  const settings = normalizeSettings({ keys: { vercel: 'k', typesafe: '' } });
  const view = new FakeTimeline([head, reply]);
  const filter = new FeedFilter(view, { classify: async (post, questions) => ({ ok: true, scores: scores(post, questions), tokens: 1 }) }, { report: () => {} }, settings);
  filter.setReviewMode(true);
  filter.start();
  await settle();
  assert.deepEqual([view.decorations.get('20').state, view.decorations.get('20').direct], ['flagged', true]);
  assert.deepEqual([view.decorations.get('21').state, view.decorations.get('21').direct], ['flagged', false]);
  assert.equal(view.count('hide'), 0);
});
