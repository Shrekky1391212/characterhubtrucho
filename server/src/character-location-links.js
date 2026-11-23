const idFields = ['birthplace_id', 'current_residence_id'];
const listFields = ['former_residence_ids', 'visited_place_ids'];

export function validateLocationLinkShape(links) {
  if (!links || typeof links !== 'object' || Array.isArray(links)) return 'details.location_links debe ser un objeto.';
  for (const key of idFields) if (links[key] != null && (!Number.isInteger(Number(links[key])) || Number(links[key]) < 1)) return `details.location_links.${key} debe ser un ID positivo o null.`;
  for (const key of listFields) if (links[key] != null && (!Array.isArray(links[key]) || links[key].length > 100 || links[key].some(id => !Number.isInteger(Number(id)) || Number(id) < 1))) return `details.location_links.${key} debe contener hasta 100 IDs positivos.`;
  for (const key of ['family_cultural_origin', 'nationality']) if (links[key] != null && (typeof links[key] !== 'string' || links[key].length > 200)) return `details.location_links.${key} debe ser texto de hasta 200 caracteres.`;
  return null;
}

export async function validateLocationLinkReferences(pool, ownerId, scope, links) {
  if (links == null) return null;
  const shapeError = validateLocationLinkShape(links);
  if (shapeError) return shapeError;
  const ids = [...new Set([...idFields.map(key => links[key]).filter(value => value != null), ...listFields.flatMap(key => links[key] || [])].map(Number))];
  if (!ids.length) return null;
  const result = await pool.query('SELECT id, kind, scope_kind, universe_id FROM archive_entries WHERE owner_id=$1 AND id=ANY($2::bigint[])', [ownerId, ids]);
  if (result.rows.length !== ids.length) return 'Una o más fichas de lugar no existen o no pertenecen a tu archivo.';
  for (const place of result.rows) {
    if (place.kind !== 'location') return `La ficha ${place.id} no es un lugar.`;
    const compatible = scope.scope_kind === 'universe'
      ? place.scope_kind === 'global' || (place.scope_kind === 'universe' && Number(place.universe_id) === Number(scope.universe_id))
      : scope.scope_kind === 'global' ? place.scope_kind === 'global' : place.scope_kind === 'global' || place.scope_kind === 'pending';
    if (!compatible) return `La ficha de lugar ${place.id} pertenece a un ámbito incompatible.`;
  }
  return null;
}
