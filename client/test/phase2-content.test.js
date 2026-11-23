import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableGroupItems,
  attachContentType,
  dynamicFieldModel,
  dynamicFieldValue,
  filterContentItems,
  groupMembershipRows,
  libraryEmptyState,
  normalizeContentItem,
  hydrateLegacyEditorRecord,
  selectLibraryView,
  phase2UnavailableMessage,
  uniqueContentItems,
} from '../src/phase2-content.js';

const items = [
  { id: 1, content_item_id: 1, owner_id: 1, source_table: 'characters', source_id: 7, type_key: 'character', scope_kind: 'universe', universe_id: 10, name: 'Ari', tags: ['royal'], data: { role: 'queen' } },
  { id: 2, content_item_id: 2, owner_id: 1, source_table: 'archive_entries', source_id: 7, type_key: 'location', scope_kind: 'universe', universe_id: 11, name: 'Harbor', tags: ['coast'], data: {} },
  { id: 3, content_item_id: 3, owner_id: 1, source_table: 'archive_entries', source_id: 8, type_key: 'note', scope_kind: 'global', universe_id: null, name: 'Rules', tags: ['royal'], data: {} },
  { id: 4, content_item_id: 4, owner_id: 1, source_table: 'characters', source_id: 9, type_key: 'character', scope_kind: 'pending', universe_id: null, name: 'Unsorted', tags: [], data: {} },
];

test('library, pending, global, and universe views keep scopes independent', () => {
  assert.deepEqual(selectLibraryView(items).map(item => item.name), ['Ari', 'Harbor', 'Rules']);
  assert.deepEqual(selectLibraryView(items, { view: 'pending' }).map(item => item.name), ['Unsorted']);
  assert.deepEqual(selectLibraryView(items, { view: 'global' }).map(item => item.name), ['Rules']);
  assert.deepEqual(selectLibraryView(items, { view: 'universe', universeId: 11 }).map(item => item.name), ['Harbor']);
});

test('combined filters intersect type, scope, universe, group, text, tags, and configured fields', () => {
  const membershipByItem = new Map([['1', new Set(['5', '6'])], ['2', new Set(['6'])]]);
  const result = filterContentItems(items, {
    type: 'character', scope: 'universe', universeId: 10, grouped: 'grouped', groupId: '5',
    query: 'ari', tag: 'roy', fields: { role: 'queen' }, membershipByItem,
  });
  assert.deepEqual(result.map(item => item.name), ['Ari']);
  assert.deepEqual(filterContentItems(items, { grouped: 'ungrouped', membershipByItem }).map(item => item.name), ['Rules', 'Unsorted']);
});

test('legacy normalization and deduplication preserve source table identity across matching ids', () => {
  const character = normalizeContentItem({ id: 7, entity_type: 'character', scope_kind: 'pending', tags: 'one, two', details: { origin: 'old' } });
  const entry = normalizeContentItem({ id: 7, entity_type: 'entry', kind: 'location', scope_kind: 'global', data: { data: { climate: 'cold' } }, migrated: false });
  assert.equal(character.source_table, 'characters');
  assert.equal(entry.source_table, 'archive_entries');
  assert.deepEqual(character.tags, ['one', 'two']);
  assert.deepEqual(entry.data, { climate: 'cold' });
  const rows = uniqueContentItems([
    { source_table: 'characters', source_id: 7, type_key: 'character', name: 'Ari' },
    { source_table: 'characters', source_id: 7, type_key: 'character', name: 'Ari migrated' },
    { source_table: 'archive_entries', source_id: 7, type_key: 'location', name: 'Harbor' },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.source_table).sort(), ['archive_entries', 'characters']);
});

test('migrated character and entry snapshots rehydrate forms and preserve hidden values on edits', () => {
  const character = normalizeContentItem({
    id: 41, owner_id: 1, source_kind: 'character', source_id: 7, source_table: 'characters',
    source_type: 'character', type_key: 'character', scope_kind: 'universe', universe_id: 10,
    name: 'Ari', description: 'Visible', tags: ['pilot'], migrated: true,
    data: { id: 7, owner_id: 1, scope_kind: 'universe', universe_id: 10, universe_node_id: 4, name: 'Ari',
      alias: 'Star', tags: 'pilot', description: 'Visible', biography: 'Long story', details: { voice: 'low', private_key: 'keep' } },
  });
  const characterDraft = hydrateLegacyEditorRecord(character);
  characterDraft.name = 'Ari renamed';
  assert.equal(characterDraft.id, 7);
  assert.deepEqual(characterDraft.details, { voice: 'low', private_key: 'keep' });

  const entry = normalizeContentItem({
    id: 42, owner_id: 1, source_kind: 'archive_entry', source_id: 7, source_table: 'archive_entries',
    source_type: 'old-artifact', type_key: 'old-artifact', content_type_id: 9,
    scope_kind: 'global', name: 'Relic', tags: ['silver'], migrated: true,
    data: { id: 7, owner_id: 1, kind: 'old-artifact', scope_kind: 'global', name: 'Relic',
      data: { rarity: 'rare', importer_note: 'preserve me' }, tags: ['silver'], parent_id: null },
  });
  const entryDraft = hydrateLegacyEditorRecord(entry);
  entryDraft.data.rarity = 'legendary';
  assert.equal(entryDraft.kind, 'old-artifact');
  assert.deepEqual(entryDraft.data, { rarity: 'legendary', importer_note: 'preserve me' });
  assert.equal(entry.source_table, 'archive_entries');
  assert.equal(entry.source_type, 'old-artifact');
  const linked = attachContentType(entry, [{ id: 9, slug: 'old-artifact', label: 'Old artifact', field_schema: [{ key: 'rarity', type: 'text' }] }]);
  assert.equal(linked.type_key, 'old-artifact');
  assert.equal(linked.type_label, 'Old artifact');
  assert.equal(linked.content_type.field_schema[0].key, 'rarity');
});

test('group views include descendants, deduplicate items, and retain the membership source for removal', () => {
  const groups = [{ id: 5, parent_group_id: null }, { id: 6, parent_group_id: 5 }, { id: 7, parent_group_id: 6 }];
  const memberships = { 5: ['1'], 6: ['1', '2'], 7: ['2'] };
  const visible = groupMembershipRows(items, groups, memberships, 5, true);
  assert.deepEqual(visible.map(row => row.item.name), ['Ari', 'Harbor']);
  assert.deepEqual(visible.map(row => row.groupId), ['5', '6']);
  assert.deepEqual(groupMembershipRows(items, groups, memberships, 5, false).map(row => row.item.name), ['Ari']);
});

test('adding in a parent remains possible when an item already belongs to a child group', () => {
  const available = availableGroupItems(items, { 5: [], 6: ['1'] }, 5);
  assert.ok(available.some(item => item.content_item_id === 1));
  assert.ok(!available.some(item => item.content_item_id === undefined && item.source_id === 7));
});

test('dynamic form fields expose typed values, required state, options, and preserve edit values', () => {
  const schema = [
    { key: 'weight', type: 'number', required: true },
    { key: 'era', type: 'select', options: ['ancient', 'modern'] },
    { key: 'active', type: 'checkbox' },
  ];
  assert.deepEqual(dynamicFieldModel(schema[0], { weight: 12 }), { inputType: 'number', value: 12, required: true, options: [] });
  assert.deepEqual(dynamicFieldModel(schema[1], { era: 'modern' }), { inputType: 'text', value: 'modern', required: false, options: ['ancient', 'modern'] });
  assert.equal(dynamicFieldModel(schema[2]).value, false);
  assert.equal(dynamicFieldValue(schema[0], '14'), 14);
  assert.equal(dynamicFieldValue(schema[2], true), true);
});

test('empty library and pending states remain distinct; schema 503 has a safe fallback message', () => {
  assert.equal(libraryEmptyState(items), null);
  assert.equal(libraryEmptyState([], 'library').title, 'La biblioteca esta vacia');
  assert.equal(libraryEmptyState([], 'pending').title, 'No hay elementos pendientes');
  assert.match(phase2UnavailableMessage({ code: 'PHASE2_SCHEMA_NOT_INSTALLED' }), /pantallas anteriores siguen disponibles/);
  assert.match(phase2UnavailableMessage({ message: 'offline' }), /offline/);
});
