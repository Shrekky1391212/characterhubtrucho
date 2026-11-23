/**
 * Cross-layer identity contract:
 * - API/library identity is (source_table, source_id), using exact legacy SQL table names.
 * - content_items storage uses (owner_id, source_kind, source_id), where source_kind is
 *   the stable compact enum. These are not interchangeable; convert only through this map.
 * - content_item.id is a separate generated registry identity.
 */
export const sourceTableToKind = Object.freeze({
  characters: 'character',
  archive_entries: 'archive_entry',
});
export const sourceKindToTable = Object.freeze(Object.fromEntries(
  Object.entries(sourceTableToKind).map(([table, kind]) => [kind, table]),
));

export function sourceKindForTable(table) {
  return sourceTableToKind[table] || null;
}

export function sourceTableForKind(kind) {
  return sourceKindToTable[kind] || null;
}

export function sourceIdentityKey(table, id) {
  if (!sourceKindForTable(table) || id === undefined || id === null) return null;
  return `${table}:${id}`;
}
