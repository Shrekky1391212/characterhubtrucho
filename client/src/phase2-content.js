const sourceEntity = { characters: 'character', archive_entries: 'entry' };

function flattenData(data, legacy = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return legacy && data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
}

export function normalizeContentItem(row) {
  const legacyLibraryRow = row.entity_type !== undefined;
  const sourceTable = row.source_table || (legacyLibraryRow
    ? (row.entity_type === 'character' ? 'characters' : row.entity_type === 'entry' ? 'archive_entries' : null)
    : null);
  const sourceId = row.source_id ?? row.entity_id ?? null;
  const typeKey = row.type_key || row.kind || (sourceTable ? sourceEntity[sourceTable] : row.entity_type || 'unknown');
  const entityType = sourceEntity[sourceTable] || row.entity_type || typeKey;
  const tags = Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  const sourceSnapshot = row.source_snapshot || (sourceTable ? row.data : null);
  const sourcePayload = sourceTable === 'archive_entries'
    ? (sourceSnapshot?.data && typeof sourceSnapshot.data === 'object' ? sourceSnapshot.data : row.data)
    : sourceTable === 'characters'
      ? (sourceSnapshot?.details && typeof sourceSnapshot.details === 'object' ? sourceSnapshot.details : row.details || {})
      : flattenData(row.data, row.migrated === false);
  return {
    ...row,
    id: sourceId ?? row.id ?? null,
    content_item_id: legacyLibraryRow ? null : row.id ?? null,
    entity_id: sourceId ?? row.id ?? null,
    entity_type: entityType,
    source_table: sourceTable,
    source_type: row.source_type || typeKey,
    source_id: sourceId,
    type_key: typeKey,
    kind: row.kind || typeKey,
    source_snapshot: sourceSnapshot,
    data: sourcePayload,
    tags,
    migrated: row.migrated ?? !legacyLibraryRow,
  };
}

/** Rehydrate a unified source-backed row into the exact shape expected by the
 * existing v1 character and archive-entry forms. Keep the untouched snapshot
 * fields so edits can round-trip values the form does not render. */
export function hydrateLegacyEditorRecord(row) {
  const item = normalizeContentItem(row);
  const snapshot = item.source_snapshot && typeof item.source_snapshot === 'object' ? item.source_snapshot : {};
  const common = {
    ...item,
    ...snapshot,
    id: item.source_id ?? snapshot.id ?? item.id,
    content_item_id: item.content_item_id,
    source_table: item.source_table,
    source_type: item.source_type,
    source_id: item.source_id,
    type_key: item.type_key,
    owner_id: item.owner_id ?? snapshot.owner_id,
    scope_kind: item.scope_kind ?? snapshot.scope_kind,
    universe_id: item.universe_id ?? snapshot.universe_id ?? null,
    universe_node_id: snapshot.universe_node_id ?? null,
    name: item.name ?? snapshot.name ?? '',
    description: item.description ?? snapshot.description ?? '',
    tags: snapshot.tags ?? item.tags,
  };
  if (item.source_table === 'characters') {
    return { ...common, details: { ...(snapshot.details || {}) } };
  }
  if (item.source_table === 'archive_entries') {
    return {
      ...common,
      kind: snapshot.kind || item.type_key || item.kind,
      parent_id: snapshot.parent_id ?? null,
      data: { ...(snapshot.data || item.data || {}) },
    };
  }
  return { ...common, data: { ...(snapshot.data || item.data || {}) } };
}

export function uniqueContentItems(rows) {
  const unique = new Map();
  for (const source of rows) {
    const row = normalizeContentItem(source);
    const key = row.source_table && row.source_id != null
      ? `source:${row.source_table}:${row.source_id}`
      : row.content_item_id != null
        ? `content:${row.content_item_id}`
        : `legacy:${row.entity_type}:${row.entity_id}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

/** Match current v2 items by type ID and legacy items by their unchanged slug. */
export function attachContentType(item, types) {
  const type = item.content_type_id
    ? types.find(candidate => Number(candidate.id) === Number(item.content_type_id))
    : types.find(candidate => candidate.slug === item.type_key);
  return type ? { ...item, type_key: type.slug, kind: type.slug, type_label: type.label, content_type: type } : item;
}

export function filterContentItems(rows, filters = {}) {
  const membershipByItem = filters.membershipByItem || new Map();
  const needle = String(filters.query || '').trim().toLocaleLowerCase();
  const tagNeedle = String(filters.tag || '').trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (filters.excludePending && row.scope_kind === 'pending') return false;
    if (filters.type && filters.type !== 'all' && row.type_key !== filters.type) return false;
    if (filters.scope && filters.scope !== 'all' && row.scope_kind !== filters.scope) return false;
    if (filters.universeId && Number(row.universe_id) !== Number(filters.universeId)) return false;
    const memberships = membershipByItem.get(String(row.content_item_id)) || new Set();
    if (filters.grouped === 'grouped' && memberships.size === 0) return false;
    if (filters.grouped === 'ungrouped' && memberships.size > 0) return false;
    if (filters.groupId && !memberships.has(String(filters.groupId))) return false;
    if (needle && !`${row.name || ''} ${row.description || ''} ${row.type_key || ''} ${row.tags.join(' ')}`.toLocaleLowerCase().includes(needle)) return false;
    if (tagNeedle && !row.tags.some(tag => String(tag).toLocaleLowerCase().includes(tagNeedle))) return false;
    for (const [field, value] of Object.entries(filters.fields || {})) {
      if (value === '' || value === undefined || value === null) continue;
      const actual = row.data?.[field];
      if (typeof value === 'boolean' ? Boolean(actual) !== value : !String(actual ?? '').toLocaleLowerCase().includes(String(value).toLocaleLowerCase())) return false;
    }
    return true;
  });
}

/** Apply the scope rules for the separate library views before other filters. */
export function selectLibraryView(rows, { view = 'library', universeId, ...filters } = {}) {
  if (view === 'pending') {
    return filterContentItems(rows, { ...filters, scope: 'pending', universeId: undefined });
  }
  if (view === 'global') {
    return filterContentItems(rows, { ...filters, scope: 'global', universeId: undefined });
  }
  if (view === 'universe') {
    return filterContentItems(rows, { ...filters, scope: 'universe', universeId, excludePending: true });
  }
  return filterContentItems(rows, { ...filters, excludePending: true });
}

/** Return one row per item while retaining which group owns the visible membership. */
export function groupMembershipRows(items, groups, groupItems, rootId, includeChildren = false) {
  const groupIds = includeChildren ? descendantGroupIds(groups, rootId) : new Set([String(rootId)]);
  const byId = new Map(items.filter(item => item.content_item_id != null).map(item => [String(item.content_item_id), item]));
  const result = new Map();
  for (const groupId of groupIds) {
    for (const itemId of groupItems[String(groupId)] || []) {
      if (!result.has(String(itemId)) && byId.has(String(itemId))) {
        result.set(String(itemId), { item: byId.get(String(itemId)), groupId: String(groupId) });
      }
    }
  }
  return [...result.values()];
}

/** Adding to a group should only be blocked by an existing membership in that group. */
export function availableGroupItems(items, groupItems, groupId) {
  const current = new Set((groupItems[String(groupId)] || []).map(String));
  return items.filter(item => item.content_item_id != null && !current.has(String(item.content_item_id)));
}

export function dynamicFieldModel(field, data = {}) {
  const value = data[field.key] ?? (field.type === 'checkbox' ? false : '');
  return {
    inputType: ['number', 'date', 'url'].includes(field.type) ? field.type : 'text',
    value,
    required: Boolean(field.required),
    options: field.type === 'select' && Array.isArray(field.options) ? field.options : [],
  };
}

export function dynamicFieldValue(field, rawValue) {
  if (field.type === 'checkbox') return Boolean(rawValue);
  if (field.type === 'number') return rawValue === '' ? '' : Number(rawValue);
  return rawValue;
}

export function libraryEmptyState(rows, view = 'library') {
  if (rows.length) return null;
  return view === 'pending'
    ? { title: 'No hay elementos pendientes', text: 'Los registros sin clasificar se muestran por separado del contenido global.' }
    : { title: 'La biblioteca esta vacia', text: 'Esta vista reune los contenidos de todos tus universos.' };
}

export function phase2UnavailableMessage(error) {
  return error?.code === 'PHASE2_SCHEMA_NOT_INSTALLED'
    ? 'La organización nueva todavía no está habilitada en el servidor. Tus pantallas anteriores siguen disponibles; no se instaló ningún esquema.'
    : `No se pudo cargar la organización nueva: ${error?.message || 'Error desconocido'}`;
}

export function descendantGroupIds(groups, rootId) {
  const result = new Set([String(rootId)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.parent_group_id != null && result.has(String(group.parent_group_id)) && !result.has(String(group.id))) {
        result.add(String(group.id));
        changed = true;
      }
    }
  }
  return result;
}
