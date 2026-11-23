import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { initializeDatabase } from '../src/db.js';
import { applyPhase2SchemaForIsolatedTest } from '../src/phase2-schema.js';

function makePglitePool(db) {
  const query = (...args) => db.query(...args);
  return {
    query,
    async connect() { return { query, release() {} }; },
    async end() { await db.close(); },
  };
}

async function responseJson(response) {
  return response.status === 204 ? null : response.json();
}

test('real Express auth, legacy routes, and v2 routes use a disposable PGlite database over HTTP', async t => {
  // Fail closed before opening a database or executing any DDL.
  assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL must be absent');
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'TEST_DATABASE_URL must be absent');
  const db = new PGlite('memory://');
  const pool = makePglitePool(db);
  const identity = await db.query('SELECT version() AS version, current_database() AS database, inet_server_addr() AS address');
  assert.match(identity.rows[0].version, /PGlite/);
  assert.equal(identity.rows[0].address, null, 'PGlite memory has no TCP address');

  let server;
  let base;
  try {
    await initializeDatabase(pool);
    await applyPhase2SchemaForIsolatedTest(db);
    const app = createApp({ databasePool: pool });
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    await pool.end();
    throw error;
  }

  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  });

  async function request(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await responseJson(response) };
  }

  const denied = await request('/api/auth/me');
  assert.equal(denied.status, 401);
  assert.equal((await request('/api/health')).status, 200);
  const first = await request('/api/auth/register', { method: 'POST', body: { username: 'writer-one', email: 'one@example.test', password: 'long-password-one' } });
  const second = await request('/api/auth/register', { method: 'POST', body: { username: 'writer-two', email: 'two@example.test', password: 'long-password-two' } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstToken = first.data.token;
  const secondToken = second.data.token;
  assert.equal((await request('/api/auth/me', { token: firstToken })).data.user.username, 'writer-one');
  const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'one@example.test', password: 'long-password-one' } });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  assert.equal((await request('/api/auth/me', { token: login.data.token })).status, 200, 'session survives across HTTP requests');

  const universe = await request('/api/universes', { method: 'POST', token: firstToken, body: { name: 'HTTP universe' } });
  assert.equal(universe.status, 201);
  assert.equal((await request(`/api/universes/${universe.data.id}`, { method: 'PUT', token: firstToken, body: { name: 'HTTP universe renamed' } })).status, 200);
  const disposableUniverse = await request('/api/universes', { method: 'POST', token: firstToken, body: { name: 'Temporary universe' } });
  const universeDeletedCharacter = await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Demoted character', scope_kind: 'universe', universe_id: disposableUniverse.data.id } });
  const universeDeletedEntry = await request('/api/entries', { method: 'POST', token: firstToken, body: { name: 'Demoted entry', kind: 'note', scope_kind: 'universe', universe_id: disposableUniverse.data.id } });
  assert.equal((await request(`/api/universes/${disposableUniverse.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  for (const identity of [['character', universeDeletedCharacter.data.id], ['archive_entry', universeDeletedEntry.data.id]]) {
    const row = await db.query('SELECT scope_kind,universe_id FROM content_items WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3', [first.data.user.id, identity[0], identity[1]]);
    assert.deepEqual(row.rows[0], { scope_kind: 'pending', universe_id: null }, 'universe deletion updates legacy and registry scopes in one transaction');
  }
  const node = await request(`/api/universes/${universe.data.id}/nodes`, { method: 'POST', token: firstToken, body: { name: 'Root', node_type: 'realm', description: 'Root level', sort_order: 4 } });
  assert.equal(node.status, 201);
  const childNode = await request(`/api/universes/${universe.data.id}/nodes`, { method: 'POST', token: firstToken, body: { name: 'Child', node_type: 'seat', description: 'Child level', parent_id: node.data.id, sort_order: 1 } });
  assert.equal(childNode.status, 201);
  const character = await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Mira', scope_kind: 'universe', universe_id: universe.data.id, universe_node_id: childNode.data.id, details: { hidden: 'keep' }, tags: 'pilot, archivist' } });
  const target = await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Sol', scope_kind: 'universe', universe_id: universe.data.id } });
  assert.equal(character.status, 201);
  assert.equal(target.status, 201);
  assert.deepEqual((await request(`/api/characters/${character.data.id}`, { token: firstToken })).data.details, { hidden: 'keep' },
    'the owner-scoped detail route supplies the complete legacy editor shape');
  const characterMirror = await db.query("SELECT id,source_kind,source_id,tags,data->'details' AS details FROM content_items WHERE owner_id=$1 AND source_kind='character' AND source_id=$2", [first.data.user.id, character.data.id]);
  assert.equal(characterMirror.rows.length, 1);
  assert.deepEqual(characterMirror.rows[0].details, { hidden: 'keep' });
  assert.deepEqual(characterMirror.rows[0].tags, ['pilot', 'archivist']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM phase2_legacy_node_memberships WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3', [first.data.user.id, 'character', character.data.id])).rows[0].n, 1);
  const successfulEdit = await request(`/api/characters/${character.data.id}`, { method: 'PUT', token: firstToken, body: { name: 'Mira', scope_kind: 'universe', universe_id: universe.data.id, universe_node_id: childNode.data.id, tags: 'pilot, archivist' } });
  assert.equal(successfulEdit.status, 200);
  assert.deepEqual((await db.query("SELECT data->'details' AS details FROM content_items WHERE owner_id=$1 AND source_kind='character' AND source_id=$2", [first.data.user.id, character.data.id])).rows[0].details, { hidden: 'keep' }, 'omitting unrendered character details preserves them');
  assert.equal((await request(`/api/nodes/${childNode.data.id}`, { method: 'PUT', token: firstToken, body: { name: 'Child renamed', node_type: 'seat', description: 'Moved through v1', sort_order: 8, universe_id: universe.data.id, parent_id: null } })).status, 200);
  const childGroup = await db.query('SELECT g.name,g.sort_order,g.parent_group_id FROM content_groups g JOIN phase2_universe_node_group_map m ON m.group_id=g.id WHERE m.owner_id=$1 AND m.source_node_id=$2', [first.data.user.id, childNode.data.id]);
  assert.deepEqual(childGroup.rows[0], { name: 'Child renamed', sort_order: 8, parent_group_id: null });
  assert.equal((await request(`/api/nodes/${childNode.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  const afterNodeDelete = await db.query(`SELECT c.universe_node_id,i.data->>'universe_node_id' AS snapshot_node
    FROM characters c JOIN content_items i ON i.owner_id=c.owner_id AND i.source_kind=$2 AND i.source_id=c.id
    WHERE c.owner_id=$1 AND c.id=$3`, [first.data.user.id, 'character', character.data.id]);
  assert.equal(afterNodeDelete.rows[0].universe_node_id, null);
  assert.equal(afterNodeDelete.rows[0].snapshot_node, null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM content_group_items WHERE owner_id=$1 AND item_id=$2', [first.data.user.id, characterMirror.rows[0].id])).rows[0].n, 0);
  assert.equal((await request(`/api/characters/${character.data.id}`, { token: secondToken })).status, 404);

  const legacyType = await request('/api/content-types', { method: 'POST', token: firstToken, body: { label: 'Old Artifact', icon: 'gem' } });
  assert.equal(legacyType.status, 201);
  assert.equal((await request(`/api/v2/content-types/${legacyType.data.id}`, { method: 'PATCH', token: firstToken, body: { field_schema: [{ key: 'rarity', label: 'Rarity', type: 'text' }] } })).status, 200);
  const entry = await request('/api/entries', { method: 'POST', token: firstToken, body: { kind: legacyType.data.slug, name: 'North Harbor', scope_kind: 'global', tags: ['port'], data: { rarity: 'rare', hidden_importer_value: 'retain' } } });
  assert.equal(entry.status, 201);
  const place = await request('/api/entries', { method: 'POST', token: firstToken, body: { name: 'Birth city', kind: 'location', scope_kind: 'universe', universe_id: universe.data.id } });
  const foreignUniverse = await request('/api/universes', { method: 'POST', token: firstToken, body: { name: 'Other location universe' } });
  const foreignPlace = await request('/api/entries', { method: 'POST', token: firstToken, body: { name: 'Foreign city', kind: 'location', scope_kind: 'universe', universe_id: foreignUniverse.data.id } });
  const anotherOwnersPlace = await request('/api/entries', { method: 'POST', token: secondToken, body: { name: 'Private city', kind: 'location', scope_kind: 'global' } });
  const linkedCharacter = await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Linked character', scope_kind: 'universe', universe_id: universe.data.id, details: { importer_field: 'preserve', location_links: { birthplace_id: place.data.id, current_residence_id: place.data.id, former_residence_ids: [], visited_place_ids: [place.data.id], family_cultural_origin: 'Coastal', nationality: 'North' } } } });
  assert.equal(linkedCharacter.status, 201, 'same-universe place links are accepted');
  assert.equal((await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Cross-universe link', scope_kind: 'universe', universe_id: universe.data.id, details: { location_links: { birthplace_id: foreignPlace.data.id } } } })).status, 400);
  assert.equal((await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Other-owner link', scope_kind: 'universe', universe_id: universe.data.id, details: { location_links: { birthplace_id: anotherOwnersPlace.data.id } } } })).status, 400);
  assert.equal((await request(`/api/entries/${anotherOwnersPlace.data.id}`, { method: 'DELETE', token: secondToken })).status, 204);
  const editedLinked = await request(`/api/characters/${linkedCharacter.data.id}`, { method: 'PUT', token: firstToken, body: { name: 'Linked character edited', scope_kind: 'universe', universe_id: universe.data.id } });
  assert.deepEqual(editedLinked.data.details.location_links.visited_place_ids, [place.data.id], 'editing without rendering details preserves structured place links');
  const legacyTypeId = legacyType.data.id;
  const entryMirror = await db.query("SELECT type_key,content_type_id,data->'data' AS fields FROM content_items WHERE owner_id=$1 AND source_kind='archive_entry' AND source_id=$2", [first.data.user.id, entry.data.id]);
  assert.equal(entryMirror.rows[0].type_key, legacyType.data.slug);
  assert.equal(entryMirror.rows[0].content_type_id, legacyTypeId);
  assert.deepEqual(entryMirror.rows[0].fields, { rarity: 'rare', hidden_importer_value: 'retain' });
  assert.equal((await request(`/api/entries/${entry.data.id}`, { method: 'PUT', token: firstToken, body: { kind: legacyType.data.slug, name: 'North Harbor', scope_kind: 'global', tags: ['port'] } })).status, 200);
  assert.deepEqual((await db.query("SELECT data->'data' AS fields FROM content_items WHERE owner_id=$1 AND source_kind='archive_entry' AND source_id=$2", [first.data.user.id, entry.data.id])).rows[0].fields, { rarity: 'rare', hidden_importer_value: 'retain' }, 'omitting unrendered entry payload preserves it');
  assert.equal((await request(`/api/entries/${entry.data.id}`, { method: 'PUT', token: firstToken, body: { kind: legacyType.data.slug, name: 'North Harbor renamed', scope_kind: 'global', tags: ['port'], data: { rarity: 'common', hidden_importer_value: 'retain' } } })).status, 200);
  assert.deepEqual((await db.query("SELECT data->'data' AS fields FROM content_items WHERE owner_id=$1 AND source_kind='archive_entry' AND source_id=$2", [first.data.user.id, entry.data.id])).rows[0].fields, { rarity: 'common', hidden_importer_value: 'retain' });
  assert.deepEqual((await db.query('SELECT field_schema FROM content_type_configs WHERE owner_id=$1 AND content_type_id=$2', [first.data.user.id, legacyTypeId])).rows[0].field_schema,
    [{ key: 'rarity', label: 'Rarity', type: 'text' }], 'v1 item edits do not rewrite the legacy type configuration');
  assert.equal((await request(`/api/entries/${entry.data.id}`, { method: 'PUT', token: secondToken, body: { kind: legacyType.data.slug, name: 'Stolen', scope_kind: 'global' } })).status, 404);

  await db.exec(`CREATE FUNCTION reject_legacy_mirror_update() RETURNS trigger AS $$ BEGIN
      IF NEW.name='Rejected update' THEN RAISE EXCEPTION 'synthetic mirror failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_legacy_mirror_update BEFORE UPDATE ON content_items FOR EACH ROW EXECUTE FUNCTION reject_legacy_mirror_update();`);
  const rejected = await request(`/api/characters/${character.data.id}`, { method: 'PUT', token: firstToken, body: { name: 'Rejected update', scope_kind: 'universe', universe_id: universe.data.id, tags: 'pilot, archivist', details: { hidden: 'keep' } } });
  assert.equal(rejected.status, 500);
  assert.equal((await db.query('SELECT name FROM characters WHERE id=$1 AND owner_id=$2', [character.data.id, first.data.user.id])).rows[0].name, 'Mira', 'a mirror failure rolls back the legacy edit too');
  assert.equal((await db.query("SELECT name FROM content_items WHERE owner_id=$1 AND source_kind='character' AND source_id=$2", [first.data.user.id, character.data.id])).rows[0].name, 'Mira');
  await db.exec('DROP TRIGGER reject_legacy_mirror_update ON content_items; DROP FUNCTION reject_legacy_mirror_update();');
  const globalCharacter = await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Global contact', scope_kind: 'global' } });
  const entryLink = await request(`/api/entries/${entry.data.id}/links`, { method: 'POST', token: firstToken, body: { target_type: 'character', target_id: globalCharacter.data.id, relation_type: 'located near' } });
  assert.equal(entryLink.status, 201);
  const linkedEntry = await request('/api/entries', { method: 'POST', token: firstToken, body: { kind: 'organization', name: 'Linked organization', scope_kind: 'global' } });
  const incomingEntryLink = await request(`/api/entries/${linkedEntry.data.id}/links`, { method: 'POST', token: firstToken, body: { target_type: 'entry', target_id: entry.data.id, relation_type: 'headquarters of' } });
  assert.equal(incomingEntryLink.status, 201);
  const reverseEntryLinks = await request(`/api/entries/${entry.data.id}/links`, { token: firstToken });
  assert.ok(reverseEntryLinks.data.some(link => link.id === incomingEntryLink.data.id && link.is_incoming && link.target_entry_name === 'Linked organization'), 'the opposite ficha can inspect the shared link');
  await request(`/api/entry-links/${incomingEntryLink.data.id}`, { method: 'DELETE', token: firstToken });
  const revisedEntryLink = await request(`/api/entry-links/${entryLink.data.id}`, { method: 'PUT', token: firstToken, body: { relation_type: 'headquarters', details: { role: 'capital', start_date: 'Year 1' } } });
  assert.equal(revisedEntryLink.status, 200);
  assert.equal(revisedEntryLink.data.details.role, 'capital');
  assert.equal((await request(`/api/entries/${entry.data.id}/links`, { token: firstToken })).data.length, 1);
  const relation = await request('/api/relationships', { method: 'POST', token: firstToken, body: { source_character_id: character.data.id, target_character_id: target.data.id, relation_type: 'ally' } });
  assert.equal(relation.status, 201);
  const favorite = await request('/api/favorites', { method: 'POST', token: firstToken, body: { entity_type: 'character', entity_id: character.data.id } });
  assert.equal(favorite.status, 201);
  const theme = { prompt: 'ink atlas', page_bg: '#111111', panel_bg: '#222222', ink: '#eeeeee', muted: '#aaaaaa', line: '#333333', accent: '#aa8844', sidebar_bg: '#000000', heading_font: 'serif', texture: 'plain', corner: 'soft' };
  assert.equal((await request(`/api/universes/${universe.data.id}/theme`, { token: firstToken })).status, 200);
  assert.equal((await request(`/api/universes/${universe.data.id}/theme`, { method: 'PUT', token: firstToken, body: theme })).status, 200);
  assert.equal((await request('/api/relationships', { token: firstToken })).data.length, 1);
  const network = await request('/api/relationships/network', { method: 'POST', token: firstToken, body: { source_character_id: character.data.id, target_character_ids: [target.data.id, linkedCharacter.data.id], relation_type: 'considered family', reverse_relation_type: 'family', reciprocal: true, status: 'Complicated', start_date: 'Year 3', history: 'They met during an expedition.', notes: 'Synthetic network fixture.' } });
  assert.equal(network.status, 201);
  assert.equal(network.data.relationships.length, 4, 'multiple participants and asymmetric directional edges are represented within one transaction');
  assert.ok(network.data.relationships.every(row => row.details.relation_group_id === network.data.relation_group_id));
  const networkEdit = await request(`/api/relationships/${network.data.relationships[0].id}`, { method: 'PUT', token: firstToken, body: { relation_type: 'protective', details: { history: 'Updated history' } } });
  assert.equal(networkEdit.status, 200);
  assert.equal(networkEdit.data.details.notes, 'Synthetic network fixture.', 'editing preserves relation details omitted by the form');
  assert.equal(networkEdit.data.details.history, 'Updated history');
  assert.equal((await request('/api/relationships?character_id=' + character.data.id, { token: secondToken })).data.length, 0, 'network records remain owner scoped');
  assert.equal((await request('/api/relationships/network', { method: 'POST', token: firstToken, body: { source_character_id: character.data.id, target_character_ids: [globalCharacter.data.id], relation_type: 'invalid scope' } })).status, 400);
  assert.equal((await request(`/api/relationships/groups/${network.data.relation_group_id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await request('/api/favorites', { token: firstToken })).data.length, 1);

  for (const path of ['/api/universes', '/api/characters', '/api/entries', '/api/relationships', '/api/favorites']) {
    const own = await request(path, { token: firstToken });
    const other = await request(path, { token: secondToken });
    assert.equal(own.status, 200, `${path} works for owner`);
    assert.equal(other.status, 200, `${path} works for second owner`);
    assert.equal(other.data.length, 0, `${path} does not leak owner's records`);
  }
  assert.equal((await request(`/api/universes/${universe.data.id}/theme`, { token: secondToken })).status, 404);

  const library = await request('/api/v2/content-items', { token: firstToken });
  assert.equal(library.status, 200);
  assert.ok(library.data.some(item => item.source_table === 'characters' && item.source_id === character.data.id));
  assert.ok(library.data.some(item => item.source_table === 'archive_entries' && item.source_id === entry.data.id));
  const sourceCharacter = await request(`/api/v2/content-items/source/characters/${character.data.id}`, { token: firstToken });
  const sourceEntry = await request(`/api/v2/content-items/source/archive_entries/${entry.data.id}`, { token: firstToken });
  assert.equal(sourceCharacter.data.source_table, 'characters');
  assert.equal(sourceCharacter.data.source_kind, 'character');
  assert.equal(sourceEntry.data.source_table, 'archive_entries');
  assert.equal(sourceEntry.data.source_kind, 'archive_entry');
  assert.equal(sourceCharacter.data.source_id, sourceEntry.data.source_id, 'matching legacy numeric IDs stay distinct through the HTTP source identity contract');
  assert.equal(sourceEntry.data.source_type, legacyType.data.slug);
  assert.equal((await request(`/api/v2/content-items/source/archive_entries/${entry.data.id}`, { token: secondToken })).status, 404);
  const scopedGroup = await request('/api/v2/groups', { method: 'POST', token: firstToken, body: { name: 'Universe scoped', universe_id: universe.data.id } });
  assert.equal(scopedGroup.status, 201);
  assert.equal((await request(`/api/v2/groups/${scopedGroup.data.id}/items`, { method: 'POST', token: firstToken, body: { item_id: characterMirror.rows[0].id } })).status, 201);
  const blockedScopeChange = await request(`/api/characters/${character.data.id}`, { method: 'PUT', token: firstToken, body: { name: 'Mira', scope_kind: 'global' } });
  assert.equal(blockedScopeChange.status, 409, 'a source scope cannot contradict a universe-only membership');
  assert.equal((await db.query('SELECT scope_kind,universe_id FROM characters WHERE owner_id=$1 AND id=$2', [first.data.user.id, character.data.id])).rows[0].scope_kind, 'universe');
  assert.equal((await request(`/api/v2/groups/${scopedGroup.data.id}/items/${characterMirror.rows[0].id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await request(`/api/v2/groups/${scopedGroup.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.ok((await request('/api/v2/content-types', { token: firstToken })).data.some(row => row.id === legacyTypeId && row.slug === legacyType.data.slug),
    'the old content type and slug remain visible through the v2 list');
  const phase2TypeInvalid = await request('/api/v2/content-types', { method: 'POST', token: firstToken, body: { label: 'Bad type', field_schema: [{ key: 'x', label: 'Choice', type: 'select' }] } });
  assert.equal(phase2TypeInvalid.status, 400);
  const type = await request('/api/v2/content-types', { method: 'POST', token: firstToken, body: { label: 'Relic', icon: 'gem', field_schema: [{ key: 'rarity', label: 'Rarity', type: 'select', options: ['rare', 'common'] }] } });
  assert.equal(type.status, 201);
  assert.ok((await request('/api/v2/content-types', { token: firstToken })).data.some(row => row.slug === 'relic'));

  const registry = await db.query(`SELECT id FROM content_items
    WHERE owner_id=$1 AND source_kind='character' AND source_id=$2`, [first.data.user.id, character.data.id]);
  assert.equal(registry.rowCount, 1, 'the v1 create transaction also creates one v2 identity');
  const itemId = registry.rows[0].id;
  const group = await request('/api/v2/groups', { method: 'POST', token: firstToken, body: { name: 'Constellation', space_type: 'account' } });
  assert.equal(group.status, 201);
  const child = await request('/api/v2/groups', { method: 'POST', token: firstToken, body: { name: 'Inner circle', parent_group_id: group.data.id } });
  assert.equal(child.status, 201);
  assert.equal(child.data.space_type, 'account');
  assert.equal((await request(`/api/v2/groups/${child.data.id}/items`, { method: 'POST', token: firstToken, body: { item_id: itemId } })).status, 201);
  assert.equal((await request(`/api/v2/groups/${child.data.id}/items`, { token: firstToken })).data.length, 1);
  assert.equal((await request(`/api/v2/groups/${group.data.id}/reorder`, { method: 'PATCH', token: firstToken, body: { sort_order: 9 } })).data.sort_order, 9);
  assert.equal((await request(`/api/v2/groups/${group.data.id}`, { method: 'PATCH', token: firstToken, body: { description: 'Updated over HTTP' } })).status, 200);
  assert.equal((await request(`/api/v2/groups/${group.data.id}`, { token: secondToken })).status, 404);
  assert.equal((await request(`/api/v2/groups/${child.data.id}/move`, { method: 'PATCH', token: firstToken, body: { parent_group_id: null, space_type: 'account', universe_id: null } })).status, 200);
  assert.equal((await request(`/api/v2/groups/${child.data.id}/items/${itemId}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await db.query('SELECT id FROM content_items WHERE owner_id=$1 AND id=$2', [first.data.user.id, itemId])).rowCount, 1);
  assert.equal((await request(`/api/v2/groups/${child.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await request(`/api/v2/groups/${group.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);

  assert.equal((await request(`/api/relationships/${relation.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await request(`/api/entry-links/${entryLink.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await request(`/api/favorites/character/${character.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  const disposableCharacter = await request('/api/characters', { method: 'POST', token: firstToken, body: { name: 'Temporary', scope_kind: 'pending' } });
  const disposableEntry = await request('/api/entries', { method: 'POST', token: firstToken, body: { kind: 'note', name: 'Temporary note', scope_kind: 'pending' } });
  assert.equal((await request(`/api/characters/${disposableCharacter.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await request(`/api/entries/${disposableEntry.data.id}`, { method: 'DELETE', token: firstToken })).status, 204);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM content_items WHERE owner_id=$1 AND ((source_kind='character' AND source_id=$2) OR (source_kind='archive_entry' AND source_id=$3))", [first.data.user.id, disposableCharacter.data.id, disposableEntry.data.id])).rows[0].n, 0,
    'v1 deletes remove only the matching source identities and their registry projections');

  assert.equal((await request('/api/auth/logout', { method: 'POST', token: login.data.token })).status, 204);
  assert.equal((await request('/api/auth/me', { token: login.data.token })).status, 401);
  assert.equal((await request('/api/characters', { token: firstToken })).status, 200, 'logout revokes only its own session');
});
