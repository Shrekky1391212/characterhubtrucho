import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { initializeDatabase } from '../src/db.js';
import { applyPhase2SchemaForIsolatedTest } from '../src/phase2-schema.js';
import { backfillPhase2Content, preflightPhase2Backfill } from '../src/phase2-backfill.js';

async function freshDatabase({ applySchema = true } = {}) {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.TEST_DATABASE_URL, undefined);
  const db = new PGlite('memory://');
  const identity = await db.query('SELECT version() AS version,inet_server_addr() AS address');
  assert.match(identity.rows[0].version, /PGlite/);
  assert.equal(identity.rows[0].address, null);
  const query = (...args) => db.query(...args);
  const pool = { query, async connect() { return { query, release() {} }; }, async end() { await db.close(); } };
  await initializeDatabase(pool);
  if (applySchema) await applyPhase2SchemaForIsolatedTest(db);
  return { db, pool };
}

async function seedRepresentativeData(db) {
  await db.query("INSERT INTO users(id,username,email,password_hash,password_salt) VALUES(1,'one','one@test.invalid','x','x'),(2,'two','two@test.invalid','x','x')");
  await db.query(`INSERT INTO universes(id,owner_id,name) VALUES
    (101,1,'A'),(102,1,'B'),(201,2,'C')`);
  await db.query(`INSERT INTO content_types(id,owner_id,slug,label,icon) VALUES(301,1,'artifact','Artifact','gem')`);
  if ((await db.query("SELECT to_regclass('public.content_type_configs') IS NOT NULL AS installed")).rows[0].installed) await seedTypeConfig(db);
  await db.query(`INSERT INTO universe_themes(universe_id,owner_id,prompt) VALUES
    (101,1,'theme A'),(102,1,'theme B')`);
  await db.query(`INSERT INTO universe_nodes(id,owner_id,universe_id,parent_id,name,node_type,description,sort_order) VALUES
    (401,1,101,NULL,'Realm','realm','Root level',4),
    (402,1,101,401,'Citadel','seat','Nested level',8),
    (403,1,102,NULL,'Other world','world','Second root',2)`);
  await db.query(`INSERT INTO characters(id,owner_id,universe_id,scope_kind,universe_node_id,name,tags,details) VALUES
    (7,1,101,'universe',402,'Mira','pilot, archivist','{"voice":"low"}'),
    (10,1,101,'universe',402,'Sol','captain','{"rank":3}'),
    (11,1,NULL,'pending',NULL,'Unsorted','', '{}'),
    (20,2,201,'universe',NULL,'Other owner','', '{}')`);
  await db.query(`INSERT INTO archive_entries(id,owner_id,universe_id,scope_kind,universe_node_id,parent_id,kind,name,tags,data) VALUES
    (7,1,101,'universe',402,NULL,'artifact','Moon relic',ARRAY['silver'], '{"weight":12}'),
    (8,1,NULL,'global',NULL,NULL,'story','History','{}','{"text":"once"}'),
    (9,1,NULL,'global',NULL,8,'note','Appendix','{}','{"text":"continued"}')`);
  await db.query(`INSERT INTO character_relationships(owner_id,source_character_id,target_character_id,relation_type)
    VALUES(1,7,10,'ally')`);
  await db.query(`INSERT INTO entry_links(owner_id,source_entry_id,target_character_id,relation_type)
    VALUES(1,7,7,'held by')`);
}

async function seedTypeConfig(db) {
  await db.query(`INSERT INTO content_type_configs(content_type_id,owner_id,sort_order,field_schema)
    VALUES(301,1,5,'[{"key":"rarity","label":"Rarity","type":"text"}]') ON CONFLICT(content_type_id) DO NOTHING`);
}

test('read-only preflight reports counts, scopes, overlaps, and cutover risk without DML', async () => {
  const { db, pool } = await freshDatabase({ applySchema: false });
  try {
    await seedRepresentativeData(db);
    await applyPhase2SchemaForIsolatedTest(db);
    await seedTypeConfig(db);
    const before = await db.query('SELECT count(*)::int AS n FROM content_items');
    const report = await preflightPhase2Backfill(db);
    const after = await db.query('SELECT count(*)::int AS n FROM content_items');
    assert.equal(report.safeToBackfill, true);
    assert.equal(report.readyForRealCutover, false);
    assert.equal(report.counts.characters, 4);
    assert.equal(report.counts.archive_entries, 3);
    assert.equal(report.counts.universe_nodes, 3);
    assert.equal(report.counts.newItemsExpected, 7);
    assert.ok(report.informational.some(row => row.code === 'overlapping_legacy_numeric_ids'));
    assert.ok(report.warnings.some(row => row.code === 'legacy_api_write_cutover_required'));
    assert.deepEqual(after.rows, before.rows);
  } finally { await pool.end(); }
});

test('synthetic backfill preserves source snapshots, scopes, owners, dynamic slugs, nodes, and relations; reruns are idempotent', async () => {
  const { db, pool } = await freshDatabase({ applySchema: false });
  try {
    await seedRepresentativeData(db);
    await applyPhase2SchemaForIsolatedTest(db);
    await seedTypeConfig(db);
    const oldTablesBefore = await db.query(`SELECT
      (SELECT count(*)::int FROM characters) AS characters,
      (SELECT count(*)::int FROM archive_entries) AS entries,
      (SELECT count(*)::int FROM universe_nodes) AS nodes,
      (SELECT count(*)::int FROM universe_themes) AS themes,
      (SELECT count(*)::int FROM character_relationships) AS character_relations,
      (SELECT count(*)::int FROM entry_links) AS entry_relations,
      (SELECT count(*)::int FROM content_types) AS types,
      (SELECT count(*)::int FROM content_type_configs) AS configs`);
    const report = await preflightPhase2Backfill(db, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true });
    assert.equal(report.readyForRealCutover, true);
    const result = await backfillPhase2Content(db, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true });
    assert.equal(result.status, 'committed');
    assert.deepEqual(result.insertedItems, { characters: 4, archive_entries: 3 });
    assert.deepEqual(result.insertedGroups, { created: 3, alreadyMapped: 0, intentionallyRemoved: 0 });
    assert.deepEqual(result.insertedMemberships, { characters: 2, archive_entries: 1 });
    assert.equal(result.verification.sourceItems, 7);
    assert.equal(result.verification.missingItems, 0);
    assert.equal(result.verification.missingMemberships, 0);

    const colliding = await db.query(`SELECT source_kind,source_id,type_key,owner_id FROM content_items
      WHERE source_id=7 ORDER BY source_kind`);
    assert.deepEqual(colliding.rows, [
      { source_kind: 'archive_entry', source_id: 7, type_key: 'artifact', owner_id: 1 },
      { source_kind: 'character', source_id: 7, type_key: 'character', owner_id: 1 },
    ]);
    const character = await db.query("SELECT tags,data,scope_kind,universe_id FROM content_items WHERE source_kind='character' AND source_id=7");
    assert.deepEqual(character.rows[0].tags, ['pilot', 'archivist']);
    assert.deepEqual(character.rows[0].data.details, { voice: 'low' });
    assert.equal(character.rows[0].scope_kind, 'universe');
    assert.equal(character.rows[0].universe_id, 101);
    const customEntry = await db.query("SELECT type_key,content_type_id,data FROM content_items WHERE source_kind='archive_entry' AND source_id=7");
    assert.equal(customEntry.rows[0].type_key, 'artifact');
    assert.equal(customEntry.rows[0].content_type_id, 301, 'legacy type identity is linked by exact owner and slug without changing the slug');
    assert.deepEqual(customEntry.rows[0].data.data, { weight: 12 });

    const groups = await db.query(`SELECT g.id,g.name,g.parent_group_id,g.sort_order,m.source_data->>'node_type' AS node_type
      FROM phase2_universe_node_group_map m JOIN content_groups g ON g.owner_id=m.owner_id AND g.id=m.group_id
      ORDER BY m.source_node_id`);
    assert.equal(groups.rows.length, 3);
    assert.equal(groups.rows.find(row => row.name === 'Citadel').parent_group_id, groups.rows.find(row => row.name === 'Realm').id);
    assert.equal(groups.rows.find(row => row.name === 'Citadel').sort_order, 8);
    assert.equal(groups.rows.find(row => row.name === 'Citadel').node_type, 'seat');
    const memberships = await db.query(`SELECT i.source_kind,i.source_id,g.name FROM content_group_items m
      JOIN content_items i ON i.owner_id=m.owner_id AND i.id=m.item_id
      JOIN content_groups g ON g.owner_id=m.owner_id AND g.id=m.group_id ORDER BY i.source_kind,i.source_id`);
    assert.deepEqual(memberships.rows.map(row => `${row.source_kind}:${row.source_id}:${row.name}`), [
      'archive_entry:7:Citadel','character:7:Citadel','character:10:Citadel',
    ]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM content_group_items m JOIN content_items i ON i.id=m.item_id WHERE i.source_id IN (8,9,11,20)")).rows[0].n, 0,
      'items without universe_node_id remain without migration-created memberships; archive_entries.parent_id was not interpreted as a group');
    const oldTablesAfter = await db.query(`SELECT
      (SELECT count(*)::int FROM characters) AS characters,
      (SELECT count(*)::int FROM archive_entries) AS entries,
      (SELECT count(*)::int FROM universe_nodes) AS nodes,
      (SELECT count(*)::int FROM universe_themes) AS themes,
      (SELECT count(*)::int FROM character_relationships) AS character_relations,
      (SELECT count(*)::int FROM entry_links) AS entry_relations,
      (SELECT count(*)::int FROM content_types) AS types,
      (SELECT count(*)::int FROM content_type_configs) AS configs`);
    assert.deepEqual(oldTablesAfter.rows, oldTablesBefore.rows);
    assert.equal((await db.query("SELECT prompt FROM universe_themes WHERE universe_id=101")).rows[0].prompt, 'theme A');
    assert.equal((await db.query('SELECT field_schema FROM content_type_configs WHERE content_type_id=301')).rows[0].field_schema[0].key, 'rarity');

    const rerunPreflight = await preflightPhase2Backfill(db, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true });
    assert.equal(rerunPreflight.safeToBackfill, true, JSON.stringify(rerunPreflight.conflicts));
    const rerun = await backfillPhase2Content(db, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true });
    assert.deepEqual(rerun.insertedItems, { characters: 0, archive_entries: 0 });
    assert.equal(rerun.insertedGroups.created, 0);
    assert.deepEqual(rerun.insertedMemberships, { characters: 0, archive_entries: 0 });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM content_items WHERE source_kind IS NOT NULL')).rows[0].n, 7);
  } finally { await pool.end(); }
});

test('preflight blocks unresolved owner/scope and type conflicts and the cutover gate blocks execution', async () => {
  const { db, pool } = await freshDatabase();
  try {
    await seedRepresentativeData(db);
    await db.query('ALTER TABLE characters DISABLE TRIGGER characters_phase2_sync');
    await db.query('ALTER TABLE characters DROP CONSTRAINT characters_scope_kind_check');
    await db.query("UPDATE characters SET universe_id=101 WHERE id=11");
    await db.query('ALTER TABLE characters ENABLE TRIGGER characters_phase2_sync');
    await db.query('ALTER TABLE archive_entries DISABLE TRIGGER archive_entries_phase2_sync');
    await db.query("UPDATE archive_entries SET kind='undefined_kind' WHERE id=7");
    await db.query('ALTER TABLE archive_entries ENABLE TRIGGER archive_entries_phase2_sync');
    const report = await preflightPhase2Backfill(db);
    const codes = report.conflicts.map(row => row.code);
    assert.equal(report.safeToBackfill, false);
    assert.ok(codes.includes('invalid_character_scope'));
    assert.ok(codes.includes('orphan_custom_entry_types'));
    await assert.rejects(backfillPhase2Content(db), error => error.code === 'BACKFILL_CUTOVER_NOT_VERIFIED');
    await assert.rejects(backfillPhase2Content(db, { writeCutoverVerified: true }), error => error.code === 'BACKFILL_CUTOVER_NOT_VERIFIED');
    await assert.rejects(backfillPhase2Content(db, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true }), error => error.code === 'BACKFILL_PREFLIGHT_FAILED' && error.rolledBack === true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM content_items WHERE source_kind IS NOT NULL')).rows[0].n, 7,
      'pre-existing registry mirrors from the schema-active phase remain unchanged when preflight blocks');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM content_groups')).rows[0].n, 3,
      'legacy node groups created transactionally at node-write time remain unchanged');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM characters WHERE id=11 AND universe_id=101')).rows[0].n, 1);
  } finally { await pool.end(); }
});

test('unexpected failure after character inserts rolls the entire backfill back', async () => {
  const { db, pool } = await freshDatabase({ applySchema: false });
  try {
    await seedRepresentativeData(db);
    await applyPhase2SchemaForIsolatedTest(db);
    await seedTypeConfig(db);
    await db.exec(`CREATE FUNCTION reject_archive_item_backfill() RETURNS trigger AS $$
      BEGIN IF NEW.source_kind='archive_entry' THEN RAISE EXCEPTION 'synthetic injected failure'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_archive_item_backfill BEFORE INSERT ON content_items
      FOR EACH ROW EXECUTE FUNCTION reject_archive_item_backfill();`);
    await assert.rejects(backfillPhase2Content(db, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true }), error => error.rolledBack === true && /synthetic injected failure/.test(error.message));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM content_items')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM content_groups')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM phase2_universe_node_group_map')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM content_group_items')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM characters')).rows[0].n, 4);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM archive_entries')).rows[0].n, 3);
  } finally { await pool.end(); }
});
