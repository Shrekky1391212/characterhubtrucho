export function normalizeContentScope(data) {
  const scopeKind = data.scope_kind || (data.universe_id ? 'universe' : 'pending');
  if (!['universe', 'pending', 'global'].includes(scopeKind)) return null;
  if (scopeKind === 'universe' && !data.universe_id) return null;
  if (scopeKind !== 'universe' && (data.universe_id || data.universe_node_id)) return null;
  return {
    scope_kind: scopeKind,
    universe_id: scopeKind === 'universe' ? Number(data.universe_id) : null,
    universe_node_id: scopeKind === 'universe' && data.universe_node_id ? Number(data.universe_node_id) : null,
  };
}

export function sameContentScope(left, right) {
  return Boolean(left && right && left.scope_kind === right.scope_kind &&
    String(left.universe_id || '') === String(right.universe_id || ''));
}

export function canReparentNode(rows, nodeId, parentId, universeId) {
  if (parentId == null) return true;
  const node = rows.find(row => Number(row.id) === Number(nodeId));
  const parent = rows.find(row => Number(row.id) === Number(parentId));
  if (!node || !parent || Number(node.universe_id) !== Number(universeId) ||
      Number(parent.universe_id) !== Number(universeId) || Number(nodeId) === Number(parentId)) return false;
  const byParent = new Map();
  for (const row of rows) {
    const key = row.parent_id == null ? null : Number(row.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(Number(row.id));
  }
  const descendants = new Set();
  const queue = [...(byParent.get(Number(nodeId)) || [])];
  while (queue.length) {
    const current = queue.pop();
    if (descendants.has(current)) continue;
    descendants.add(current);
    queue.push(...(byParent.get(current) || []));
  }
  return !descendants.has(Number(parentId));
}

export function buildUniverseTree(rows) {
  const nodes = new Map(rows.map(row => [Number(row.id), { ...row, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id == null ? null : nodes.get(Number(node.parent_id));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = items => {
    items.sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || a.name.localeCompare(b.name));
    items.forEach(node => sort(node.children));
  };
  sort(roots);
  return roots;
}
