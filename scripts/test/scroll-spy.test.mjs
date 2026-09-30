import assert from 'node:assert/strict';
import test from 'node:test';
import { activeSection } from '../../src/ui/sidepanel/use-scroll-spy.ts';

const ORDER = ['appearance', 'models', 'rules', 'data'];

test('the first section is current before anything has scrolled past the reading line', () => {
  assert.equal(activeSection(ORDER, [300, 600, 900, 1200], false), 'appearance');
});

test('the current section is the last one whose top has passed the reading line', () => {
  assert.equal(activeSection(ORDER, [-500, 80, 700, 1500], false), 'models');
  assert.equal(activeSection(ORDER, [-900, -400, 100, 1400], false), 'rules');
});

test('at the very bottom the last section is current even if it never reached the line', () => {
  assert.equal(activeSection(ORDER, [-2000, -1500, -600, 400], true), 'data');
});

test('sections missing from the page are skipped', () => {
  assert.equal(activeSection(ORDER, [-500, null, 100, null], false), 'rules');
  assert.equal(activeSection(ORDER, [-500, -100, 500, null], true), 'rules');
  assert.equal(activeSection([], [], true), '');
});
