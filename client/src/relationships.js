const parentWords=['parent','mother','father','madre','padre','progenitor','adoptive','adoptivo','tutor','tutora'];
const childWords=['child','son','daughter','hijo','hija'];
export function familyRelationDirection(type=''){
  const value=String(type).toLocaleLowerCase();
  if(parentWords.some(word=>value.includes(word)))return 'parent-to-child';
  if(childWords.some(word=>value.includes(word)))return 'child-to-parent';
  return 'peer';
}
export function buildFamilyGenerations(relationships,characters,rootId){
  const known=new Map(characters.map(character=>[Number(character.id),character]));
  const generation=new Map([[Number(rootId),0]]);const edges=[];
  for(const relation of relationships){
    const source=Number(relation.source_character_id),target=Number(relation.target_character_id);
    if(!known.has(source)||!known.has(target)||!String(relation.relation_type||'').toLocaleLowerCase().match(/family|parent|mother|father|madre|padre|progenitor|adopt|tutor|child|son|daughter|hijo|hija|sibling|herman|spouse|pareja/))continue;
    edges.push({source,target,direction:familyRelationDirection(relation.relation_type)});
  }
  let changed=true,passes=0;
  while(changed&&passes++<known.size){changed=false;for(const edge of edges){
    const from=edge.direction==='child-to-parent'?edge.target:edge.source;const to=edge.direction==='child-to-parent'?edge.source:edge.target;
    if(edge.direction==='peer'){
      if(generation.has(from)&&!generation.has(to)){generation.set(to,generation.get(from));changed=true;}
      else if(generation.has(to)&&!generation.has(from)){generation.set(from,generation.get(to));changed=true;}
    }else if(generation.has(from)&&!generation.has(to)){generation.set(to,generation.get(from)+1);changed=true;}
    else if(generation.has(to)&&!generation.has(from)){generation.set(from,generation.get(to)-1);changed=true;}
  }}
  const levels=new Map();for(const[id,level]of generation){if(!levels.has(level))levels.set(level,[]);levels.get(level).push(known.get(id));}
  return [...levels.entries()].sort((a,b)=>a[0]-b[0]).map(([level,rows])=>({level,characters:rows.sort((a,b)=>a.name.localeCompare(b.name))}));
}
