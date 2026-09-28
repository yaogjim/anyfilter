/**
 * Text preview isolation: the preview must share the feed's compiler, send the
 * same text/context, and leave zero trace in panel state, overrides, the score
 * cache or the DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtInRules } from '../../src/domain/rule';
import { compileRules } from '../../src/domain/rule-compiler';
import { normalizeSettings } from '../../src/domain/settings';
import { previewRules } from '../../src/infrastructure/rule-preview';
import { installChrome, installFetch, jsonResponse, vercelAnswers, VERCEL_URL } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';

function withKey(overrides = {}) {
  return normalizeSettings({ keys: { vercel: 'vck_preview', typesafe: '' }, ...overrides });
}

/** One score per compiled question, so the provider response is complete. */
function allScores(rules, score) {
  const ids = Object.keys(compileRules(rules).questions);
  return Object.fromEntries(ids.map((id) => [id, score]));
}

test('preview compiles the exact same instruction as the feed would send', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules();
  const compiled = compileRules(rules);
  const calls = installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.1))));

  const result = await previewRules({ text: 'hello world', rules, threshold: 0.7 });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, VERCEL_URL);
  assert.deepEqual(
    Object.keys(calls[0].body.questions).sort(),
    Object.keys(compiled.questions).sort(),
  );
  for (const [id, instruction] of Object.entries(compiled.questions)) {
    assert.equal(calls[0].body.questions[id].instructions, instruction);
  }
});

test('preview sends the text plus optional author, quote and parent context', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules();
  const calls = installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.1))));

  await previewRules({
    text: 'the body under test',
    name: 'Ada Lovelace',
    handle: 'ada',
    quotedText: 'a quoted post',
    parentText: 'the post being replied to',
    rules,
    threshold: 0.7,
  });

  const { state } = calls[0].body;
  assert.equal(state.text, 'the body under test');
  assert.deepEqual(state.author, { handle: '@ada', name: 'Ada Lovelace' });
  assert.equal(state.quoted, 'a quoted post');
  assert.deepEqual(state.replyingTo, { author: '', text: 'the post being replied to' });
});

test('a preview without extra context omits those fields entirely', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules();
  const calls = installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.1))));

  await previewRules({ text: 'just text', rules, threshold: 0.7 });

  assert.deepEqual(Object.keys(calls[0].body.state).sort(), ['text']);
});

test('preview writes neither panel state, overrides, nor the score cache', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules();
  const calls = installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.1))));
  const before = handle.snapshot();

  const result = await previewRules({ text: 'a post to test', rules, threshold: 0.7 });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(handle.snapshot(), before);
  assert.deepEqual(handle.sessionKeys(), []);
  // Runs in a DOM-less process: the preview path never needs a live page.
  assert.equal(typeof globalThis.document, 'undefined');
});

test('preview reports a missing answer as unavailable instead of a zero', async () => {
  const handle = installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules();
  const ids = Object.keys(compileRules(rules).questions);
  const missing = ids[0];
  const partial = Object.fromEntries(ids.slice(1).map((id) => [id, 0.1]));
  installFetch(() => jsonResponse(vercelAnswers(partial)));

  const result = await previewRules({ text: 'a post to test', rules, threshold: 0.7 });

  assert.equal(result.ok, true);
  const entry = result.results.find((item) => item.id === missing);
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.score, undefined);
  assert.deepEqual(
    result.results
      .filter((item) => item.status !== 'not-applicable' && item.id !== missing)
      .map((item) => item.score),
    ids.slice(1).map(() => 0.1),
  );
  assert.deepEqual(handle.sessionKeys(), []);
});

test('preview makes no request without a key', async () => {
  installChrome({ local: { [SETTINGS_KEY]: normalizeSettings({}) } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({})));

  const result = await previewRules({ text: 'a post', rules: builtInRules(), threshold: 0.7 });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-key');
  assert.equal(calls.length, 0);
});

test('preview rejects empty text and an incomplete rule list before any request', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const calls = installFetch(() => jsonResponse(vercelAnswers({})));

  const emptyText = await previewRules({ text: '   ', rules: builtInRules(), threshold: 0.7 });
  assert.equal(emptyText.ok, false);
  assert.equal(emptyText.error, 'invalid');

  const missingBuiltIn = await previewRules({
    text: 'x',
    rules: builtInRules().filter((rule) => rule.id !== 'crypto'),
    threshold: 0.7,
  });
  assert.equal(missingBuiltIn.ok, false);
  assert.equal(missingBuiltIn.error, 'invalid');
  assert.match(missingBuiltIn.detail, /missing built-in rule: crypto/);
  assert.equal(calls.length, 0);
});

test('the local ads rule and a replies-scope rule are marked not applicable', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules().map((rule) =>
    rule.id === 'spam' ? { ...rule, scope: 'replies' } : rule,
  );
  const calls = installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.1))));

  const withoutParent = await previewRules({ text: 'a top-level post', rules, threshold: 0.7 });
  assert.equal(withoutParent.results.find((item) => item.id === 'ads').status, 'not-applicable');
  assert.equal(withoutParent.results.find((item) => item.id === 'spam').status, 'not-applicable');

  const withParent = await previewRules({
    text: 'a reply',
    parentText: 'the post above',
    rules,
    threshold: 0.7,
  });
  assert.equal(withParent.results.find((item) => item.id === 'spam').status, 'no-match');
  assert.equal(calls.length, 2);
});

test('preview reports a disabled rule as not applicable and never asks about it', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules().map((rule) =>
    rule.id === 'bait' ? { ...rule, enabled: false } : rule,
  );
  const calls = installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.1))));

  const result = await previewRules({ text: 'a post', rules, threshold: 0.7 });

  assert.equal('bait' in calls[0].body.questions, false);
  assert.equal(result.results.find((item) => item.id === 'bait').status, 'not-applicable');
});

test('preview reports model probability and threshold, never an accuracy figure', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules();
  installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.9), { inputTokens: 321 })));

  const result = await previewRules({ text: 'a post', rules, threshold: 0.7 });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'typesafe-ai/jev');
  assert.equal(result.tokens, 321);
  assert.ok(result.results.every((item) => !('accuracy' in item)));

  const hit = result.results.find((item) => item.id === 'bait');
  assert.equal(hit.status, 'match');
  assert.equal(hit.score, 0.9);
  assert.equal(hit.threshold, 0.7);
});

test('a per-rule threshold overrides the global threshold in preview', async () => {
  installChrome({ local: { [SETTINGS_KEY]: withKey() } });
  const rules = builtInRules().map((rule) =>
    rule.id === 'bait' ? { ...rule, threshold: 0.95 } : rule,
  );
  installFetch(() => jsonResponse(vercelAnswers(allScores(rules, 0.9))));

  const result = await previewRules({ text: 'a post', rules, threshold: 0.7 });

  assert.equal(result.results.find((item) => item.id === 'bait').status, 'no-match');
  assert.equal(result.results.find((item) => item.id === 'hate').status, 'match');
});