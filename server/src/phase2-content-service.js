import { sourceKindForTable } from './source-identity.js';

/** Resolve an item by its owner-scoped registry id. Legacy ids are deliberately
 * resolved only through the explicit source table route, never by bare id. */
export async function getContentItem(client, ownerId, itemId) {
  const result = await client.query(
    `SELECT i.*, CASE i.source_kind WHEN 'character' THEN 'characters' WHEN 'archive_entry' THEN 'archive_entries' END AS source_table,
      i.type_key AS source_type,i.data AS source_snapshot
     FROM content_items i WHERE i.owner_id=$1 AND i.id=$2`,
    [ownerId, itemId],
  );
  return result.rows[0] || null;
}

export async function getContentItemBySource(client, ownerId, sourceTable, sourceId) {
  const sourceKind = sourceKindForTable(sourceTable);
  if (!sourceKind) return null;
  const unified = await client.query(
    `SELECT i.*, $3::text AS source_table, i.type_key AS source_type,i.data AS source_snapshot
     FROM content_items i WHERE i.owner_id=$1 AND i.source_kind=$2 AND i.source_id=$4`,
    [ownerId, sourceKind, sourceTable, sourceId],
  );
  if (unified.rowCount) return { ...unified.rows[0], migrated: true };

  const tableQuery = sourceKind === 'character'
    ? `SELECT c.id AS source_id,c.owner_id,'character'::text AS type_key,c.scope_kind,c.universe_id,
        c.name,c.description,c.tags,to_jsonb(c) AS original_data
       FROM characters c WHERE c.owner_id=$1 AND c.id=$2`
    : `SELECT e.id AS source_id,e.owner_id,e.kind AS type_key,e.scope_kind,e.universe_id,
        e.name,e.description,e.tags,to_jsonb(e) AS original_data
       FROM archive_entries e WHERE e.owner_id=$1 AND e.id=$2`;
  const legacy = await client.query(tableQuery, [ownerId, sourceId]);
  return legacy.rows[0]
    ? { ...legacy.rows[0], source_table: sourceTable, source_type: legacy.rows[0].type_key, source_snapshot: legacy.rows[0].original_data, migrated: false }
    : null;
}

/** Return unified rows plus not-yet-backfilled legacy rows exactly once. */
export async function listContentItems(client, ownerId, filters = {}) {
  const result = await client.query(
    `SELECT i.id,i.owner_id,i.type_key,i.content_type_id,i.scope_kind,i.universe_id,i.name,i.description,i.tags,i.data,
       CASE i.source_kind WHEN 'character' THEN 'characters' WHEN 'archive_entry' THEN 'archive_entries' END AS source_table,
       i.type_key AS source_type,i.source_id,TRUE AS migrated
     FROM content_items i WHERE i.owner_id=$1
     UNION ALL
     SELECT NULL,c.owner_id,'character',NULL::integer,c.scope_kind,c.universe_id,c.name,c.description,
       string_to_array(NULLIF(c.tags,''),','),to_jsonb(c),'characters','character',c.id,FALSE
     FROM characters c WHERE c.owner_id=$1 AND NOT EXISTS
       (SELECT 1 FROM content_items i WHERE i.owner_id=c.owner_id AND i.source_kind='character' AND i.source_id=c.id)
     UNION ALL
     SELECT NULL,e.owner_id,e.kind,NULL::integer,e.scope_kind,e.universe_id,e.name,e.description,e.tags,to_jsonb(e),
       'archive_entries',e.kind,e.id,FALSE
     FROM archive_entries e WHERE e.owner_id=$1 AND NOT EXISTS
       (SELECT 1 FROM content_items i WHERE i.owner_id=e.owner_id AND i.source_kind='archive_entry' AND i.source_id=e.id)`,
    [ownerId],
  );
  return result.rows.filter(row =>
    (!filters.type || row.type_key === filters.type) &&
    (!filters.scope || row.scope_kind === filters.scope) &&
    (filters.universeId === undefined || filters.universeId === null || Number(row.universe_id) === Number(filters.universeId)));
}
