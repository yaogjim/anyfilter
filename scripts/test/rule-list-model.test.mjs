/**
 * The rule list's ordering, filtering and counts, and the pure edits to the
 * category draft. Both are plain functions so no browser is needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtInRules } from '../../src/domain/rule';
import { MAX_GROUPS, defaultGroups } from '../../src/domain/rule-group';
import {
  addGroup,
  assignGroup,
  canResetName,
  checkGroupName,
  findGroupByLabel,
  groupsEqual,
  moveGroup,
  removeGroup,
  renameGroup,
} from '../../src/ui/sidepanel/groups-draft';
import {
  ANY_GROUP,
  DEFAULT_QUERY,
  UNCATEGORISED,
  buildRuleList,
  sectionKeyOf,
  visibleRuleIds,
} from '../../src/ui/sidepanel/rule-list-model';
import { newCustomRule, rulesEqual, withRule } from '../../src/ui/sidepanel/rules-draft';

const labelOf = (group) => (group.name !== '' ? group.name : `default:${group.id}`);

function world() {
  const groups = defaultGroups();
  const mine = { ...newCustomRule(builtInRules()), id: 'custom:mine', label: 'Mine', include: 'Is it mine?' };
  return { groups, rules: [...builtInRules(), mine] };
}

test('the default list groups built-ins by category and puts uncategorised last', () => {
  const { groups, rules } = world();
  const list = buildRuleList(rules, groups, DEFAULT_QUERY);

  assert.equal(list.mode, 'grouped');
  assert.deepEqual(list.sections.map((section) => section.key), ['marketing', 'engagement', 'harmful', 'politics', UNCATEGORISED]);
  assert.deepEqual(list.sections[0].rules.map((rule) => rule.id), ['ads', 'promo', 'crypto']);
  assert.deepEqual(list.sections[4].rules.map((rule) => rule.id), ['custom:mine']);
  assert.deepEqual([list.sections[0].enabled, list.sections[0].total], [3, 3]);
  assert.equal(visibleRuleIds(list).length, 11);
});

test('an empty uncategorised section is left out, an empty category is kept', () => {
  const { groups, rules } = world();
  const only = rules.filter((rule) => rule.id !== 'custom:mine' && rule.group !== 'politics');
  const list = buildRuleList(only, groups, DEFAULT_QUERY);
  assert.deepEqual(list.sections.map((section) => section.key), ['marketing', 'engagement', 'harmful', 'politics']);
  assert.equal(list.sections[3].rules.length, 0);
  assert.equal(list.sections[3].total, 0);
});

test('enabled counts follow the rules, not the filters', () => {
  const { groups, rules } = world();
  const off = rules.map((rule) => (rule.id === 'promo' ? { ...rule, enabled: false } : rule));
  const list = buildRuleList(off, groups, { ...DEFAULT_QUERY, search: 'crypto' });
  assert.deepEqual(list.sections.map((section) => section.key), ['marketing']);
  assert.deepEqual(list.sections[0].rules.map((rule) => rule.id), ['crypto']);
  assert.deepEqual([list.sections[0].enabled, list.sections[0].total], [2, 3]);
});

test('search, source and category filters combine, and sections that end up empty disappear', () => {
  const { groups, rules } = world();
  assert.deepEqual(
    visibleRuleIds(buildRuleList(rules, groups, { ...DEFAULT_QUERY, search: 'politics' })),
    ['politics'],
  );
  assert.deepEqual(
    visibleRuleIds(buildRuleList(rules, groups, { ...DEFAULT_QUERY, source: 'custom' })),
    ['custom:mine'],
  );
  assert.deepEqual(
    visibleRuleIds(buildRuleList(rules, groups, { ...DEFAULT_QUERY, group: 'harmful' })),
    ['hate', 'nsfw', 'porn'],
  );
  assert.deepEqual(
    visibleRuleIds(buildRuleList(rules, groups, { ...DEFAULT_QUERY, group: UNCATEGORISED })),
    ['custom:mine'],
  );
  assert.deepEqual(visibleRuleIds(buildRuleList(rules, groups, { ...DEFAULT_QUERY, group: 'harmful', source: 'custom' })), []);
  assert.equal(buildRuleList(rules, groups, { ...DEFAULT_QUERY, search: 'zzz-no-match' }).sections.length, 0);
  assert.equal(DEFAULT_QUERY.group, ANY_GROUP);
});

test('sorting by name or by enabled state gives one flat list', () => {
  const { groups, rules } = world();
  const off = rules.map((rule) => (rule.id === 'ads' ? { ...rule, enabled: false } : rule));

  const byName = buildRuleList(off, groups, { ...DEFAULT_QUERY, sort: 'name' });
  assert.equal(byName.mode, 'flat');
  assert.equal(byName.sections.length, 1);
  const names = byName.sections[0].rules.map((rule) => rule.label);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));

  const byState = buildRuleList(off, groups, { ...DEFAULT_QUERY, sort: 'enabled' }).sections[0].rules;
  assert.equal(byState.at(-1).id, 'ads');
  assert.ok(byState.slice(0, -1).every((rule) => rule.enabled));
});

test('a rule naming a category that is gone is listed as uncategorised', () => {
  const { groups } = world();
  const stray = { ...newCustomRule([]), id: 'custom:stray', label: 'Stray', group: 'group:gone' };
  assert.equal(sectionKeyOf(stray, new Set(groups.map((group) => group.id))), UNCATEGORISED);
  const list = buildRuleList([stray], groups, DEFAULT_QUERY);
  assert.deepEqual(list.sections.at(-1).rules.map((rule) => rule.id), ['custom:stray']);
});

test('removing a category uncategorises its rules and leaves the rest alone', () => {
  const { groups, rules } = world();
  const removed = removeGroup(groups, rules, 'marketing');
  assert.deepEqual(removed.groups.map((group) => group.id), ['engagement', 'harmful', 'politics']);
  for (const id of ['ads', 'promo', 'crypto']) {
    assert.equal('group' in removed.rules.find((rule) => rule.id === id), false, id);
  }
  assert.equal(removed.rules.find((rule) => rule.id === 'bait').group, 'engagement');
  assert.equal(removed.rules.length, rules.length);
});

test('categories can be added, renamed, reset and reordered', () => {
  const groups = defaultGroups();
  const added = addGroup(groups, '  Newsletters ');
  assert.equal(added.groups.length, 5);
  assert.equal(added.groups[4].name, 'Newsletters');
  assert.match(added.id, /^group:/);

  const renamed = renameGroup(added.groups, 'politics', 'Elections');
  assert.equal(renamed.find((group) => group.id === 'politics').name, 'Elections');
  assert.equal(canResetName(renamed.find((group) => group.id === 'politics')), true);
  assert.equal(renameGroup(renamed, 'politics', '').find((group) => group.id === 'politics').name, '');

  assert.deepEqual(moveGroup(groups, 'harmful', -1).map((group) => group.id), ['marketing', 'harmful', 'engagement', 'politics']);
  assert.deepEqual(moveGroup(groups, 'marketing', -1).map((group) => group.id), groups.map((group) => group.id));
  assert.deepEqual(moveGroup(groups, 'politics', 1).map((group) => group.id), groups.map((group) => group.id));
  assert.equal(groupsEqual(groups, defaultGroups()), true);
  assert.equal(groupsEqual(groups, renamed), false);
});

test('a category name must be new as it is shown, non-empty and within limits', () => {
  const groups = defaultGroups();
  assert.equal(checkGroupName('', groups, labelOf), 'empty');
  assert.equal(checkGroupName('   ', groups, labelOf), 'empty');
  assert.equal(checkGroupName('x'.repeat(41), groups, labelOf), 'too-long');
  assert.equal(checkGroupName('DEFAULT:MARKETING', groups, labelOf), 'taken');
  assert.equal(checkGroupName('default:marketing', groups, labelOf, 'marketing'), null);
  assert.equal(checkGroupName('Fresh', groups, labelOf), null);
  const full = Array.from({ length: MAX_GROUPS }, (_, i) => ({ id: `g${i}`, name: `G${i}` }));
  assert.equal(checkGroupName('One more', full, labelOf), 'limit');
  assert.equal(checkGroupName('Renamed', full, labelOf, 'g0'), null);
  assert.equal(findGroupByLabel(groups, ' default:POLITICS ', labelOf).id, 'politics');
  assert.equal(findGroupByLabel(groups, 'nothing', labelOf), undefined);
});

test('assigning a category sets or clears it for exactly the chosen rules', () => {
  const { rules } = world();
  const moved = assignGroup(rules, new Set(['custom:mine']), 'politics');
  assert.equal(moved.find((rule) => rule.id === 'custom:mine').group, 'politics');
  assert.equal(moved.find((rule) => rule.id === 'bait').group, 'engagement');
  const cleared = assignGroup(moved, new Set(['custom:mine', 'bait']), null);
  assert.equal('group' in cleared.find((rule) => rule.id === 'custom:mine'), false);
  assert.equal('group' in cleared.find((rule) => rule.id === 'bait'), false);
});

test('rule draft equality ignores the order fields were added in, and sees a category change', () => {
  const { rules } = world();
  const mine = rules.find((rule) => rule.id === 'custom:mine');
  const reordered = { ...mine, threshold: 0.8, group: 'politics' };
  const other = { ...mine, group: 'politics', threshold: 0.8 };
  assert.equal(rulesEqual([reordered], [other]), true);
  assert.equal(rulesEqual([mine], [withRule([mine], 'custom:mine', { group: 'politics' })[0]]), false);
  assert.equal(rulesEqual([mine], withRule([withRule([mine], 'custom:mine', { group: 'politics' })[0]], 'custom:mine', { group: undefined })), true);
});
