import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { availableGroupItems, descendantGroupIds, groupMembershipRows } from './phase2-content.js';
import './phase-one.css';

const emptyGroup = { name: '', description: '', image_url: '', color: '#9b845c', tags: '', sort_order: 0, space_type: 'account', universe_id: '', parent_group_id: '' };

export function GroupManager({ ready, message, groups, items, groupItems, universes, activeUniverseId, apiV2, onChanged, onError }) {
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);
  const [itemId, setItemId] = useState('');
  const [includeChildren, setIncludeChildren] = useState(false);
  const visibleGroups = groups.filter(group => group.space_type === 'account' || !activeUniverseId || Number(group.universe_id) === Number(activeUniverseId));
  const selected = visibleGroups.find(group => String(group.id) === String(selectedId));
  const ordered = [...visibleGroups].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const excludedParentIds = draft?.editingId ? descendantGroupIds(groups, draft.editingId) : new Set();
  const canManage = ready;

  function create(parent = null) {
    setDraft({ ...emptyGroup, parent_group_id: parent?.id ? String(parent.id) : '', space_type: parent?.space_type || (activeUniverseId ? 'universe' : 'account'), universe_id: parent?.universe_id ? String(parent.universe_id) : (activeUniverseId || '') });
  }
  function edit(group) {
    setSelectedId(String(group.id));
    setDraft({ name: group.name, description: group.description || '', image_url: group.image_url || '', color: group.color || '#9b845c', tags: (group.tags || []).join(', '), sort_order: group.sort_order || 0, space_type: group.space_type, universe_id: group.universe_id ? String(group.universe_id) : '', parent_group_id: group.parent_group_id ? String(group.parent_group_id) : '' });
  }
  async function save(event) {
    event.preventDefault();
    const data = { ...draft, tags: String(draft.tags || '').split(',').map(tag => tag.trim()).filter(Boolean), universe_id: draft.universe_id ? Number(draft.universe_id) : null, parent_group_id: draft.parent_group_id ? Number(draft.parent_group_id) : null };
    try {
      if (!selected && draft.editingId) setSelectedId(String(draft.editingId));
      const editingId = draft.editingId;
      if (editingId) {
        const current = groups.find(group => String(group.id) === String(editingId));
        const moved = String(current?.parent_group_id || '') !== String(data.parent_group_id || '') || current?.space_type !== data.space_type || Number(current?.universe_id || 0) !== Number(data.universe_id || 0);
        if (moved) await apiV2(`/groups/${editingId}/move`, { method: 'PATCH', body: JSON.stringify({ parent_group_id: data.parent_group_id, space_type: data.space_type, universe_id: data.universe_id }) });
        const { parent_group_id, space_type, universe_id, editingId: ignored, ...metadata } = data;
        await apiV2(`/groups/${editingId}`, { method: 'PATCH', body: JSON.stringify(metadata) });
        setSelectedId(String(editingId));
      } else {
        const result = await apiV2('/groups', { method: 'POST', body: JSON.stringify(data) });
        setSelectedId(String(result.id));
      }
      setDraft(null);
      await onChanged();
    } catch (error) { onError(error.message); }
  }
  function startEdit(group) {
    setSelectedId(String(group.id));
    const value = { ...group, tags: (group.tags || []).join(', '), universe_id: group.universe_id ? String(group.universe_id) : '', parent_group_id: group.parent_group_id ? String(group.parent_group_id) : '', editingId: group.id };
    setDraft(value);
  }
  async function moveOrder(direction) {
    if (!selected) return;
    try { await apiV2(`/groups/${selected.id}/reorder`, { method: 'PATCH', body: JSON.stringify({ sort_order: selected.sort_order + direction }) }); await onChanged(); }
    catch (error) { onError(error.message); }
  }
  async function moveMembership(groupId, nextItemId) {
    try { await apiV2(`/groups/${groupId}/items`, { method: 'POST', body: JSON.stringify({ item_id: Number(nextItemId) }) }); setItemId(''); await onChanged(); }
    catch (error) { onError(error.message); }
  }
  async function removeMembership(groupId, contentId) {
    try { await apiV2(`/groups/${groupId}/items/${contentId}`, { method: 'DELETE' }); await onChanged(); }
    catch (error) { onError(error.message); }
  }
  async function removeGroup() {
    if (!selected || !window.confirm(`Eliminar el grupo “${selected.name}”? Su contenido se conservará.`)) return;
    try { await apiV2(`/groups/${selected.id}`, { method: 'DELETE' }); setSelectedId(''); await onChanged(); }
    catch (error) { onError(error.message); }
  }

  const memberRows = selected ? groupMembershipRows(items, groups, groupItems, selected.id, includeChildren) : [];
  const availableItems = selected ? availableGroupItems(items, groupItems, selected.id).filter(item => selected.space_type === 'account' || (item.scope_kind === 'universe' && Number(item.universe_id) === Number(selected.universe_id))) : [];

  function renderGroupTree(parentId = null, depth = 0) {
    return visibleGroups.filter(group => group.parent_group_id == null ? parentId == null : String(group.parent_group_id) === String(parentId))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map(group => <React.Fragment key={group.id}>
        <button className={`phase2-tree-row ${String(group.id) === String(selectedId) ? 'selected' : ''}`} style={{ '--tree-depth': depth, '--group-accent': group.color || '#9b845c' }} onClick={() => { setSelectedId(String(group.id)); setDraft(null); }}><span className="phase2-tree-mark"/><span>{group.name}</span><small>{group.space_type === 'account' ? 'Personal' : universes.find(item => Number(item.id) === Number(group.universe_id))?.name || 'Universo'}</small></button>
        {renderGroupTree(group.id, depth + 1)}
      </React.Fragment>);
  }

  if (!canManage) return <section className="panel phase2-empty"><h2>Agrupaciones todavía no disponibles</h2><p>{message || 'No hay datos de agrupaciones en el servidor. No se muestran grupos ficticios.'}</p></section>;
  return <section className="panel phase2-manager">
    <header className="phase2-panel-head"><div><div className="eyebrow">ORGANIZAR SIN CAMBIAR EL SCOPE</div><h2>Agrupaciones</h2><p>Un grupo puede reunir varios tipos y universos; las membresías no mueven los elementos.</p></div><button className="primary" onClick={() => create()}><Plus size={15}/> Nuevo grupo</button></header>
    <div className="phase2-tree-panel" aria-label="Árbol de agrupaciones">{renderGroupTree()}{!visibleGroups.length && <p className="phase2-inherited">Todavía no hay agrupaciones en esta vista.</p>}</div>
    <div className="phase2-toolbar"><label>Grupo<select value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Elegir agrupación</option>{ordered.map(group => <option key={group.id} value={group.id}>{group.parent_group_id ? '↳ ' : ''}{group.name} · {group.space_type === 'account' ? 'Usuario' : universes.find(item => Number(item.id) === Number(group.universe_id))?.name || 'Universo'}</option>)}</select></label>{selected && <><button className="secondary" onClick={() => startEdit(selected)}><Pencil size={14}/> Editar o mover</button><button className="secondary" onClick={() => create(selected)}><Plus size={14}/> Subgrupo</button><button className="icon-btn" title="Subir orden" onClick={() => moveOrder(-1)}><ArrowUp size={15}/></button><button className="icon-btn" title="Bajar orden" onClick={() => moveOrder(1)}><ArrowDown size={15}/></button><button className="danger-button" onClick={removeGroup}><Trash2 size={14}/> Eliminar</button></>}</div>
    {draft && <form className="form-grid phase2-form" onSubmit={save}>
      <label>Nombre<input required maxLength="160" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
      <label>Grupo padre<select value={draft.parent_group_id || ''} onChange={event => { const parent = groups.find(group => String(group.id) === event.target.value); setDraft({ ...draft, parent_group_id: event.target.value, ...(parent ? { space_type: parent.space_type, universe_id: parent.universe_id ? String(parent.universe_id) : '' } : {}) }); }}><option value="">Nivel raíz</option>{groups.filter(group => !excludedParentIds.has(String(group.id))).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      {!draft.parent_group_id && <><label>Espacio<select value={draft.space_type} onChange={event => setDraft({ ...draft, space_type: event.target.value, universe_id: event.target.value === 'account' ? '' : draft.universe_id })}><option value="account">Usuario: todos los scopes</option><option value="universe">Universo específico</option></select></label>{draft.space_type === 'universe' && <label>Universo<select required value={draft.universe_id || ''} onChange={event => setDraft({ ...draft, universe_id: event.target.value })}><option value="">Elegir universo</option>{universes.map(universe => <option key={universe.id} value={universe.id}>{universe.name}</option>)}</select></label>}</>}
      {draft.parent_group_id && <p className="phase2-inherited">El subgrupo hereda el espacio de su grupo padre.</p>}
      <label className="wide">Descripción<textarea rows="2" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
      <label>Portada (URL)<input type="url" value={draft.image_url} onChange={event => setDraft({ ...draft, image_url: event.target.value })}/></label><label>Color<input type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })}/></label>
      <label>Etiquetas<input value={draft.tags || ''} onChange={event => setDraft({ ...draft, tags: event.target.value })} placeholder="separadas, por, comas"/></label><label>Orden<input type="number" value={draft.sort_order} onChange={event => setDraft({ ...draft, sort_order: Number(event.target.value) })}/></label>
      <div className="wide phase2-toolbar"><button className="primary"><Check size={14}/> Guardar</button><button type="button" className="secondary" onClick={() => setDraft(null)}><X size={14}/> Cancelar</button></div>
    </form>}
    {selected && <><div className="phase2-toolbar"><label><input type="checkbox" checked={includeChildren} onChange={event => setIncludeChildren(event.target.checked)}/> Incluir subgrupos</label><label>Agregar elemento<select value={itemId} onChange={event => setItemId(event.target.value)}><option value="">Elegir elemento migrado</option>{availableItems.map(item => <option key={item.content_item_id} value={item.content_item_id}>{item.name} · {item.type_key} · {item.scope_kind}</option>)}</select></label><button className="secondary" disabled={!itemId} onClick={() => moveMembership(selected.id, itemId)}><Plus size={14}/> Agregar membresía</button></div><div className="content-list">{memberRows.map(({ item, groupId }) => <article key={item.content_item_id}><div><span className="eyebrow">{item.type_key} · {item.scope_kind}</span><h3>{item.name}</h3><p>{item.description}</p></div><button className="icon-btn" title="Quitar de este grupo" onClick={() => removeMembership(groupId, item.content_item_id)}><Trash2 size={15}/></button></article>)}{!memberRows.length && <p className="phase2-inherited">Este grupo todavía no tiene elementos. Los registros antiguos aparecen aquí cuando se hayan incorporado a content_items.</p>}</div></>}
    {!groups.length && <p className="phase2-inherited">Todavía no hay agrupaciones. Podés crear grupos de usuario o de un universo sin categorías predeterminadas.</p>}
  </section>;
}

const blankType = { label: '', icon: 'archive', field_schema: [] };
export function ContentTypeManager({ ready, types, apiV2, api, onChanged, onError }) {
  const [draft, setDraft] = useState(null);
  const [fieldDraft, setFieldDraft] = useState({ key: '', label: '', type: 'text', required: false, options: '' });
  const ordered = [...types].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.label.localeCompare(b.label));
  function create() { setDraft({ ...blankType, field_schema: [] }); }
  function edit(type) { setDraft({ ...type, field_schema: type.field_schema || [], editingId: type.id }); }
  function updateField(index, key, value) { setDraft(current => ({ ...current, field_schema: current.field_schema.map((field, i) => i === index ? { ...field, [key]: value } : field) })); }
  function addField(event) {
    event.preventDefault();
    if (!fieldDraft.key || !fieldDraft.label) return onError('Cada campo requiere una clave y un nombre.');
    const next = { key: fieldDraft.key, label: fieldDraft.label, type: fieldDraft.type, required: fieldDraft.required };
    if (fieldDraft.type === 'select') next.options = fieldDraft.options.split(',').map(value => value.trim()).filter(Boolean);
    setDraft(current => ({ ...current, field_schema: [...current.field_schema, next] }));
    setFieldDraft({ key: '', label: '', type: 'text', required: false, options: '' });
  }
  async function save(event) {
    event.preventDefault();
    try {
      if (ready) {
        const path = draft.editingId ? `/content-types/${draft.editingId}` : '/content-types';
        const body = { label: draft.label, icon: draft.icon, field_schema: draft.field_schema };
        await apiV2(path, { method: draft.editingId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      } else if (!draft.editingId) {
        await api('/content-types', { method: 'POST', body: JSON.stringify({ label: draft.label, icon: draft.icon }) });
      } else {
        onError('La edición de configuración dinámica requiere que la API v2 esté habilitada.');
        return;
      }
      setDraft(null); await onChanged();
    } catch (error) { onError(error.message); }
  }
  async function reorder(type, delta) {
    if (!ready) return onError('El orden dinámico requiere que la API v2 esté habilitada.');
    const index = ordered.findIndex(item => item.id === type.id); const next = [...ordered];
    const target = index + delta; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    try { await apiV2('/content-types/reorder', { method: 'PATCH', body: JSON.stringify({ ids: next.map(item => item.id) }) }); await onChanged(); }
    catch (error) { onError(error.message); }
  }
  async function retire(type) {
    try { await apiV2(`/content-types/${type.id}/retire`, { method: 'POST' }); await onChanged(); }
    catch (error) { onError(error.message); }
  }
  async function remove(type) {
    if (!window.confirm(`Eliminar el tipo “${type.label}”? Solo se elimina si no tiene elementos.`)) return;
    try { await apiV2(`/content-types/${type.id}`, { method: 'DELETE' }); await onChanged(); }
    catch (error) { onError(error.message); }
  }

  return <section className="panel phase2-manager">
    <header className="phase2-panel-head"><div><div className="eyebrow">TIPOS CONFIGURABLES</div><h2>Tipos de contenido</h2><p>Los formularios de cada tipo usan sus campos configurados. Los personajes conservan su ficha especializada.</p></div><button className="primary" onClick={create}><Plus size={15}/> Nuevo tipo</button></header>
    {!ready && <p className="phase2-inherited">El servidor permite consultar y crear tipos básicos, pero editar campos, ordenar y retirar requiere el esquema v2. No se instala automáticamente.</p>}
    {draft && <form className="phase2-type-form" onSubmit={save}><div className="form-grid"><label>Nombre<input required maxLength="60" value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })}/></label><label>Icono<input maxLength="50" value={draft.icon} onChange={event => setDraft({ ...draft, icon: event.target.value })}/></label></div>{ready && <><h3>Campos del formulario</h3>{draft.field_schema.map((field, index) => <div className="phase2-field-row" key={`${field.key}-${index}`}><label>Clave<input value={field.key} onChange={event => updateField(index, 'key', event.target.value)}/></label><label>Etiqueta<input value={field.label} onChange={event => updateField(index, 'label', event.target.value)}/></label><label>Tipo<select value={field.type} onChange={event => updateField(index, 'type', event.target.value)}>{['text','textarea','number','date','url','select','checkbox','tags'].map(type => <option key={type}>{type}</option>)}</select></label><label>Requerido<input type="checkbox" checked={Boolean(field.required)} onChange={event => updateField(index, 'required', event.target.checked)}/></label>{field.type === 'select' && <label>Opciones<input value={(field.options || []).join(', ')} onChange={event => updateField(index, 'options', event.target.value.split(',').map(value => value.trim()).filter(Boolean))}/></label>}<button type="button" className="icon-btn" title="Quitar campo" onClick={() => setDraft({ ...draft, field_schema: draft.field_schema.filter((_, i) => i !== index) })}><Trash2 size={14}/></button></div>)}<div className="phase2-new-field"><label>Clave<input value={fieldDraft.key} onChange={event => setFieldDraft({ ...fieldDraft, key: event.target.value })} placeholder="key_name"/></label><label>Etiqueta<input value={fieldDraft.label} onChange={event => setFieldDraft({ ...fieldDraft, label: event.target.value })}/></label><label>Tipo<select value={fieldDraft.type} onChange={event => setFieldDraft({ ...fieldDraft, type: event.target.value })}>{['text','textarea','number','date','url','select','checkbox','tags'].map(type => <option key={type}>{type}</option>)}</select></label><label className="phase2-required"><input type="checkbox" checked={fieldDraft.required} onChange={event => setFieldDraft({ ...fieldDraft, required: event.target.checked })}/> Requerido</label>{fieldDraft.type === 'select' && <label>Opciones<input value={fieldDraft.options} onChange={event => setFieldDraft({ ...fieldDraft, options: event.target.value })} placeholder="opción A, opción B"/></label>}<button type="button" className="secondary" onClick={addField}><Plus size={13}/> Añadir campo</button></div></>}
      <div className="phase2-toolbar"><button className="primary"><Check size={14}/> Guardar</button><button type="button" className="secondary" onClick={() => setDraft(null)}><X size={14}/> Cancelar</button></div>
    </form>}
    <div className="content-list">{ordered.map(type => <article key={type.id}><div><span className="eyebrow">{type.slug} · {type.is_active === false ? 'Retirado' : 'Activo'}</span><h3>{type.label}</h3><p>{(type.field_schema || []).map(field => field.label).join(' · ') || 'Sin campos adicionales'}</p></div><div className="phase2-toolbar"><button className="icon-btn" title="Subir" disabled={!ready} onClick={() => reorder(type, -1)}><ArrowUp size={14}/></button><button className="icon-btn" title="Bajar" disabled={!ready} onClick={() => reorder(type, 1)}><ArrowDown size={14}/></button><button className="icon-btn" title="Editar" disabled={!ready} onClick={() => edit(type)}><Pencil size={14}/></button><button className="secondary" disabled={!ready || type.is_active === false} onClick={() => retire(type)}>Retirar</button><button className="icon-btn" title="Eliminar si está vacío" disabled={!ready} onClick={() => remove(type)}><Trash2 size={14}/></button></div></article>)}{!ordered.length && <p className="phase2-inherited">Todavía no creaste tipos personalizados.</p>}</div>
  </section>;
}
