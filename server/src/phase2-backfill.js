import { inspectLegacyData } from './phase2-schema.js';

const sourceSnapshotQuery = `
  SELECT 'characters'::text AS source_table, c.id AS source_id, c.owner_id, 'character'::text AS type_key,
    c.scope_kind, c.universe_id, c.name, c.description, c.tags::text AS tags, to_jsonb(c) AS source_data
  FROM characters c
  UNION ALL
  SELECT 'archive_entries', e.id, e.owner_id, e.kind, e.scope_kind, e.universe_id,
    e.name, e.description, e.tags::text, to_jsonb(e)
  FROM archive_entries e`;

async function countRows(client, table) {
  const result = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
  return Number(result.rows[0].count);
}

async function inspectExistingRegistry(client) {
  const result = await client.query(`WITH source_rows AS (${sourceSnapshotQuery})
    SELECT s.source_table,s.source_id,s.owner_id AS source_owner_id,s.type_key AS source_type_key,
      s.scope_kind AS source_scope,s.universe_id AS source_universe_id,
      i.id AS content_item_id,i.owner_id AS item_owner_id,i.type_key AS item_type_key,
      i.scope_kind AS item_scope,i.universe_id AS item_universe_id,i.content_type_id AS item_content_type_id,
      CASE WHEN s.source_table='archive_entries' THEN (SELECT t.id FROM content_types t WHERE t.owner_id=s.owner_id AND t.slug=s.type_key) END AS expected_content_type_id,
      i.data AS item_data,s.source_data
    FROM source_rows s JOIN content_items i
      ON i.source_kind=CASE s.source_table WHEN 'characters' THEN 'character' ELSE 'archive_entry' END
      AND i.source_id=s.source_id
    WHERE (i.owner_id,i.type_key,i.scope_kind,i.universe_id) IS DISTINCT FROM
      (s.owner_id,s.type_key,s.scope_kind,s.universe_id)
      OR i.data IS DISTINCT FROM s.source_data
      OR i.content_type_id IS DISTINCT FROM CASE WHEN s.source_table='archive_entries' THEN
        (SELECT t.id FROM content_types t WHERE t.owner_id=s.owner_id AND t.slug=s.type_key) END
    ORDER BY s.source_table,s.source_id LIMIT 100`);
  return result.rows;
}

async function inspectDanglingRegistry(client) {
  const result = await client.query(`SELECT i.id,i.owner_id,i.source_kind,i.source_id
    FROM content_items i
    LEFT JOIN characters c ON i.source_kind='character' AND c.id=i.source_id
    LEFT JOIN archive_entries e ON i.source_kind='archive_entry' AND e.id=i.source_id
    WHERE i.source_kind IS NOT NULL AND (
      (i.source_kind='character' AND (c.id IS NULL OR c.owner_id IS DISTINCT FROM i.owner_id)) OR
      (i.source_kind='archive_entry' AND (e.id IS NULL OR e.owner_id IS DISTINCT FROM i.owner_id))
    ) ORDER BY i.id LIMIT 100`);
  return result.rows;
}

async function inspectExistingNodeMap(client) {
  const result = await client.query(`SELECT m.owner_id,m.source_node_id,m.universe_id,m.group_id,
      n.id AS current_node_id,n.universe_id AS current_universe_id,n.owner_id AS current_owner_id,
      m.source_data,to_jsonb(n) AS current_source_data,
      g.owner_id AS group_owner_id,g.universe_id AS group_universe_id,g.space_type AS group_space_type
    FROM phase2_universe_node_group_map m
    LEFT JOIN universe_nodes n ON n.id=m.source_node_id
    LEFT JOIN content_groups g ON g.id=m.group_id
    WHERE n.id IS NULL OR n.owner_id IS DISTINCT FROM m.owner_id OR n.universe_id IS DISTINCT FROM m.universe_id
      OR m.source_data IS DISTINCT FROM to_jsonb(n)
      OR (m.group_id IS NOT NULL AND (g.id IS NULL OR g.owner_id IS DISTINCT FROM m.owner_id
        OR g.universe_id IS DISTINCT FROM m.universe_id OR g.space_type IS DISTINCT FROM 'universe'))
    ORDER BY m.owner_id,m.source_node_id LIMIT 100`);
  return result.rows;
}

/**
 * Read-only migration report. It never starts a transaction that writes or
 * creates a table; callers must install the additive schema separately.
 */
export async function preflightPhase2Backfill(client, {
  writeCutoverVerified = false,
  frontendContentCompatibilityVerified = false,
} = {}) {
  const requiredTables = [
    'users', 'universes', 'characters', 'archive_entries', 'universe_nodes', 'content_types',
    'universe_themes', 'character_relationships', 'entry_links', 'content_items',
    'content_groups', 'content_group_items', 'content_type_configs', 'phase2_universe_node_group_map', 'phase2_legacy_node_memberships',
  ];
  const present = await client.query(`SELECT name,to_regclass('public.' || name) IS NOT NULL AS present
    FROM unnest($1::text[]) AS name`, [requiredTables]);
  const missingTables = present.rows.filter(row => !row.present).map(row => row.name);
  if (missingTables.length) {
    return {
      safeToBackfill: false,
      readyForRealCutover: false,
      missingTables,
      conflicts: [{ code: 'phase2_schema_incomplete', count: missingTables.length, sample: missingTables }],
      warnings: [],
      manualDecisions: [],
      counts: {},
    };
  }

  const legacy = await inspectLegacyData(client);
  const counts = {};
  for (const [label, table] of Object.entries({
    universes: 'universes', characters: 'characters', archive_entries: 'archive_entries',
    universe_nodes: 'universe_nodes', content_types: 'content_types', universe_themes: 'universe_themes',
    character_relationships: 'character_relationships', entry_links: 'entry_links',
    content_items: 'content_items', content_groups: 'content_groups', content_group_items: 'content_group_items',
    content_type_configs: 'content_type_configs', node_group_maps: 'phase2_universe_node_group_map',
    legacy_node_memberships: 'phase2_legacy_node_memberships',
  })) counts[label] = await countRows(client, table);

  const scopeCounts = await client.query(`SELECT source_table,scope_kind,count(*)::int AS count FROM (
      SELECT 'characters'::text AS source_table,scope_kind FROM characters
      UNION ALL SELECT 'archive_entries',scope_kind FROM archive_entries
    ) sources GROUP BY source_table,scope_kind ORDER BY source_table,scope_kind`);
  const ownerCounts = await client.query(`SELECT source_table,owner_id,count(*)::int AS count FROM (
      SELECT 'characters'::text AS source_table,owner_id FROM characters
      UNION ALL SELECT 'archive_entries',owner_id FROM archive_entries
    ) sources GROUP BY source_table,owner_id ORDER BY source_table,owner_id`);
  const registryConflicts = await inspectExistingRegistry(client);
  const danglingRegistry = await inspectDanglingRegistry(client);
  const nodeMapConflicts = await inspectExistingNodeMap(client);
  const alreadyMigrated = await client.query(`SELECT source_kind,count(*)::int AS count FROM content_items
    WHERE source_kind IS NOT NULL GROUP BY source_kind ORDER BY source_kind`);
  const mappedNodes = await client.query(`SELECT count(*) FILTER (WHERE group_id IS NOT NULL)::int AS active,
      count(*) FILTER (WHERE group_id IS NULL)::int AS intentionally_removed
    FROM phase2_universe_node_group_map`);
  const overlaps = legacy.informational.find(row => row.code === 'overlapping_legacy_numeric_ids');
  const missingCustomTypes = legacy.conflicts.filter(row => row.code === 'orphan_custom_entry_types');
  const conflicts = [
    ...legacy.conflicts,
    ...(registryConflicts.length ? [{ code: 'existing_content_item_mismatch', count: registryConflicts.length, sample: registryConflicts }] : []),
    ...(danglingRegistry.length ? [{ code: 'orphaned_content_item_source', count: danglingRegistry.length, sample: danglingRegistry }] : []),
    ...(nodeMapConflicts.length ? [{ code: 'existing_node_group_map_mismatch', count: nodeMapConflicts.length, sample: nodeMapConflicts }] : []),
  ];
  const warnings = [
    ...legacy.informational,
    ...(overlaps ? [{ code: 'overlapping_ids_are_table_scoped', severity: 'warning', detail: 'characters.id and archive_entries.id can coincide; source_kind keeps them distinct.' }] : []),
    ...(counts.characters || counts.archive_entries ? [{
      code: 'legacy_api_write_cutover_required', severity: 'cutover_gate',
      detail: 'The additive schema installs transactional compatibility triggers for v1 source writes. Verify that the schema containing those triggers is installed before allowing post-backfill v1 writes; normal Express startup does not install it.',
    }] : []),
    ...(counts.universe_nodes ? [{
      code: 'node_item_order_not_stored', severity: 'warning',
      detail: 'Node sort_order is preserved for groups. Legacy item-to-node assignments have no membership ordering column, so new memberships use sort_order 0 and deterministic item-id tie ordering.',
    }] : []),
    ...(counts.archive_entries && counts.content_types ? [{
      code: 'custom_type_association_uses_slug', severity: 'warning',
      detail: 'Legacy dynamic entries keep their original kind slug in content_items.type_key and link content_type_id only by an exact owner+slug match. Type records and sidecar field configurations remain unchanged.',
    }] : []),
    ...(counts.characters || counts.archive_entries ? [{
      code: 'migrated_record_editor_compatibility_pending', severity: 'cutover_gate',
      detail: 'The frontend rehydrates migrated character and archive-entry snapshots into the v1 forms. Keep the fixture round-trip tests passing and perform the approved browser acceptance check before a real cutover.',
    }] : []),
  ];
  const automaticItems = Math.max(0, counts.characters + counts.archive_entries
    - alreadyMigrated.rows.reduce((sum, row) => sum + Number(row.count), 0));
  const manualDecisions = conflicts.map(conflict => ({ code: conflict.code, count: conflict.total ?? conflict.count, sample: conflict.sample }));
  const safeToBackfill = conflicts.length === 0;
  return {
    safeToBackfill,
    readyForRealCutover: safeToBackfill && writeCutoverVerified && frontendContentCompatibilityVerified,
    counts: {
      ...counts,
      scopeBreakdown: scopeCounts.rows,
      ownerBreakdown: ownerCounts.rows,
      alreadyMigrated: alreadyMigrated.rows,
      newItemsExpected: automaticItems,
      nodesWithActiveGroups: Number(mappedNodes.rows[0].active),
      nodesIntentionallyRemoved: Number(mappedNodes.rows[0].intentionally_removed),
    },
    conflicts,
    warnings,
    manualDecisions,
    informational: legacy.informational,
  };
}

async function capturePreservedCounts(client) {
  const tables = ['universes','characters','archive_entries','universe_nodes','content_types','universe_themes','character_relationships','entry_links'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await countRows(client, table)])));
}

async function insertLegacyItems(client) {
  const characters = await client.query(`INSERT INTO content_items
      (owner_id,type_key,source_kind,source_id,scope_kind,universe_id,name,description,tags,data,created_at,updated_at)
    SELECT c.owner_id,'character','character',c.id,c.scope_kind,c.universe_id,c.name,c.description,
      CASE WHEN NULLIF(btrim(c.tags),'') IS NULL THEN '{}'::text[] ELSE regexp_split_to_array(c.tags,'\\s*,\\s*') END,
      to_jsonb(c),c.created_at,c.updated_at
    FROM characters c
    WHERE NOT EXISTS (SELECT 1 FROM content_items i WHERE i.owner_id=c.owner_id AND i.source_kind='character' AND i.source_id=c.id)
    ON CONFLICT(owner_id,source_kind,source_id) DO NOTHING`);
  const entries = await client.query(`INSERT INTO content_items
      (owner_id,type_key,content_type_id,source_kind,source_id,scope_kind,universe_id,name,description,tags,data,created_at,updated_at)
    SELECT e.owner_id,e.kind,t.id,'archive_entry',e.id,e.scope_kind,e.universe_id,e.name,e.description,e.tags,to_jsonb(e),e.created_at,e.updated_at
    FROM archive_entries e
    LEFT JOIN content_types t ON t.owner_id=e.owner_id AND t.slug=e.kind
    WHERE NOT EXISTS (SELECT 1 FROM content_items i WHERE i.owner_id=e.owner_id AND i.source_kind='archive_entry' AND i.source_id=e.id)
    ON CONFLICT(owner_id,source_kind,source_id) DO NOTHING`);
  return { characters: characters.rowCount, archive_entries: entries.rowCount };
}

async function insertNodeGroups(client) {
  const nodes = await client.query(`WITH RECURSIVE ordered_nodes AS (
      SELECT n.*,0 AS depth FROM universe_nodes n WHERE n.parent_id IS NULL
      UNION ALL
      SELECT child.*,parent.depth+1 FROM universe_nodes child JOIN ordered_nodes parent
        ON child.owner_id=parent.owner_id AND child.universe_id=parent.universe_id AND child.parent_id=parent.id
    ) SELECT * FROM ordered_nodes ORDER BY depth,owner_id,universe_id,sort_order,id`);
  let created = 0;
  let alreadyMapped = 0;
  let intentionallyRemoved = 0;
  for (const node of nodes.rows) {
    const existing = await client.query('SELECT group_id FROM phase2_universe_node_group_map WHERE owner_id=$1 AND source_node_id=$2', [node.owner_id, node.id]);
    if (existing.rowCount) {
      alreadyMapped++;
      if (existing.rows[0].group_id === null) intentionallyRemoved++;
      continue;
    }
    let parentGroupId = null;
    if (node.parent_id !== null) {
      const parent = await client.query('SELECT group_id FROM phase2_universe_node_group_map WHERE owner_id=$1 AND source_node_id=$2', [node.owner_id, node.parent_id]);
      if (!parent.rowCount || parent.rows[0].group_id === null) {
        const error = new Error(`Universe node ${node.id} has no active mapped parent group.`);
        error.code = 'BACKFILL_NODE_PARENT_UNMAPPED';
        throw error;
      }
      parentGroupId = parent.rows[0].group_id;
    }
    const group = await client.query(`INSERT INTO content_groups(owner_id,space_type,universe_id,parent_group_id,name,description,sort_order)
      VALUES($1,'universe',$2,$3,$4,$5,$6) RETURNING id`, [node.owner_id,node.universe_id,parentGroupId,node.name,node.description,node.sort_order]);
    const sourceSnapshot = await client.query('SELECT to_jsonb(n) AS data FROM universe_nodes n WHERE n.owner_id=$1 AND n.id=$2', [node.owner_id,node.id]);
    await client.query(`INSERT INTO phase2_universe_node_group_map(owner_id,source_node_id,universe_id,group_id,source_data)
      VALUES($1,$2,$3,$4,$5)`, [node.owner_id,node.id,node.universe_id,group.rows[0].id,JSON.stringify(sourceSnapshot.rows[0].data)]);
    created++;
  }
  return { created, alreadyMapped, intentionallyRemoved };
}

async function insertNodeMemberships(client) {
  const characters = await client.query(`WITH inserted AS (
      INSERT INTO content_group_items(owner_id,group_id,item_id,sort_order)
      SELECT c.owner_id,m.group_id,i.id,0 FROM characters c
      JOIN phase2_universe_node_group_map m ON m.owner_id=c.owner_id AND m.source_node_id=c.universe_node_id AND m.group_id IS NOT NULL
      JOIN content_items i ON i.owner_id=c.owner_id AND i.source_kind='character' AND i.source_id=c.id
      WHERE c.universe_node_id IS NOT NULL ON CONFLICT(owner_id,group_id,item_id) DO NOTHING
      RETURNING owner_id,group_id,item_id
    ) INSERT INTO phase2_legacy_node_memberships(owner_id,source_kind,source_id,source_node_id,group_id,item_id)
      SELECT c.owner_id,'character',c.id,c.universe_node_id,inserted.group_id,inserted.item_id FROM inserted
      JOIN characters c ON c.owner_id=inserted.owner_id AND c.universe_node_id IS NOT NULL
      JOIN content_items i ON i.owner_id=c.owner_id AND i.id=inserted.item_id AND i.source_kind='character' AND i.source_id=c.id
      ON CONFLICT(owner_id,source_kind,source_id) DO NOTHING`);
  const entries = await client.query(`WITH inserted AS (
      INSERT INTO content_group_items(owner_id,group_id,item_id,sort_order)
      SELECT e.owner_id,m.group_id,i.id,0 FROM archive_entries e
      JOIN phase2_universe_node_group_map m ON m.owner_id=e.owner_id AND m.source_node_id=e.universe_node_id AND m.group_id IS NOT NULL
      JOIN content_items i ON i.owner_id=e.owner_id AND i.source_kind='archive_entry' AND i.source_id=e.id
      WHERE e.universe_node_id IS NOT NULL ON CONFLICT(owner_id,group_id,item_id) DO NOTHING
      RETURNING owner_id,group_id,item_id
    ) INSERT INTO phase2_legacy_node_memberships(owner_id,source_kind,source_id,source_node_id,group_id,item_id)
      SELECT e.owner_id,'archive_entry',e.id,e.universe_node_id,inserted.group_id,inserted.item_id FROM inserted
      JOIN archive_entries e ON e.owner_id=inserted.owner_id AND e.universe_node_id IS NOT NULL
      JOIN content_items i ON i.owner_id=e.owner_id AND i.id=inserted.item_id AND i.source_kind='archive_entry' AND i.source_id=e.id
      ON CONFLICT(owner_id,source_kind,source_id) DO NOTHING`);
  return { characters: characters.rowCount, archive_entries: entries.rowCount };
}

async function verifyBackfill(client, beforePreserved) {
  const registry = await client.query(`WITH source_rows AS (${sourceSnapshotQuery})
    SELECT count(*)::int AS source_count,count(i.id)::int AS item_count,
      count(*) FILTER (WHERE i.id IS NULL)::int AS missing_count,
      count(*) FILTER (WHERE i.id IS NOT NULL AND ((i.owner_id,i.type_key,i.scope_kind,i.universe_id,i.data)
        IS DISTINCT FROM (s.owner_id,s.type_key,s.scope_kind,s.universe_id,s.source_data)
        OR i.content_type_id IS DISTINCT FROM CASE WHEN s.source_table='archive_entries' THEN
          (SELECT t.id FROM content_types t WHERE t.owner_id=s.owner_id AND t.slug=s.type_key) END))::int AS mismatch_count
    FROM source_rows s LEFT JOIN content_items i ON i.source_kind=CASE s.source_table WHEN 'characters' THEN 'character' ELSE 'archive_entry' END
      AND i.source_id=s.source_id`);
  const missingMemberships = await client.query(`SELECT count(*)::int AS count FROM (
    SELECT c.owner_id,c.id AS source_id,'character'::text AS source_kind,m.group_id FROM characters c
      JOIN phase2_universe_node_group_map m ON m.owner_id=c.owner_id AND m.source_node_id=c.universe_node_id AND m.group_id IS NOT NULL
    UNION ALL
    SELECT e.owner_id,e.id,'archive_entry',m.group_id FROM archive_entries e
      JOIN phase2_universe_node_group_map m ON m.owner_id=e.owner_id AND m.source_node_id=e.universe_node_id AND m.group_id IS NOT NULL
  ) expected JOIN content_items i ON i.owner_id=expected.owner_id AND i.source_kind=expected.source_kind
      AND i.source_id=expected.source_id
    WHERE NOT EXISTS (SELECT 1 FROM content_group_items m WHERE m.owner_id=i.owner_id AND m.group_id=expected.group_id AND m.item_id=i.id)`);
  const preservedAfter = await capturePreservedCounts(client);
  const changedPreservedTables = Object.keys(beforePreserved).filter(table => beforePreserved[table] !== preservedAfter[table]);
  const row = registry.rows[0];
  if (Number(row.source_count) !== Number(row.item_count) || Number(row.missing_count) || Number(row.mismatch_count)
    || Number(missingMemberships.rows[0].count) || changedPreservedTables.length) {
    const error = new Error('Post-backfill verification failed; all writes will be rolled back.');
    error.code = 'BACKFILL_VERIFICATION_FAILED';
    error.verification = {
      sourceCount: Number(row.source_count), itemCount: Number(row.item_count),
      missingItems: Number(row.missing_count), itemMismatches: Number(row.mismatch_count),
      missingMemberships: Number(missingMemberships.rows[0].count), changedPreservedTables,
    };
    throw error;
  }
  return {
    sourceItems: Number(row.source_count), registeredItems: Number(row.item_count),
    missingItems: 0, itemMismatches: 0, missingMemberships: 0,
    preservedTableCounts: preservedAfter,
    unchangedTables: Object.keys(beforePreserved),
  };
}

/**
 * Transactional backfill engine. It is not called by Express or any startup
 * path. A future real run must first explicitly verify legacy-write cutover.
 */
export async function backfillPhase2Content(client, {
  writeCutoverVerified = false,
  frontendContentCompatibilityVerified = false,
} = {}) {
  if (writeCutoverVerified !== true || frontendContentCompatibilityVerified !== true) {
    const error = new Error('Backfill blocked: verify the legacy write cutover and migrated-record editor compatibility before execution.');
    error.code = 'BACKFILL_CUTOVER_NOT_VERIFIED';
    throw error;
  }
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(`LOCK TABLE users,universes,characters,archive_entries,universe_nodes,content_types,
      universe_themes,character_relationships,entry_links,content_type_configs,content_items,content_groups,
      content_group_items,phase2_universe_node_group_map,phase2_legacy_node_memberships IN SHARE ROW EXCLUSIVE MODE`);
    const preflight = await preflightPhase2Backfill(client, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true });
    if (!preflight.safeToBackfill) {
      const error = new Error('Backfill blocked by preinspection conflicts. No legacy rows were changed.');
      error.code = 'BACKFILL_PREFLIGHT_FAILED';
      error.report = preflight;
      throw error;
    }
    const beforePreserved = await capturePreservedCounts(client);
    const insertedItems = await insertLegacyItems(client);
    const insertedGroups = await insertNodeGroups(client);
    const insertedMemberships = await insertNodeMemberships(client);
    const verification = await verifyBackfill(client, beforePreserved);
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      status: 'committed',
      insertedItems,
      insertedGroups,
      insertedMemberships,
      verification,
      preflight,
    };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    error.rolledBack = transactionOpen;
    throw error;
  }
}

