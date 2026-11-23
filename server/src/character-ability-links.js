export async function validateCharacterAbilityLinks(pool, ownerId, scope, details) {
  const abilities=details?.character_sheet?.abilities;
  if(!Array.isArray(abilities))return null;
  const references=[];
  for(const ability of abilities){
    if(!ability||typeof ability!=='object')continue;
    if(ability.ability_entry_id!=null)references.push({id:Number(ability.ability_entry_id),kind:'ability'});
    for(const id of Array.isArray(ability.system_entry_ids)?ability.system_entry_ids:[])references.push({id:Number(id),kind:'magic'});
  }
  if(references.some(ref=>!Number.isSafeInteger(ref.id)||ref.id<1))return 'Una habilidad o sistema vinculado no tiene un identificador válido.';
  const ids=[...new Set(references.map(ref=>ref.id))];
  if(!ids.length)return null;
  const result=await pool.query('SELECT id,owner_id,kind,scope_kind,universe_id FROM archive_entries WHERE owner_id=$1 AND id=ANY($2::int[])',[ownerId,ids]);
  const entries=new Map(result.rows.map(row=>[Number(row.id),row]));
  for(const ref of references){
    const entry=entries.get(ref.id);
    if(!entry)return 'Una habilidad o sistema vinculado no existe en tu archivo.';
    if(entry.kind!==ref.kind)return `La ficha ${ref.kind==='ability'?'de habilidad':'de sistema'} vinculada no tiene el tipo esperado.`;
    if(entry.scope_kind!==scope.scope_kind||Number(entry.universe_id||0)!==Number(scope.universe_id||0))return 'Las habilidades y sistemas deben pertenecer al mismo ámbito del personaje.';
  }
  return null;
}
