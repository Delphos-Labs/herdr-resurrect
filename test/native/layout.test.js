'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLayout, remapLayout } = require('../../native/layout');
const { layout } = require('./fixtures');

test('nested weighted splits retain geometry, names and source state', () => {
  const source = layout();
  source.spaces[0].tabs[0].root.children[1] = {
    id: 'nested', type: 'column', size: { weight: 3 },
    children: [
      { id: 'p2', type: 'block', size: { weight: 2 }, content: { terminal: 't2' } },
      { id: 'p3', type: 'block', size: { weight: 1 }, content: { terminal: 't3' } },
    ],
  };
  const before = structuredClone(source);
  assert.deepEqual(validateLayout(source), ['t1', 't2', 't3']);
  const restored = remapLayout(source, { t1: 't9', t2: 'ta', t3: 'tb' });
  assert.deepEqual(validateLayout(restored), ['t9', 'ta', 'tb']);
  assert.equal(restored.spaces[0].tabs[0].root.children[1].size.weight, 3);
  assert.equal(restored.spaces[0].tabs[0].root.children[1].children[0].size.weight, 2);
  assert.equal(restored.spaces[0].tabs[0].name, 'Agents');
  assert.deepEqual(source, before);
});

test('unknown nodes, invalid weights and missing mappings are refused', () => {
  const unknown = layout();
  unknown.spaces[0].tabs[0].root.type = 'future-node';
  assert.throws(() => validateLayout(unknown), /Unsupported layout node/);
  const invalid = layout();
  invalid.spaces[0].tabs[0].root.children[0].size.weight = -1;
  assert.throws(() => validateLayout(invalid), /Invalid split size/);
  assert.throws(() => remapLayout(layout(), { t1: 't8' }), /Missing or duplicate replacement/);
  assert.throws(() => remapLayout(layout(), { t1: 't8', t2: 't8' }), /Missing or duplicate replacement/);
});

test('duplicate identities and duplicate terminal references are refused', () => {
  const source = layout();
  source.spaces[0].tabs[0].root.children[1].id = 'pane-0';
  assert.throws(() => validateLayout(source), /duplicate layout identity/);
  assert.throws(() => validateLayout(layout(['t1', 't1'])), /Duplicate terminal reference/);
});
