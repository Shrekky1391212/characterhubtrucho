import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeSqliteImport, formatMigrationConflictReport } from '../src/migration-safety.js';

test('migration conflict report identifies rows and never normalizes away conflict data', () => {
  const conflicts = [
    { table: 'archive_entries', id: 91, parent_id: 44, universe_id: 3, parent_universe_id: 8 },
    { table: 'character_relationships', id: 17, source_character_id: 2, target_character_id: 5 },
  ];
  const report = formatMigrationConflictReport(conflicts);
  assert.match(report, /archive_entries.*91.*parent_id.*44/);
  assert.match(report, /character_relationships.*17/);
  assert.equal(conflicts[0].parent_id, 44);
});

test('SQLite import refuses any pre-existing account to prevent unowned imports', () => {
  assert.throws(() => assertSafeSqliteImport(1, { universes: 0, characters: 0, themes: 0 }), /no accounts/);
  assert.doesNotThrow(() => assertSafeSqliteImport(0, { universes: 0, characters: 0, themes: 0 }));
  assert.throws(() => assertSafeSqliteImport(0, { universes: 1, characters: 0, themes: 0 }), /no accounts/);
});
