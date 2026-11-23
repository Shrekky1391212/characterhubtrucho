import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUniverseTree, canReparentNode, normalizeContentScope, sameContentScope } from '../src/world-structure.js';

test('pending and global are explicit, different scopes', () => {
  assert.deepEqual(normalizeContentScope({}), { scope_kind: 'pending', universe_id: null, universe_node_id: null });
  assert.deepEqual(normalizeContentScope({ scope_kind: 'global' }), { scope_kind: 'global', universe_id: null, universe_node_id: null });
  assert.equal(sameContentScope(normalizeContentScope({}), normalizeContentScope({ scope_kind: 'global' })), false);
});

test('universe content requires a universe and normalizes node ids', () => {
  assert.equal(normalizeContentScope({ scope_kind: 'universe' }), null);
  assert.deepEqual(normalizeContentScope({ universe_id: '12', universe_node_id: '4' }), {
    scope_kind: 'universe', universe_id: 12, universe_node_id: 4,
  });
  assert.equal(normalizeContentScope({ scope_kind: 'pending', universe_id: 12 }), null);
});

test('node moves stay within one universe and cannot create cycles', () => {
  const rows = [
    { id: 1, universe_id: 10, parent_id: null },
    { id: 2, universe_id: 10, parent_id: 1 },
    { id: 3, universe_id: 10, parent_id: 2 },
    { id: 4, universe_id: 11, parent_id: null },
  ];
  assert.equal(canReparentNode(rows, 2, null, 10), true);
  assert.equal(canReparentNode(rows, 2, 3, 10), false);
  assert.equal(canReparentNode(rows, 2, 4, 10), false);
  assert.equal(canReparentNode(rows, 2, 99, 10), false);
});

test('tree builder preserves arbitrary depth and sort order', () => {
  const tree = buildUniverseTree([
    { id: 3, name: 'City', parent_id: 2, sort_order: 0 },
    { id: 1, name: 'Planet', parent_id: null, sort_order: 0 },
    { id: 2, name: 'Kingdom', parent_id: 1, sort_order: 1 },
    { id: 4, name: 'Continent', parent_id: 1, sort_order: 0 },
  ]);
  assert.deepEqual(tree.map(n => n.name), ['Planet']);
  assert.deepEqual(tree[0].children.map(n => n.name), ['Continent', 'Kingdom']);
  assert.equal(tree[0].children[1].children[0].name, 'City');
});
