export const emptyLocationLinks = () => ({ birthplace_id: null, family_cultural_origin: '', nationality: '', current_residence_id: null, former_residence_ids: [], visited_place_ids: [] });
export function normalizeLocationLinks(value) {
  const source = value && typeof value === 'object' ? value : {};
  const id = raw => raw == null || raw === '' ? null : Number(raw);
  const ids = raw => [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(number => Number.isInteger(number) && number > 0))];
  return { ...emptyLocationLinks(), ...source, birthplace_id: id(source.birthplace_id), current_residence_id: id(source.current_residence_id), former_residence_ids: ids(source.former_residence_ids), visited_place_ids: ids(source.visited_place_ids), family_cultural_origin: String(source.family_cultural_origin || ''), nationality: String(source.nationality || '') };
}
export function compatibleLocationOptions(entries, character) {
  return (entries || []).filter(entry => entry.kind === 'location' && (character?.scope_kind === 'universe'
    ? entry.scope_kind === 'global' || (entry.scope_kind === 'universe' && Number(entry.universe_id) === Number(character.universe_id))
    : character?.scope_kind === 'global' ? entry.scope_kind === 'global' : entry.scope_kind === 'global' || entry.scope_kind === 'pending'));
}
export function updateLocationLinks(details, next) { return { ...(details || {}), location_links: normalizeLocationLinks(next) }; }
