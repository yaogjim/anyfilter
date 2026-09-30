/**
 * How the home view regroups hidden posts by rule category. Pure functions, so no
 * browser is needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtInRules } from '../../src/domain/rule';
import { defaultGroups } from '../../src/domain/rule-group';
import { groupByCategory, makeCategoryResolver } from '../../src/ui/sidepanel/hidden-groups-model';

const names = { groupLabel: (group) => (group.name !== '' ? group.name : `default:${group.id}`), uncategorised: 'Uncategorised' };

function entry(id, reasons) {
  return { post: { id }, reasons, at: 1, shown: false };
}
const reason = (categoryId, label, probability) => ({ categoryId, label, probability });

test('posts are grouped under their rule category, in the category order', () => {
  const rules = builtInRules();
  const resolve = makeCategoryResolver(rules, defaultGroups(), names);
  const promo = rules.find((rule) => rule.id === 'promo');
  const bait = rules.find((rule) => rule.id === 'bait');
  const groups = groupByCategory(
    [entry('1', [reason('bait', bait.label, 0.9)]), entry('2', [reason('promo', promo.label, 0.8)])],
    resolve,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ['default:marketing', 'default:engagement'],
  );
  assert.deepEqual(groups[0].entries.map((item) => item.entry.post.id), ['2']);
});

test('a post that matched two rules of one category is listed once, under the likelier reason', () => {
  const rules = builtInRules();
  const resolve = makeCategoryResolver(rules, defaultGroups(), names);
  const bait = rules.find((rule) => rule.id === 'bait');
  const spam = rules.find((rule) => rule.id === 'spam');
  const groups = groupByCategory(
    [entry('1', [reason('bait', bait.label, 0.7), reason('spam', spam.label, 0.95)])],
    resolve,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 1);
  assert.equal(groups[0].entries[0].reason.categoryId, 'spam');
});

test('a post that matched rules in two categories shows under each', () => {
  const rules = builtInRules();
  const resolve = makeCategoryResolver(rules, defaultGroups(), names);
  const groups = groupByCategory(
    [entry('1', [reason('bait', 'x', 0.9), reason('hate', 'y', 0.9)])],
    resolve,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ['default:engagement', 'default:harmful'],
  );
});

test('a rule that is gone or has no category is uncategorised and sorts last', () => {
  const resolve = makeCategoryResolver(builtInRules(), defaultGroups(), names);
  const groups = groupByCategory(
    [entry('1', [reason('deleted-rule', 'Old rule', 0.9)]), entry('2', [reason('ads', 'irrelevant', 0.9)])],
    resolve,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ['default:marketing', 'Uncategorised'],
  );
});

test('a reason whose rule id no longer exists falls back to the rule label', () => {
  const rules = builtInRules();
  const politics = rules.find((rule) => rule.id === 'politics');
  const resolve = makeCategoryResolver(rules, defaultGroups(), names);
  assert.equal(resolve(reason('stale-id', politics.label, 0.9)).id, 'politics');
});
