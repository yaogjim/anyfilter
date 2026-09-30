/**
 * Drafting a rule with the assistant model: the model's answer is untrusted and
 * read strictly; one request is sent, only when there is a key, carrying only the
 * requirement and category names; every failure is mapped and leaves nothing
 * behind; and only one of our own pages may ask.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRuntimeMessage } from '../../src/domain/messages';
import {
  GENERATE_MAX_OUTPUT_TOKENS,
  isGenerateRuleInput,
  isGenerateRuleResult,
  MAX_REQUIREMENT_LENGTH,
  parseGeneratedDraft,
  requirementProblem,
  uniqueRuleLabel,
} from '../../src/domain/rule-draft';
import { MAX_EXAMPLES_PER_SIDE, MAX_INCLUDE_LENGTH, MAX_LABEL_LENGTH } from '../../src/domain/rule';
import { normalizeSettings } from '../../src/domain/settings';
import { generateRuleDraft } from '../../src/infrastructure/rule-generator';
import { extensionPageSender, installChrome, installFetch, jsonResponse, webPageSender, xContentSender } from './harness.mjs';

const SETTINGS_KEY = 'anyfilter.settings';
const KEYS_KEY = 'anyfilter.evaluation.keys';
const SECRET = 'sk-unit-test-secret';

const GOOD = {
  label: 'Course sellers',
  group: 'Marketing',
  include: 'Is this post mainly selling or promoting a paid course?',
  exclude: 'the post only shares free learning material',
  examplesYes: ['Join my course, 50% off today'],
  examplesNo: ['Here is a free guide to get started'],
  scope: 'all',
};

function completion(content, { model = 'gpt-test', finish = 'stop' } = {}) {
  return {
    model,
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }],
    usage: { prompt_tokens: 300, completion_tokens: 200 },
  };
}

function setup({ assistant = 'openai', keys = { openai: SECRET, deepseek: '' }, handler } = {}) {
  const handle = installChrome({
    local: {
      [SETTINGS_KEY]: normalizeSettings({ assistant }),
      [KEYS_KEY]: keys,
    },
  });
  const calls = installFetch(handler ?? (() => jsonResponse(completion(GOOD))));
  return Object.assign(calls, { handle });
}

const INPUT = { requirement: 'hide people selling courses', groupNames: ['Marketing', 'Politics'] };

test('a well-formed answer becomes a draft and picks an offered category by name', () => {
  const parsed = parseGeneratedDraft(JSON.stringify(GOOD), ['Marketing', 'Politics']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draft.label, 'Course sellers');
  assert.equal(parsed.draft.groupName, 'Marketing');
  assert.equal(parsed.draft.newGroupName, undefined);
  assert.deepEqual(parsed.draft.examplesYes, ['Join my course, 50% off today']);
  assert.equal(parsed.draft.scope, 'all');
});

test('the category is matched ignoring case and space, and spelt as it was offered', () => {
  const parsed = parseGeneratedDraft(JSON.stringify({ ...GOOD, group: '  marketing ' }), ['Marketing']);
  assert.equal(parsed.draft.groupName, 'Marketing');
});

test('an unknown category is a new one, and an empty one is none', () => {
  const made = parseGeneratedDraft(JSON.stringify({ ...GOOD, group: 'Courses' }), ['Marketing']);
  assert.equal(made.draft.newGroupName, 'Courses');
  assert.equal(made.draft.groupName, undefined);
  const none = parseGeneratedDraft(JSON.stringify({ ...GOOD, group: '' }), ['Marketing']);
  assert.equal(none.ok, true);
  assert.equal(none.draft.groupName, undefined);
  assert.equal(none.draft.newGroupName, undefined);
  const missing = parseGeneratedDraft(JSON.stringify({ ...GOOD, group: undefined }), ['Marketing']);
  assert.equal(missing.ok, true);
});

test('a category name that cannot be kept is dropped without spoiling the draft', () => {
  const parsed = parseGeneratedDraft(JSON.stringify({ ...GOOD, group: 'x'.repeat(41) }), []);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draft.newGroupName, undefined);
});

test('a fenced JSON answer is read, blank examples are dropped, exclude and scope may be absent', () => {
  const body = { ...GOOD, examplesYes: ['  a  ', '', '   '], exclude: undefined, scope: undefined };
  const parsed = parseGeneratedDraft('```json\n' + JSON.stringify(body) + '\n```', []);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.draft.examplesYes, ['a']);
  assert.equal(parsed.draft.exclude, '');
  assert.equal(parsed.draft.scope, 'all');
});

test('every answer the save path would refuse is an error, and nothing is repaired', () => {
  const bad = (change) => parseGeneratedDraft(typeof change === 'string' ? change : JSON.stringify({ ...GOOD, ...change }), []);
  assert.equal(parseGeneratedDraft(undefined, []).ok, false);
  assert.equal(bad('not json').ok, false);
  assert.equal(bad('[1,2]').ok, false);
  assert.equal(bad('null').ok, false);
  assert.equal(bad({ include: '' }).ok, false, 'a semantic rule needs a condition');
  assert.equal(bad({ include: 42 }).ok, false);
  assert.equal(bad({ label: '' }).ok, false);
  assert.equal(bad({ label: 'x'.repeat(MAX_LABEL_LENGTH + 1) }).ok, false);
  assert.equal(bad({ label: 'bad\u202elabel' }).ok, false, 'bidi override');
  assert.equal(bad({ include: 'y'.repeat(MAX_INCLUDE_LENGTH + 1) }).ok, false);
  assert.equal(bad({ include: 'Is this a post\u0000?' }).ok, false);
  assert.equal(bad({ examplesYes: Array.from({ length: MAX_EXAMPLES_PER_SIDE + 1 }, (_, i) => `e${i}`) }).ok, false);
  assert.equal(bad({ examplesNo: ['x'.repeat(201)] }).ok, false);
  assert.equal(bad({ examplesYes: [1] }).ok, false);
  assert.equal(bad({ examplesYes: 'one' }).ok, false);
  assert.equal(bad({ exclude: 5 }).ok, false);
  assert.equal(bad({ scope: 'everywhere' }).ok, false);
  assert.equal(bad({ group: 7 }).ok, false);
});

test('the requirement is bounded before anything is sent', () => {
  assert.equal(requirementProblem(''), 'empty');
  assert.equal(requirementProblem('   \n'), 'empty');
  assert.equal(requirementProblem('x'.repeat(MAX_REQUIREMENT_LENGTH + 1)), 'too-long');
  assert.equal(requirementProblem('hide\u0000this'), 'unsafe');
  assert.equal(requirementProblem('hide \u200bthis'), 'unsafe');
  assert.equal(requirementProblem('line one\nline two'), null);
  assert.equal(requirementProblem('x'.repeat(MAX_REQUIREMENT_LENGTH)), null);
});

test('the message is validated: a requirement and at most twenty safe category names', () => {
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: INPUT }), true);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { ...INPUT, groupNames: [] } }), true);
  assert.equal(isRuntimeMessage({ type: 'generate-rule' }), false);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { groupNames: [] } }), false);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { ...INPUT, requirement: ' ' } }), false);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { ...INPUT, requirement: 'x'.repeat(601) } }), false);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { ...INPUT, groupNames: Array(21).fill('a') } }), false);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { ...INPUT, groupNames: ['a\u0000'] } }), false);
  assert.equal(isRuntimeMessage({ type: 'generate-rule', input: { ...INPUT, groupNames: [1] } }), false);
  assert.equal(isGenerateRuleInput(INPUT), true);
});

test('a result is recognised only in its two shapes', () => {
  const draft = parseGeneratedDraft(JSON.stringify(GOOD), []).draft;
  assert.equal(isGenerateRuleResult({ ok: true, draft, model: 'm' }), true);
  assert.equal(isGenerateRuleResult({ ok: false, error: 'auth', detail: 'HTTP 401' }), true);
  assert.equal(isGenerateRuleResult({ ok: false, error: 'other', detail: '' }), false);
  assert.equal(isGenerateRuleResult({ ok: true, draft: { label: 1 }, model: 'm' }), false);
  assert.equal(isGenerateRuleResult(null), false);
});

test('a generated name never collides with a rule that exists', () => {
  assert.equal(uniqueRuleLabel('Course sellers', ['Spam']), 'Course sellers');
  assert.equal(uniqueRuleLabel('Course sellers', ['course SELLERS']), 'Course sellers 2');
  assert.equal(uniqueRuleLabel('Course sellers', ['Course sellers', 'Course sellers 2']), 'Course sellers 3');
  const long = 'x'.repeat(MAX_LABEL_LENGTH);
  const next = uniqueRuleLabel(long, [long]);
  assert.equal(next.length <= MAX_LABEL_LENGTH, true);
  assert.notEqual(next, long);
});

test('without a key no request is made', async () => {
  const calls = setup({ keys: { openai: '', deepseek: SECRET } });
  const result = await generateRuleDraft(INPUT);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-key');
  assert.equal(calls.length, 0);
});

test('an unusable requirement sends nothing', async () => {
  const calls = setup();
  assert.equal((await generateRuleDraft({ requirement: '  ', groupNames: [] })).error, 'invalid');
  assert.equal((await generateRuleDraft({ requirement: 'x'.repeat(601), groupNames: [] })).error, 'invalid');
  assert.equal(calls.length, 0);
});

test('one request carries only the requirement and category names, and the answer becomes a draft', async () => {
  const calls = setup();
  const result = await generateRuleDraft(INPUT);

  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-test');
  assert.equal(result.draft.groupName, 'Marketing');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  assert.equal(call.body.max_completion_tokens, GENERATE_MAX_OUTPUT_TOKENS);
  assert.equal(call.body.reasoning_effort, 'none');
  assert.deepEqual(JSON.parse(call.body.messages[1].content), {
    requirement: 'hide people selling courses',
    existingCategories: ['Marketing', 'Politics'],
  });
  const sent = JSON.stringify(call.body);
  assert.equal(sent.includes(SECRET), false, 'the key is a header, never in the body');
});

test('the assistant setting picks the connection: DeepSeek uses its own endpoint and limits', async () => {
  const calls = setup({ assistant: 'deepseek', keys: { openai: '', deepseek: SECRET } });
  const result = await generateRuleDraft(INPUT);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'api.deepseek.com');
  assert.equal(calls[0].body.max_tokens, GENERATE_MAX_OUTPUT_TOKENS);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
});

test('a failure is mapped, sent once and never retried', async () => {
  const cases = [
    [() => jsonResponse({}, { status: 401 }), 'auth'],
    [() => jsonResponse({}, { status: 403 }), 'auth'],
    [() => jsonResponse({}, { status: 429 }), 'rate-limited'],
    [() => jsonResponse({}, { status: 500 }), 'network'],
    [() => jsonResponse({}, { status: 404 }), 'network'],
    [() => {
      throw new Error('offline');
    }, 'network'],
    [() => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } }), 'bad-response'],
    [() => jsonResponse(completion(GOOD, { finish: 'length' })), 'bad-response'],
    [() => jsonResponse({ choices: [] }), 'invalid'],
    [() => jsonResponse(completion('I cannot help with that.')), 'invalid'],
    [() => jsonResponse(completion({ ...GOOD, include: '' })), 'invalid'],
  ];
  for (const [handler, error] of cases) {
    const calls = setup({ handler });
    const result = await generateRuleDraft(INPUT);
    assert.equal(result.ok, false, error);
    assert.equal(result.error, error);
    assert.equal(calls.length, 1, `${error}: exactly one request, no retry`);
    assert.equal(result.detail.includes(SECRET), false);
  }
});

test('drafting is not a verification job: nothing is stored', async () => {
  setup();
  const result = await generateRuleDraft(INPUT);
  assert.equal(result.ok, true);
  const stored = await globalThis.chrome.storage.local.get(null);
  assert.deepEqual(Object.keys(stored).sort(), [KEYS_KEY, SETTINGS_KEY].sort());
});

test('only one of our own pages may ask the background to draft', async () => {
  globalThis.defineBackground = (factory) => factory();
  const calls = setup();
  await import('../../src/entrypoints/background');
  const message = { type: 'generate-rule', input: INPUT };

  for (const sender of [webPageSender(), xContentSender()]) {
    const refused = await calls.handle.dispatchMessage(message, sender);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'invalid');
  }
  assert.equal(calls.length, 0, 'a refused sender spends nothing');

  const allowed = await calls.handle.dispatchMessage(message, extensionPageSender());
  assert.equal(allowed.ok, true);
  assert.equal(calls.length, 1);
});
