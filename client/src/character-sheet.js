export const CHARACTER_SECTION_TEMPLATES = [
  ['general','Información general','text'],['appearance','Apariencia física','text'],['personality','Personalidad','text'],['biography','Historia y biografía','text'],['likes','Gustos y disgustos','list'],['habits','Hábitos y costumbres','list'],['wardrobe','Vestimenta y atuendos','image'],['abilities','Habilidades y poderes','list'],['relationships','Relaciones','links'],['family','Familia','links'],['occupation','Ocupación','text'],['trivia','Curiosidades','list'],['goals','Objetivos y motivaciones','text'],['fears','Miedos','list'],['secrets','Secretos','text'],['voice','Voz y forma de hablar','text'],['gallery','Galería de imágenes','gallery'],
].map(([key,name,content_type])=>({key,name,content_type}));

export function normalizeCharacterSheet(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sections = Array.isArray(source.sections) ? source.sections.filter(section => section && typeof section.id === 'string').map((section,index)=>({
    ...section, name: String(section.name || 'Sección'), visible: section.visible !== false,
    order: Number.isFinite(Number(section.order)) ? Number(section.order) : index,
    content_type: ['text','list','fields','image','links','gallery'].includes(section.content_type) ? section.content_type : 'text',
    content: section.content ?? '', fields: Array.isArray(section.fields) ? section.fields : [],
  })).sort((a,b)=>a.order-b.order) : [];
  const timeline = Array.isArray(source.timeline) ? source.timeline.filter(item=>item && typeof item.id === 'string').map((item,index)=>({
    ...item, period: String(item.period || ''), title: String(item.title || ''), description: String(item.description || ''),
    related_items: Array.isArray(item.related_items) ? item.related_items : [], order: Number(item.order ?? index),
  })).sort((a,b)=>a.order-b.order) : [];
  return { ...source, version: 1, sections, timeline, gallery: { ...(source.gallery || {}), order: Array.isArray(source.gallery?.order) ? source.gallery.order.map(Number) : [], primary_media_id: source.gallery?.primary_media_id == null ? null : Number(source.gallery.primary_media_id) } };
}

export function characterSheetFromDetails(details = {}, biography = '') {
  let sheet = normalizeCharacterSheet(details.character_sheet);
  if (biography && !sheet.sections.some(section=>section.key==='biography')) {
    sheet={...sheet,sections:[...sheet.sections,{id:'legacy-biography',key:'biography',name:'Historia y biografía',content_type:'text',visible:true,order:sheet.sections.length,content:biography,fields:[]}]};
  }
  const legacy = [
    ['appearance','Apariencia física','text'],['personality','Personalidad','text'],['goals','Objetivos y motivaciones','text'],
    ['fears','Miedos','text'],['voice','Voz y forma de hablar','text'],['skills','Habilidades','text'],['weaknesses','Debilidades','text'],
  ];
  for (const [key,name,content_type] of legacy) {
    const value=details[key];
    if (typeof value !== 'string' || !value.trim() || sheet.sections.some(section=>section.key===key)) continue;
    const id=`legacy-${key}`;
    sheet={...sheet,sections:[...sheet.sections,{id,key,name,content_type,visible:true,order:sheet.sections.length,content:value,fields:[]}]};
  }
  return sheet;
}

export function addCharacterSection(sheet, template, id = globalThis.crypto?.randomUUID?.() || `section-${Date.now()}`) {
  if (sheet.sections.some(section=>section.key===template.key && template.key)) return sheet;
  const sections=[...sheet.sections,{ id, key:template.key || null, name:template.name, content_type:template.content_type || 'text', visible:true, order:sheet.sections.length, content:'', fields:[] }];
  return { ...sheet, sections };
}

export function moveCharacterSection(sheet, sectionId, offset) {
  const sections=[...sheet.sections]; const index=sections.findIndex(section=>section.id===sectionId); const target=index+offset;
  if(index<0||target<0||target>=sections.length)return sheet;
  [sections[index],sections[target]]=[sections[target],sections[index]];
  return { ...sheet, sections:sections.map((section,order)=>({...section,order})) };
}
