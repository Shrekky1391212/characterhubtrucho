import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyPhase2SchemaForIsolatedTest, inspectLegacyData } from '../src/phase2-schema.js';

async function freshIsolatedDatabase({ applySchema = true } = {}) {
  // This guard runs before any DDL. A PGlite memory:// instance has no network
  // endpoint and cannot load DATABASE_URL or connect to an external server.
  const db = new PGlite('memory://');
  const identity = await db.query('SELECT version() AS version, current_database() AS database, inet_server_addr() AS address');
  assert.match(identity.rows[0].version, /PGlite/);
  assert.equal(identity.rows[0].address, null);
  assert.equal(process.env.DATABASE_URL, undefined);
  await db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE universes (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(owner_id,id));
    CREATE TABLE universe_nodes (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, universe_id INTEGER NOT NULL, parent_id INTEGER, name TEXT NOT NULL DEFAULT '', node_type TEXT NOT NULL DEFAULT 'section', description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, scope_kind TEXT NOT NULL, universe_id INTEGER, universe_node_id INTEGER, name TEXT NOT NULL);
    CREATE TABLE archive_entries (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, scope_kind TEXT NOT NULL, universe_id INTEGER, universe_node_id INTEGER, parent_id INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE entry_links (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, source_entry_id INTEGER NOT NULL, target_entry_id INTEGER, target_character_id INTEGER);
    CREATE TABLE character_relationships (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, source_character_id INTEGER NOT NULL, target_character_id INTEGER NOT NULL);
    CREATE TABLE content_types (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, slug TEXT NOT NULL, label TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'archive', UNIQUE(owner_id,slug));
  `);
  const oldContentTypeColumns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='content_types' ORDER BY ordinal_position`);
  if (applySchema) {
    await applyPhase2SchemaForIsolatedTest(db);
    const newContentTypeColumns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='content_types' ORDER BY ordinal_position`);
    assert.deepEqual(newContentTypeColumns.rows, oldContentTypeColumns.rows, 'the existing content_types table stays unchanged');
  }
  return db;
}

async function seedOwnersAndUniverses(db) {
  await db.query('INSERT INTO users(id) VALUES (1),(2)');
  await db.query("INSERT INTO universes(id,owner_id,name) VALUES (10,1,'A'),(20,2,'B'),(11,1,'A2')");
  await db.query("INSERT INTO content_types(id,owner_id,slug,label) VALUES (100,1,'relic','Relic'),(200,2,'secret','Secret')");
  await db.query("INSERT INTO content_type_configs(content_type_id,owner_id,sort_order,field_schema) VALUES (100,1,4,'[{\"key\":\"rarity\",\"label\":\"Rarity\",\"type\":\"text\"}]')");
}

test('Phase 2 DDL applies only after proving PGlite memory isolation', async () => {
  const db = await freshIsolatedDatabase();
  try {
    const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('content_items','content_groups','content_group_items','content_type_configs') ORDER BY table_name`);
    assert.deepEqual(tables.rows.map(row => row.table_name), ['content_group_items','content_groups','content_items','content_type_configs']);
    const report = await inspectLegacyData(db);
    assert.equal(report.safeToBackfill, true);
    assert.deepEqual(report.conflicts, []);
  } finally { await db.close(); }
});

test('registry preserves source table identity when legacy numeric IDs overlap', async () => {
  const db = await freshIsolatedDatabase();
  try {
    await seedOwnersAndUniverses(db);
    await db.query("INSERT INTO characters(id,owner_id,scope_kind,universe_id,name) VALUES (7,1,'universe',10,'C')");
    await db.query("INSERT INTO archive_entries(id,owner_id,scope_kind,universe_id,kind,name) VALUES (7,1,'universe',10,'location','L')");
    const sources = await db.query('SELECT source_kind,source_id FROM content_items ORDER BY source_kind');
    assert.deepEqual(sources.rows, [{ source_kind: 'archive_entry', source_id: 7 }, { source_kind: 'character', source_id: 7 }]);
    assert.equal((await db.query("SELECT data->>'name' AS name FROM content_items WHERE source_kind='character'")).rows[0].name, 'C');
  } finally { await db.close(); }
});

test('dynamic type configuration is owner-scoped and validates field definitions', async () => {
  const db = await freshIsolatedDatabase();
  try {
    await seedOwnersAndUniverses(db);
    await assert.rejects(
      db.query("INSERT INTO content_type_configs(content_type_id,owner_id,field_schema) VALUES (200,1,'[]')"),
      /owner does not match/i,
    );
    await assert.rejects(
      db.query("INSERT INTO content_type_configs(content_type_id,owner_id,field_schema) VALUES (100,1,'[{\"key\":\"rarity\",\"label\":\"Rarity\",\"type\":\"javascript\"}]') ON CONFLICT (content_type_id) DO UPDATE SET field_schema=EXCLUDED.field_schema"),
      /Invalid content type field definition/i,
    );
    await assert.rejects(
      db.query("INSERT INTO content_type_configs(content_type_id,owner_id,field_schema) VALUES (100,1,'[{\"key\":\"same\",\"label\":\"One\",\"type\":\"text\"},{\"key\":\"same\",\"label\":\"Two\",\"type\":\"date\"}]') ON CONFLICT (content_type_id) DO UPDATE SET field_schema=EXCLUDED.field_schema"),
      /keys must be unique/i,
    );
  } finally { await db.close(); }
});

test('groups accept mixed types and multiple memberships without changing item scope', async () => {
  const db = await freshIsolatedDatabase();
  try {
    await seedOwnersAndUniverses(db);
    await db.query("INSERT INTO content_items(owner_id,type_key,scope_kind,universe_id,name) VALUES (1,'character','universe',10,'C'),(1,'note','pending',NULL,'P')");
    await db.query("INSERT INTO content_items(owner_id,type_key,content_type_id,scope_kind,universe_id,name) VALUES (1,'custom',100,'global',NULL,'R')");
    await db.query("INSERT INTO content_groups(id,owner_id,space_type,name) VALUES (1,1,'account','Royal Family'),(2,1,'account','History')");
    await db.query('INSERT INTO content_group_items(owner_id,group_id,item_id) VALUES (1,1,1),(1,1,2),(1,2,1),(1,1,3)');
    const counts = await db.query('SELECT count(*)::int AS items FROM content_group_items WHERE owner_id=1 AND group_id=1');
    const scope = await db.query('SELECT scope_kind,universe_id FROM content_items WHERE owner_id=1 AND id=2');
    assert.equal(counts.rows[0].items, 3);
    assert.deepEqual(scope.rows[0], { scope_kind: 'pending', universe_id: null });
  } finally { await db.close(); }
});

test('owner and universe boundaries reject invalid memberships', async () => {
  const db = await freshIsolatedDatabase();
  try {
    await seedOwnersAndUniverses(db);
    await db.query("INSERT INTO content_items(owner_id,type_key,scope_kind,universe_id,name) VALUES (1,'character','universe',10,'A'),(1,'character','universe',11,'A2'),(2,'character','universe',20,'B')");
    await db.query("INSERT INTO content_groups(id,owner_id,space_type,universe_id,name) VALUES (1,1,'universe',10,'A group'),(2,2,'account',NULL,'B group')");
    await db.query('INSERT INTO content_group_items(owner_id,group_id,item_id) VALUES (1,1,1)');
    await assert.rejects(db.query('INSERT INTO content_group_items(owner_id,group_id,item_id) VALUES (1,1,2)'), /Universe grouping accepts only items from that universe/);
    await assert.rejects(db.query('INSERT INTO content_group_items(owner_id,group_id,item_id) VALUES (1,2,3)'), /membership owner/i);
    await assert.rejects(db.query("INSERT INTO content_items(owner_id,type_key,scope_kind,universe_id,name) VALUES (1,'pending','pending',10,'invalid')"), /check constraint/i);
  } finally { await db.close(); }
});

test('subgroups reject cycles and incompatible parents; deletion preserves items', async () => {
  const db = await freshIsolatedDatabase();
  try {
    await seedOwnersAndUniverses(db);
    await db.query("INSERT INTO content_items(owner_id,type_key,scope_kind,universe_id,name) VALUES (1,'character','universe',10,'C')");
    await db.query("INSERT INTO content_groups(id,owner_id,space_type,universe_id,name) VALUES (1,1,'universe',10,'Root'),(2,1,'universe',10,'Child'),(3,1,'universe',11,'Other')");
    await db.query('UPDATE content_groups SET parent_group_id=1 WHERE id=2');
    await assert.rejects(db.query('UPDATE content_groups SET parent_group_id=2 WHERE id=1'), /cycle/i);
    await assert.rejects(db.query('UPDATE content_groups SET parent_group_id=3 WHERE id=2'), /same owner and grouping space/i);
    await db.query('INSERT INTO content_group_items(owner_id,group_id,item_id) VALUES (1,2,1)');
    await db.query('DELETE FROM content_groups WHERE id=2 AND owner_id=1');
    const retained = await db.query('SELECT count(*)::int AS count FROM content_items WHERE owner_id=1 AND id=1');
    const membership = await db.query('SELECT count(*)::int AS count FROM content_group_items WHERE owner_id=1 AND group_id=2');
    assert.equal(retained.rows[0].count, 1);
    assert.equal(membership.rows[0].count, 0);
  } finally { await db.close(); }
});

test('preinspection reports owner/scope conflicts without modifying legacy records', async () => {
  const db = await freshIsolatedDatabase();
  try {
    await seedOwnersAndUniverses(db);
    await db.query("INSERT INTO characters(id,owner_id,scope_kind,universe_id,name) VALUES (7,1,'universe',10,'C1'),(8,2,'universe',20,'C2')");
    await db.query("INSERT INTO archive_entries(id,owner_id,scope_kind,universe_id,parent_id,kind,name) VALUES (7,2,'universe',20,NULL,'note','E7'),(9,1,'universe',10,7,'note','E9')");
    await db.query('INSERT INTO character_relationships(id,owner_id,source_character_id,target_character_id) VALUES (4,1,7,8)');
    await db.query('INSERT INTO entry_links(id,owner_id,source_entry_id,target_character_id) VALUES (5,1,9,8)');
    const before = await db.query('SELECT id,parent_id,name FROM archive_entries ORDER BY id');
    const report = await inspectLegacyData(db);
    const after = await db.query('SELECT id,parent_id,name FROM archive_entries ORDER BY id');
    const codes = report.conflicts.map(row => row.code);
    assert.equal(report.safeToBackfill, false);
    assert.ok(codes.includes('invalid_entry_parents'));
    assert.ok(codes.includes('invalid_character_relationships'));
    assert.ok(codes.includes('invalid_entry_links'));
    assert.deepEqual(after.rows, before.rows);
    assert.ok(report.informational.some(row => row.code === 'overlapping_legacy_numeric_ids'));
  } finally { await db.close(); }
});

test('preinspection blocks schema DDL when synthetic legacy conflicts exist', async () => {
  const db = await freshIsolatedDatabase({ applySchema: false });
  try {
    await db.query('INSERT INTO users(id) VALUES (1),(2)');
    await db.query("INSERT INTO universes(id,owner_id,name) VALUES (10,1,'A'),(20,2,'B')");
    await db.query("INSERT INTO archive_entries(id,owner_id,scope_kind,universe_id,parent_id,kind,name) VALUES (1,2,'universe',20,NULL,'note','Other'),(2,1,'universe',10,1,'note','Cross-parent')");
    await assert.rejects(applyPhase2SchemaForIsolatedTest(db), error => error.code === 'PHASE2_PREFLIGHT_FAILED' && error.report.conflicts.some(row => row.code === 'invalid_entry_parents'));
    const schema = await db.query("SELECT to_regclass('public.content_items') AS table_name");
    assert.equal(schema.rows[0].table_name, null, 'preflight failure occurs before Phase 2 DDL');
  } finally { await db.close(); }
});
