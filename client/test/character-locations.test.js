import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleLocationOptions, normalizeLocationLinks, updateLocationLinks } from '../src/character-locations.js';
import { addCharacterSection, CHARACTER_SECTION_TEMPLATES, characterSheetFromDetails, moveCharacterSection, normalizeCharacterSheet } from '../src/character-sheet.js';
import { buildFamilyGenerations } from '../src/relationships.js';

test('character location links normalize multiple distinct places without dropping unknown fields', () => {
  const current = normalizeLocationLinks({ birthplace_id: '4', visited_place_ids: [4, '8', '8', -1], source_note: 'legacy' });
  assert.equal(current.birthplace_id, 4);
  assert.deepEqual(current.visited_place_ids, [4, 8]);
  assert.equal(current.source_note, 'legacy');
  assert.equal(updateLocationLinks({ imported: { old: true } }, current).imported.old, true);
});

test('place options follow character scope and universe ownership boundaries', () => {
  const rows = [
    { id: 1, kind: 'location', scope_kind: 'universe', universe_id: 10 },
    { id: 2, kind: 'location', scope_kind: 'universe', universe_id: 11 },
    { id: 3, kind: 'location', scope_kind: 'global', universe_id: null },
    { id: 4, kind: 'note', scope_kind: 'global', universe_id: null },
  ];
  assert.deepEqual(compatibleLocationOptions(rows, { scope_kind: 'universe', universe_id: 10 }).map(row => row.id), [1, 3]);
  assert.deepEqual(compatibleLocationOptions(rows, { scope_kind: 'global' }).map(row => row.id), [3]);
  assert.deepEqual(compatibleLocationOptions(rows, { scope_kind: 'pending' }).map(row => row.id), [3]);
});

test('character sheets keep independent optional sections and stable custom content', () => {
  const first = addCharacterSection(normalizeCharacterSheet(), CHARACTER_SECTION_TEMPLATES.find(item => item.key === 'abilities'), 'one');
  const second = addCharacterSection(normalizeCharacterSheet(), { key: null, name: 'Cybernetics', content_type: 'fields' }, 'two');
  assert.deepEqual(first.sections.map(section => section.name), ['Habilidades y poderes']);
  assert.deepEqual(second.sections.map(section => section.name), ['Cybernetics']);
  assert.equal(moveCharacterSection({ sections: [...first.sections, { ...first.sections[0], id: 'other', name: 'Notes', order: 1 }] }, 'other', -1).sections[0].id, 'other');
  assert.equal(characterSheetFromDetails({ appearance: 'Silver eyes' }).sections[0].content, 'Silver eyes', 'legacy detail fields surface as editable sections');
});

test('family generation view derives parent, child and peer links without duplicating characters', () => {
  const people=[{id:1,name:'A'},{id:2,name:'B'},{id:3,name:'C'},{id:4,name:'D'}];
  const links=[{source_character_id:1,target_character_id:2,relation_type:'parent'},{source_character_id:2,target_character_id:3,relation_type:'parent'},{source_character_id:3,target_character_id:4,relation_type:'sibling'}];
  const tree=buildFamilyGenerations(links,people,1);
  assert.deepEqual(tree.map(level=>[level.level,level.characters.map(person=>person.id)]),[[0,[1]],[1,[2]],[2,[3,4]]]);
});
