import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceIdentityKey, sourceKindForTable, sourceTableForKind } from '../src/source-identity.js';

test('legacy source identity contract maps exact table names to stored kinds without id collisions', () => {
  assert.equal(sourceKindForTable('characters'), 'character');
  assert.equal(sourceKindForTable('archive_entries'), 'archive_entry');
  assert.equal(sourceTableForKind('character'), 'characters');
  assert.equal(sourceTableForKind('archive_entry'), 'archive_entries');
  assert.equal(sourceIdentityKey('characters', 7), 'characters:7');
  assert.equal(sourceIdentityKey('archive_entries', 7), 'archive_entries:7');
  assert.notEqual(sourceIdentityKey('characters', 7), sourceIdentityKey('archive_entries', 7));
  assert.equal(sourceKindForTable('entries'), null, 'unrecognized aliases cannot become persisted identities');
  assert.equal(sourceTableForKind('entry'), null);
});
