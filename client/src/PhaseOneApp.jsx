import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, Globe2, Users, BookOpen, ScrollText, Plus, Pencil, Trash2, ChevronRight, LogOut, Search, Layers, X, Sparkles, Settings, Heart, Image, Network, Boxes, SlidersHorizontal } from 'lucide-react';
import './app.css';
import './settings.css';
import './phase-one.css';
import { characterTagsToForm, characterTagsToApi } from './character-payload.js';
import { attachContentType, dynamicFieldModel, dynamicFieldValue, hydrateLegacyEditorRecord, libraryEmptyState, phase2UnavailableMessage, selectLibraryView, uniqueContentItems } from './phase2-content.js';
import { ContentTypeManager, GroupManager } from './phase2-panels.jsx';
import { compatibleLocationOptions, normalizeLocationLinks, updateLocationLinks } from './character-locations.js';
import { CharacterSheet } from './character-sheet.jsx';
import { RelationshipPanel as RelationshipNetworkPanel } from './relationship-panel.jsx';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const TOKEN = 'oc-archive-session';
async function api(path, options = {}) {
  if (import.meta.env.PROD && !API) throw new Error('Falta configurar VITE_API_URL para conectar la API.');
  const headers = { 'Content-Type': 'application/json', ...(localStorage.getItem(TOKEN) ? { Authorization: `Bearer ${localStorage.getItem(TOKEN)}` } : {}), ...options.headers };
  const response = await fetch(`${API}/api${path}`, { ...options, headers });
  if (response.status === 503) { const body = await response.json().catch(() => ({})); const error = new Error(body.error || 'La API de contenido todavía no está habilitada.'); error.status = response.status; error.code = body.code; throw error; }
  if (!response.ok) { const body = await response.json().catch(() => ({})); const fieldErrors = body.details?.fieldErrors || {}; const formErrors = body.details?.formErrors || []; const detail = [...Object.entries(fieldErrors).flatMap(([field, messages]) => (messages || []).map(message => field + ': ' + message)), ...formErrors].join('; '); throw new Error([body.error || ('Error ' + response.status), detail].filter(Boolean).join(' — ')); }
  return response.status === 204 ? null : response.json();
}
const apiV2 = (path, options) => api(`/v2${path}`, options);
const nav = [
  { id: 'dashboard', label: 'Inicio', icon: Archive }, { id: 'library', label: 'Biblioteca', icon: BookOpen },
  { id: 'global', label: 'Contenido global', icon: Globe2 },
  { id: 'pending', label: 'Pendiente de organizar', icon: ScrollText }, { id: 'universes', label: 'Universos', icon: Globe2 },
  { id: 'characters', label: 'Personajes', icon: Users }, { id: 'locations', label: 'Lugares', icon: Layers },
  { id: 'groups', label: 'Grupos y organizaciones', icon: Users }, { id: 'events', label: 'Eventos', icon: ScrollText },
  { id: 'stories', label: 'Historias', icon: BookOpen }, { id: 'species', label: 'Especies', icon: Users }, { id: 'magic', label: 'Magia', icon: Sparkles }, { id: 'artifacts', label: 'Artefactos', icon: Layers },
  { id: 'notes', label: 'Notas', icon: BookOpen }, { id: 'gallery', label: 'Galería', icon: Image }, { id: 'relationships', label: 'Relaciones', icon: Network }, { id: 'favorites', label: 'Favoritos', icon: Heart }, { id: 'settings', label: 'Ajustes', icon: Settings },
];
nav.push({ id: 'collections', label: 'Agrupaciones', icon: Boxes }, { id: 'content-types', label: 'Tipos de contenido', icon: SlidersHorizontal });
const kindFor = { locations: 'location', groups: 'group', events: 'event', stories: 'story', species: 'species', magic: 'magic', artifacts: 'artifact', notes: 'note', gallery: 'gallery' };
const titleFor = Object.fromEntries(nav.map(item => [item.id, item.label]));
const blankUniverse = { name: '', description: '', genre: '', tone: '', color: '#a78c62', icon: '', cover_url: '', lore: '', history: '', tags: [] };
const blankCharacter = { name: '', alias: '', pronouns: '', gender: '', species: '', origin: '', residence: '', occupation: '', status: '', powers: '', tags: '', description: '', biography: '', details: {} };
const blankEntry = { name: '', description: '', tags: '', data: {} };

function SignIn({ onLogin }) {
  const [mode, setMode] = useState('login'), [form, setForm] = useState({ identifier: '', username: '', email: '', password: '' }), [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setError('');
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(mode === 'login' ? { identifier: form.identifier, password: form.password } : { username: form.username, email: form.email, password: form.password }) });
      localStorage.setItem(TOKEN, data.token); onLogin(data.user);
    } catch (err) { setError(err.message); }
  }
  return <main className="auth"><section className="auth-card"><div className="seal"><Archive/></div><div className="eyebrow">OC ARCHIVE</div><h1>Tu atlas personal</h1><div className="auth-tabs"><button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Ingresar</button><button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>Crear cuenta</button></div><form onSubmit={submit}>{mode === 'login' ? <label>Usuario o email<input required value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })}/></label> : <><label>Usuario<input required minLength="3" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}/></label><label>Email<input required type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}/></label></>}<label>Contrasena<input required type="password" minLength={mode === 'register' ? 10 : 1} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}/></label>{error && <div className="error">{error}</div>}<button className="primary full">{mode === 'login' ? 'Entrar' : 'Crear cuenta'}</button></form></section></main>;
}

function App() {
  const [user, setUser] = useState(null), [checking, setChecking] = useState(true);
  const [page, setPage] = useState('dashboard'), [universes, setUniverses] = useState([]), [characters, setCharacters] = useState([]), [entries, setEntries] = useState([]), [locationEntries, setLocationEntries] = useState([]), [library, setLibrary] = useState([]), [nodes, setNodes] = useState([]), [dashboard, setDashboard] = useState(null), [favorites, setFavorites] = useState([]), [relationships, setRelationships] = useState([]);
  const [phase2Items, setPhase2Items] = useState([]), [groups, setGroups] = useState([]), [groupItems, setGroupItems] = useState({}), [contentTypes, setContentTypes] = useState([]);
  const [sheetCharacter, setSheetCharacter] = useState(null);
  const [phase2Ready, setPhase2Ready] = useState(false), [phase2Message, setPhase2Message] = useState('');
  const [universeId, setUniverseId] = useState(''), [nodeId, setNodeId] = useState(''), [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'), [scopeFilter, setScopeFilter] = useState('all'), [groupedFilter, setGroupedFilter] = useState('all'), [groupFilter, setGroupFilter] = useState('all'), [tagFilter, setTagFilter] = useState(''), [fieldFilters, setFieldFilters] = useState({});
  const [modal, setModal] = useState(''), [editing, setEditing] = useState(null), [draft, setDraft] = useState(null), [theme, setTheme] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const activeCustomType = contentTypes.find(type => `custom-type-${type.id}` === page);
  const visibleNav = [...nav, ...contentTypes.filter(type => type.is_active !== false).map(type => ({ id: `custom-type-${type.id}`, label: type.label, icon: Layers }))];
  const scope = page === 'pending' ? 'pending' : page === 'global' ? 'global' : universeId ? 'universe' : 'all';
  const scopeQuery = useMemo(() => {
    const params = new URLSearchParams({ scope });
    if (scope === 'universe') params.set('universe_id', universeId);
    if (scope === 'universe' && nodeId) params.set('node_id', nodeId);
    if (query) params.set('q', query);
    return params.toString();
  }, [scope, universeId, nodeId, query]);

  async function loadPhase2() {
    try {
      const [items, nextGroups, types] = await Promise.all([
        apiV2('/content-items'), apiV2('/groups'), apiV2('/content-types'),
      ]);
      const normalizedItems = uniqueContentItems(items.map(item => attachContentType(item, types)));
      const memberships = await Promise.all(nextGroups.map(async group => {
        const rows = await apiV2(`/groups/${group.id}/items`);
        return [String(group.id), rows.map(row => String(row.id))];
      }));
      setPhase2Items(normalizedItems);
      setGroups(nextGroups);
      setGroupItems(Object.fromEntries(memberships));
      setContentTypes(types);
      setPhase2Ready(true);
      setPhase2Message('');
      return { ready: true, items: normalizedItems };
    } catch (err) {
      setPhase2Ready(false);
      setGroups([]);
      setGroupItems({});
      setPhase2Items([]);
      setPhase2Message(phase2UnavailableMessage(err));
      try {
        const legacyTypes = await api('/content-types');
        setContentTypes(legacyTypes.map(type => ({ ...type, field_schema: [], is_active: true, legacyOnly: true })));
      } catch { setContentTypes([]); }
      return { ready: false, items: [] };
    }
  }

  async function load() {
    if (!user) return;
    setBusy(true); setError('');
    try {
      const [u, c, d] = await Promise.all([api('/universes'), api(`/characters?${scopeQuery}`), api('/dashboard')]);
      setUniverses(u); setCharacters(c); setDashboard(d);
      setLocationEntries(await api('/entries?scope=all&kind=location'));
      const phase2 = await loadPhase2();
      if (page === 'library' || page === 'global' || page === 'pending') {
        const legacy = await api(`/library?${scopeQuery}`);
        setLibrary(uniqueContentItems(phase2.ready ? phase2.items : legacy));
      }
    else if (kindFor[page]) setEntries(await api(`/entries?${scopeQuery}&kind=${kindFor[page]}`));
      else if (activeCustomType) setEntries((await api(`/entries?${scopeQuery}&kind=${encodeURIComponent(activeCustomType.slug)}`)).map(row => ({ ...row, source_table: 'archive_entries', source_id: row.id, type_key: row.kind, migrated: false })));
      else if (page === 'favorites') setFavorites(await api('/favorites'));
      else if (page === 'relationships') setRelationships(await api(universeId ? `/relationships?universe_id=${universeId}` : '/relationships'));
      if (universeId) setNodes(await api(`/universes/${universeId}/nodes`)); else setNodes([]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!localStorage.getItem(TOKEN)) { setChecking(false); return; }
    api('/auth/me').then(result => setUser(result.user)).catch(() => localStorage.removeItem(TOKEN)).finally(() => setChecking(false));
  }, []);
  useEffect(() => { if (user) load(); }, [user, page, scopeQuery, universeId, activeCustomType?.id]);
  useEffect(() => {
    setTheme(null);
    if (user && universeId) api(`/universes/${universeId}/theme`).then(setTheme).catch(err => setError(err.message));
  }, [universeId, user]);
  useEffect(() => {
    const active = theme || { page_bg: '#191917', panel_bg: '#24231f', ink: '#ede8dc', muted: '#aaa395', line: '#403d35', accent: '#b69a68', sidebar_bg: '#11110f' };
    for (const key of ['page_bg', 'panel_bg', 'ink', 'muted', 'line', 'accent', 'sidebar_bg']) document.documentElement.style.setProperty(`--${key.replaceAll('_', '-')}`, active[key]);
  }, [theme]);
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch {} localStorage.removeItem(TOKEN); setUser(null); }
  async function open(kind, row = null) {
    if (row?.entity_type && row.entity_type !== 'universe' && !row.source_table) { setError('Este elemento unificado todavía no tiene una ruta de edición compatible; no se envió ningún cambio.'); return; }
    if (row?.source_table && !row.source_snapshot) {
      try {
        const loaded = await api(`/${row.source_table === 'characters' ? 'characters' : 'entries'}/${row.source_id ?? row.id}`);
        row = { ...loaded, source_table: row.source_table, source_id: row.source_id ?? row.id, source_snapshot: loaded };
      } catch (err) { setError(`No se pudo cargar la ficha completa; no se enviaron cambios. ${err.message}`); return; }
    }
    if (row?.source_table) row = hydrateLegacyEditorRecord(row);
    setError(''); setEditing(row); setModal(kind);
    if (kind === 'universe') setDraft({ ...blankUniverse, ...(row || {}) });
    else if (kind === 'node') setDraft({ name: row?.name || '', node_type: row?.node_type || 'section', description: row?.description || '', parent_id: row?.parent_id || '', sort_order: row?.sort_order || 0 });
    else if (kind === 'character') setDraft({ ...blankCharacter, ...(row || {}), tags: characterTagsToForm(row?.tags), scope_kind: row?.scope_kind || (row ? (row.universe_id ? 'universe' : 'pending') : page === 'global' ? 'global' : universeId ? 'universe' : 'pending'), universe_id: row?.universe_id || universeId || '', universe_node_id: row?.universe_node_id || nodeId || '' });
    else setDraft({ ...blankEntry, ...(row || {}), kind: row?.kind || activeCustomType?.slug || kindFor[page] || 'note', scope_kind: row?.scope_kind || (row ? (row.universe_id ? 'universe' : 'pending') : page === 'global' ? 'global' : universeId ? 'universe' : 'pending'), universe_id: row?.universe_id || universeId || '', universe_node_id: row?.universe_node_id || nodeId || '', tags: Array.isArray(row?.tags) ? row.tags.join(', ') : row?.tags || '' });
  }
  async function save(e) {
    e.preventDefault(); setError('');
    try {
      if (modal === 'universe') {
        const body = { ...draft, tags: String(draft.tags || '').split(',').map(x => x.trim()).filter(Boolean) };
        await api(`/universes${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      } else if (modal === 'node') {
        const body = { ...draft, parent_id: draft.parent_id ? Number(draft.parent_id) : null };
        const path = editing ? `/nodes/${editing.id}` : `/universes/${universeId}/nodes`;
        await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ ...body, ...(editing ? { universe_id: Number(universeId) } : {}) }) });
      } else {
        const classified = draft.scope_kind === 'universe';
        const scopeFields = { ...draft, universe_id: classified && draft.universe_id ? Number(draft.universe_id) : null, universe_node_id: classified && draft.universe_node_id ? Number(draft.universe_node_id) : null };
        if (modal === 'character') {
          const body = { ...scopeFields, tags: characterTagsToApi(draft.tags) };
          const path = '/characters' + (editing ? '/' + editing.id : '');
          await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
        } else {
          const tags = Array.isArray(draft.tags) ? draft.tags : String(draft.tags || '').split(',').map(x => x.trim()).filter(Boolean);
          const path = '/entries' + (editing ? '/' + editing.id : '');
          await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ ...scopeFields, kind: editing?.kind || activeCustomType?.slug || kindFor[page] || 'note', tags }) });
        }      }
      setModal(''); await load();
    } catch (err) { setError(err.message); }
  }
  async function remove(type, row) {
    if (row?.entity_type && row.entity_type !== 'universe' && !row.source_table) { setError('Este elemento unificado todavía no tiene una ruta de eliminación compatible; no se envió ningún cambio.'); return; }
    if (!window.confirm(`Delete "${row.name}"?`)) return;
    const entityType = row?.entity_type === 'universe' ? 'universe' : type;
    const path = entityType === 'universe' ? `/universes/${row.id}` : entityType === 'character' ? `/characters/${row.id}` : entityType === 'node' ? `/nodes/${row.id}` : `/entries/${row.id}`;
    try { await api(path, { method: 'DELETE' }); await load(); } catch (err) { setError(err.message); }
  }
  async function addFavorite(entity_type, row) {
    if (row?.entity_type && row.entity_type !== 'universe' && !row.source_table) { setError('Este elemento unificado todavía no está disponible para favoritos heredados.'); return; }
    try { await api('/favorites', { method: 'POST', body: JSON.stringify({ entity_type, entity_id: Number(row.id || row.entity_id) }) }); setError('Agregado a favoritos.'); }
    catch (err) { setError(err.message); }
  }
  async function saveTheme(event) {
    event.preventDefault();
    try { const result = await api(`/universes/${universeId}/theme`, { method: 'PUT', body: JSON.stringify(theme) }); setTheme(result); setError('Universe appearance saved.'); }
    catch (err) { setError(err.message); }
  }
  const selectedUniverse = universes.find(u => String(u.id) === String(universeId));
  const selectedNode = nodes.find(node => String(node.id) === String(nodeId));
  const rowsForPage = entries.filter(row => !query || `${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase()));
  const membershipByItem = useMemo(() => {
    const map = new Map();
    for (const [groupId, itemIds] of Object.entries(groupItems)) for (const itemId of itemIds) {
      if (!map.has(String(itemId))) map.set(String(itemId), new Set());
      map.get(String(itemId)).add(String(groupId));
    }
    return map;
  }, [groupItems]);
  const visibleLibraryRows = useMemo(() => selectLibraryView(library, {
    view: page === 'pending' ? 'pending' : page === 'global' ? 'global' : universeId ? 'universe' : 'library',
    type: typeFilter, scope: page === 'global' ? 'global' : scopeFilter,
    universeId: universeId || undefined, query, tag: tagFilter,
    grouped: page === 'pending' ? 'all' : groupedFilter,
    groupId: page === 'pending' || groupFilter === 'all' ? undefined : groupFilter,
    membershipByItem, excludePending: page !== 'pending', fields: fieldFilters,
  }), [library, page, typeFilter, scopeFilter, universeId, query, tagFilter, groupedFilter, groupFilter, membershipByItem, fieldFilters]);
  const dynamicTypeItems = activeCustomType
    ? phase2Ready ? phase2Items.filter(row => row.type_key === activeCustomType.slug && (universeId
      ? row.scope_kind === 'universe' && Number(row.universe_id) === Number(universeId)
      : true)) : entries
    : [];
  const isList = page === 'library' || page === 'global' || page === 'pending';
  const headerTitle = activeCustomType?.label || (page === 'dashboard' ? 'Tu archivo de un vistazo' : (page === 'library' || page === 'global') && selectedUniverse ? (selectedNode?.name || selectedUniverse.name) : titleFor[page] || page);
  const contextDescription = activeCustomType ? `Contenido del tipo ${activeCustomType.label}.` : page === 'collections' ? 'Organizá elementos sin alterar su universo ni su estado.' : page === 'pending' ? 'Estos registros esperan una clasificación y no son globales.' : selectedUniverse ? `Solo se muestra contenido de ${selectedUniverse.name}.` : 'Tus universos, contenido global y elementos pendientes en una sección separada.';
  if (checking) return <div className="boot">Opening archive...</div>;
  if (!user) return <SignIn onLogin={setUser}/>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-seal"><Archive size={18}/></span><span><b>OC ARCHIVE</b><small>PERSONAL WORLD ATLAS</small></span></div>
      <div className="side-caption">ARCHIVE VIEWS</div><nav>{visibleNav.map(item => <button key={item.id} className={page === item.id ? 'nav active' : 'nav'} onClick={() => setPage(item.id)}><item.icon size={16}/><span>{item.label}</span></button>)}</nav>
      {selectedUniverse && <section className="universe-tree"><div className="tree-head"><small>{selectedUniverse.name}</small><button title="Add level" onClick={() => open('node')}><Plus size={14}/></button></div><button className={!nodeId ? 'tree-root selected' : 'tree-root'} onClick={() => { setNodeId(''); setPage('library'); }}>Universe overview</button><NodeTree nodes={nodes} parentId={null} selectedId={nodeId} onSelect={id => { setNodeId(id); setPage('library'); }} onEdit={row => open('node', row)} onDelete={row => remove('node', row)}/></section>}
      <div className="side-foot"><div className="profile-mark">{user.username[0].toUpperCase()}</div><div className="profile-name"><b>{user.username}</b><small>Private archive</small></div><button className="icon-btn" onClick={logout} title="Log out"><LogOut size={15}/></button></div>
    </aside>
    <main className="main"><header className="topbar"><span>ARCHIVE <ChevronRight size={13}/> <b>{headerTitle}</b></span><label className="context-picker"><Globe2 size={15}/><select value={universeId} onChange={e => { setUniverseId(e.target.value); setNodeId(''); }}><option value="">All universes</option>{universes.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label><div className="top-search"><Search size={16}/><input placeholder="Search this view..." value={query} onChange={e => setQuery(e.target.value)}/></div><button className="avatar" onClick={() => setPage('settings')}>{user.username[0].toUpperCase()}</button></header>
      <div className="content"><section className="heading"><div><div className="eyebrow">ATLAS PERSONAL <span>✳</span></div><h1>{headerTitle}</h1><p>{contextDescription}</p></div>
        {(page === 'universes' || page === 'characters' || kindFor[page] || isList || activeCustomType) && <button className="primary" onClick={() => open(page === 'universes' ? 'universe' : page === 'characters' ? 'character' : 'entry')}><Plus size={15}/> {page === 'universes' ? 'New universe' : page === 'characters' ? 'New character' : activeCustomType ? `New ${activeCustomType.label}` : 'New item'}</button>}
      </section>
      {error && <div className="notice">{error}<button onClick={() => setError('')}><X size={14}/></button></div>}
       {!phase2Ready && phase2Message && ['library', 'global', 'pending', 'collections', 'content-types'].includes(page) && <div className="phase2-banner" role="status"><b>Organización v2 no disponible.</b> {phase2Message}</div>}
      {busy && <div className="loading">Loading saved content...</div>}
      {!phase2Ready && phase2Message && activeCustomType && <div className="phase2-banner" role="status"><b>Organización v2 no disponible.</b> {phase2Message}</div>}
      {page === 'dashboard' && dashboard && <><section className="stats"><div><Globe2/><b>{dashboard.counts.universes}</b><small>Universos</small></div><div><Users/><b>{characters.length}</b><small>Personajes en esta vista</small></div><div><BookOpen/><b>{dashboard.counts.entries}</b><small>Entradas de mundo</small></div><div><ScrollText/><b>{dashboard.counts.pending}</b><small>Pendientes</small></div></section><section className="panel"><div className="panel-head"><div><div className="eyebrow">EMPEZAR</div><h2>Elegí un universo o abrí la biblioteca global</h2></div><button className="text-btn" onClick={() => setPage('universes')}>Ver universos <ChevronRight size={14}/></button></div></section></>}
      {page === 'universes' && <UniverseList rows={universes} onOpen={u => { setUniverseId(String(u.id)); setNodeId(''); setPage('library'); }} onEdit={u => open('universe', u)} onDelete={u => remove('universe', u)} onFavorite={row => addFavorite('universe', row)}/>}
      {(page === 'library' || page === 'global') && <><LibraryFilters items={library} types={contentTypes} groups={groups} ready={phase2Ready} type={typeFilter} setType={setTypeFilter} scope={scopeFilter} setScope={value => value === 'pending' ? setPage('pending') : setScopeFilter(value)} grouped={groupedFilter} setGrouped={setGroupedFilter} group={groupFilter} setGroup={setGroupFilter} tag={tagFilter} setTag={setTagFilter} fields={fieldFilters} setFields={setFieldFilters}/><ContentList rows={visibleLibraryRows} universes={universes} pending={false} onEdit={row => open(row.entity_type === 'character' ? 'character' : row.entity_type === 'universe' ? 'universe' : 'entry', { ...row, id: row.entity_id })} onDelete={row => remove(row.entity_type === 'character' ? 'character' : 'entry', { ...row, id: row.entity_id })} onFavorite={row => addFavorite(row.entity_type === 'character' ? 'character' : row.entity_type === 'universe' ? 'universe' : 'entry', row)}/></>}
      {page === 'pending' && <ContentList rows={visibleLibraryRows} universes={universes} pending onEdit={row => open(row.entity_type === 'character' ? 'character' : 'entry', { ...row, id: row.entity_id })} onDelete={row => remove(row.entity_type === 'character' ? 'character' : 'entry', { ...row, id: row.entity_id })} onFavorite={row => addFavorite(row.entity_type === 'character' ? 'character' : 'entry', row)}/>}
      {page === 'characters' && <RecordGrid rows={characters.filter(row => !query || `${row.name} ${row.alias} ${row.description}`.toLowerCase().includes(query.toLowerCase()))} type="character" onOpen={setSheetCharacter} onEdit={row => open('character', row)} onDelete={row => remove('character', row)} onFavorite={row => addFavorite('character', row)}/>}
      {kindFor[page] && <RecordGrid rows={rowsForPage} type="entry" onEdit={row => open('entry', row)} onDelete={row => remove('entry', row)} onFavorite={row => addFavorite('entry', row)}/>}
      {activeCustomType && <RecordGrid rows={dynamicTypeItems} type="entry" onEdit={row => row.source_table ? open('entry', { ...row, id: row.source_id, kind: activeCustomType.slug }) : setError('Este registro unificado todavía no tiene una ruta de edición compatible.')} onDelete={row => row.source_table ? remove(row.source_table === 'characters' ? 'character' : 'entry', { ...row, id: row.source_id }) : setError('Este registro unificado todavía no tiene una ruta de eliminación compatible.')} onFavorite={row => row.source_table ? addFavorite(row.source_table === 'characters' ? 'character' : 'entry', { ...row, id: row.source_id }) : setError('Este registro todavía no está disponible para favoritos heredados.')}/>}
      {page === 'collections' && <GroupManager ready={phase2Ready} message={phase2Message} groups={groups} items={phase2Items} groupItems={groupItems} universes={universes} activeUniverseId={universeId} apiV2={apiV2} onChanged={load} onError={setError}/>}
      {page === 'content-types' && <ContentTypeManager ready={phase2Ready} types={contentTypes} apiV2={apiV2} api={api} onChanged={load} onError={setError}/>}
      {page === 'favorites' && <FavoritesPanel rows={favorites} onOpen={row => { if (row.entity_type === 'universe') { setUniverseId(String(row.entity_id)); setPage('library'); } else setPage(({ character: 'characters', location: 'locations', group: 'groups', event: 'events', story: 'stories', species: 'species', magic: 'magic', artifact: 'artifacts', gallery: 'gallery', note: 'notes' })[row.entity_type] || 'library'); }}/ >}
      {page === 'relationships' && <RelationshipNetworkPanel rows={relationships} characters={characters} api={api} onChanged={load} onError={setError} onOpen={setSheetCharacter}/>}
      {page === 'settings' && selectedUniverse && theme && <form className="panel theme-settings" onSubmit={saveTheme}><div className="eyebrow">UNIVERSE-LOCAL APPEARANCE</div><h2>{selectedUniverse.name}</h2><label>Visual prompt<textarea rows="3" value={theme.prompt || ''} onChange={e => setTheme({ ...theme, prompt: e.target.value })}/></label><div className="theme-colors">{[['page_bg','Page'],['panel_bg','Panel'],['ink','Text'],['accent','Accent'],['sidebar_bg','Sidebar']].map(([key,label]) => <label key={key}>{label}<input type="color" value={theme[key]} onChange={e => setTheme({ ...theme, [key]: e.target.value })}/></label>)}</div><button className="primary">Save this universe theme</button></form>}
      {page === 'settings' && !selectedUniverse && <section className="panel"><h2>Select a universe</h2><p>Appearance settings stay separate for each universe.</p></section>}
      {page === 'settings' && <AccountSettings user={user} onUser={setUser} onLogout={logout} onError={setError}/>}
    </div></main>
     {modal && <Editor modal={modal} draft={draft} setDraft={setDraft} editing={editing} universes={universes} nodes={nodes} locationEntries={locationEntries} universeId={universeId} contentType={contentTypes.find(type => type.slug === (editing?.kind || activeCustomType?.slug))} onClose={() => setModal('')} onSave={save} onError={setError} error={error}/>}
     {sheetCharacter && <CharacterSheet character={sheetCharacter} api={api} onClose={()=>setSheetCharacter(null)} onError={setError} onEdit={row=>{setSheetCharacter(null);open('character',row);}} onOpenRelated={row=>{if(row.entity_type==='character')setSheetCharacter(row);else{const {entity_type,...entry}=row;open('entry',entry);}}}/>}
  </div>;
}

function NodeTree({ nodes, parentId, selectedId, onSelect, onEdit, onDelete }) {
  return <ul className="node-tree">{nodes.filter(n => (n.parent_id == null ? null : Number(n.parent_id)) === parentId).map(node => <li key={node.id}><div className={Number(selectedId) === Number(node.id) ? 'node-row selected' : 'node-row'}><button className="node-name" onClick={() => onSelect(String(node.id))}>{node.name}</button><button title="Edit" onClick={() => onEdit(node)}><Pencil size={12}/></button><button title="Delete" onClick={() => onDelete(node)}><Trash2 size={12}/></button></div><NodeTree nodes={nodes} parentId={Number(node.id)} selectedId={selectedId} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete}/></li>)}</ul>;
}
function UniverseList({ rows, onOpen, onEdit, onDelete, onFavorite }) {
  if (!rows.length) return <Empty title="Todavia no hay universos" text="Crea un universo antes de clasificar contenido." />;
  return <div className="cards">{rows.map((row, i) => <article className="card" key={row.id}><div className={`card-art art-${i % 5}`}><span>{row.name[0]}</span></div><div className="card-copy"><div className="card-meta">{row.genre || 'UNIVERSO'}<span><button title="Favorito" onClick={() => onFavorite(row)}><Heart size={14}/></button><button onClick={() => onEdit(row)}><Pencil size={14}/></button><button onClick={() => onDelete(row)}><Trash2 size={14}/></button></span></div><h3>{row.name}</h3><p>{row.description || row.lore || 'Un mundo independiente.'}</p><button className="primary" onClick={() => onOpen(row)}>Abrir universo</button></div></article>)}</div>;
}
function RecordGrid({ rows, type, onEdit, onDelete, onFavorite, onOpen }) {
  if (!rows.length) return <Empty title="Todavia no hay elementos" text="Los nuevos registros se guardaran en el alcance seleccionado." />;
  return <div className="cards">{rows.map((row, i) => <article className="card" key={row.id}>{row.kind === 'gallery' && row.data?.image_url ? <img className="gallery-image" src={row.data.image_url} alt={row.data.alt_text || row.name}/> : <div className={`card-art art-${i % 5}`}><span>{row.name[0]}</span></div>}<div className="card-copy"><div className="card-meta">{type === 'character' ? row.universe_name || row.scope_kind : row.kind || row.scope_kind}<span><button title="Favorito" onClick={() => onFavorite(row)}><Heart size={14}/></button><button onClick={() => onEdit(row)}><Pencil size={14}/></button><button onClick={() => onDelete(row)}><Trash2 size={14}/></button></span></div><h3>{row.name}</h3><p>{row.description || row.biography || 'Sin descripcion.'}</p><div className="tags">{(Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',')).filter(Boolean).slice(0, 4).map((tag, i) => <span key={i}>{tag.trim()}</span>)}</div>{type==='character'&&onOpen&&<button className="secondary sheet-open-button" onClick={()=>onOpen(row)}>Abrir ficha</button>}</div></article>)}</div>;
}
function ContentList({ rows, universes, pending, onEdit, onDelete, onFavorite }) {
  const empty = libraryEmptyState(rows, pending ? 'pending' : 'library');
  if (empty) return <Empty title={empty.title} text={empty.text}/>;
  return <div className="content-list">{rows.map(row => <article key={`${row.entity_type}-${row.entity_id}`}><div><span className="eyebrow">{row.type_label || row.type_key || row.entity_type} / {row.scope_kind}</span><h3>{row.name}</h3><p>{row.description || 'Sin descripcion.'}</p><small>{universes.find(universe => Number(universe.id) === Number(row.universe_id))?.name || (row.scope_kind === 'pending' ? 'Pendiente de organizar' : row.scope_kind === 'global' ? 'Biblioteca global' : 'Universo')}</small></div><div><button className="icon-btn" title="Favorito" onClick={() => onFavorite(row)}><Heart size={15}/></button>{row.entity_type !== 'universe' && <><button className="secondary" onClick={() => onEdit(row)}>Clasificar / editar</button><button className="icon-btn" onClick={() => onDelete(row)}><Trash2 size={15}/></button></>}</div></article>)}</div>;
}
function LibraryFilters({ items, types, groups, ready, type, setType, scope, setScope, grouped, setGrouped, group, setGroup, tag, setTag, fields, setFields }) {
  const typeMap = new Map(types.filter(item => item.is_active !== false).map(item => [item.slug, item]));
  for (const key of new Set(items.map(item => item.type_key).filter(Boolean))) if (!typeMap.has(key)) typeMap.set(key, { slug: key, label: key, field_schema: [] });
  const typeOptions = [...typeMap.values()];
  const selectedType = typeOptions.find(item => item.slug === type);
  return <section className="phase2-filters" aria-label="Filtros de biblioteca">
    <label>Tipo<select value={type} onChange={event => { setType(event.target.value); setFields({}); }}><option value="all">Todos</option>{typeOptions.map(item => <option key={item.id} value={item.slug}>{item.label}</option>)}</select></label>
    <label>Scope<select value={scope} onChange={event => setScope(event.target.value)}><option value="all">Universos y global</option><option value="universe">Universos</option><option value="global">Global</option><option value="pending">Pendientes (sección aparte)</option></select></label>
    <label>Estado<select value={grouped} disabled={!ready} onChange={event => setGrouped(event.target.value)}><option value="all">Agrupados y sin agrupar</option><option value="grouped">Agrupados</option><option value="ungrouped">Sin agrupar</option></select></label>
    <label>Grupo<select value={group} disabled={!ready} onChange={event => setGroup(event.target.value)}><option value="all">Todos los grupos</option>{groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Etiqueta<input value={tag} onChange={event => setTag(event.target.value)} placeholder="Filtrar tags"/></label>
    {selectedType?.field_schema?.map(field => <label key={field.key}>{field.label}<input value={fields[field.key] ?? ''} onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))} placeholder="Valor del campo"/></label>)}
  </section>;
}
function ScopeFields({ draft, setDraft, universes }) {
  const [nodes, setNodes] = useState([]);
  useEffect(() => { if (draft.scope_kind !== 'universe' || !draft.universe_id) { setNodes([]); return; } api(`/universes/${draft.universe_id}/nodes`).then(setNodes).catch(() => setNodes([])); }, [draft.scope_kind, draft.universe_id]);
  function setScope(scope_kind) { setDraft({ ...draft, scope_kind, universe_id: scope_kind === 'universe' ? draft.universe_id || '' : '', universe_node_id: '' }); }
  return <><label>Clasificacion<select value={draft.scope_kind || 'pending'} onChange={e => setScope(e.target.value)}><option value="universe">Universo</option><option value="pending">Pendiente de organizar</option><option value="global">Biblioteca global</option></select></label>{draft.scope_kind === 'universe' && <><label>Universo<select required value={draft.universe_id || ''} onChange={e => setDraft({ ...draft, universe_id: e.target.value, universe_node_id: '' })}><option value="">Elegir universo</option>{universes.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label>Nivel jerarquico<select value={draft.universe_node_id || ''} onChange={e => setDraft({ ...draft, universe_node_id: e.target.value })}><option value="">Raiz del universo</option>{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label></>}</>;
}
function Editor({ modal, draft, setDraft, editing, universes, nodes, locationEntries, universeId, contentType, onClose, onSave, onError, error }) {
  const [themeIgnored] = useState(false);
  return <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}><form className="modal" onSubmit={onSave}><header><div className="eyebrow">{editing ? 'EDIT RECORD' : 'NEW RECORD'}</div><h2>{modal === 'universe' ? 'Universe' : modal === 'node' ? 'Hierarchy level' : modal === 'character' ? 'Character' : contentType?.label || 'Worldbuilding item'}</h2><button type="button" className="icon-btn" onClick={() => onClose()}><X size={17}/></button></header><div className="form-scroll">{modal === 'universe' ? <UniverseForm draft={draft} setDraft={setDraft}/> : modal === 'node' ? <NodeForm draft={draft} setDraft={setDraft} nodes={nodes} editingId={editing?.id}/> : modal === 'character' ? <CharacterForm draft={draft} setDraft={setDraft} universes={universes} locationEntries={locationEntries}/> : <EntryForm draft={draft} setDraft={setDraft} universes={universes} contentType={contentType} editing={editing} api={api} onError={onError}/>}{error && <div className="error">{error}</div>}</div><footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Save</button></footer></form></div>;
}
function UniverseForm({ draft, setDraft }) {
  return <div className="form-grid"><label>Name<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>Genre<input value={draft.genre} onChange={e => setDraft({ ...draft, genre: e.target.value })}/></label><label>Tone<input value={draft.tone} onChange={e => setDraft({ ...draft, tone: e.target.value })}/></label><label>Accent color<input type="color" value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value })}/></label><label className="wide">Description<textarea rows="3" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label className="wide">Lore<textarea rows="3" value={draft.lore} onChange={e => setDraft({ ...draft, lore: e.target.value })}/></label></div>;
}
function CharacterForm({ draft, setDraft, universes, locationEntries }) {
  const fields = [['name','Name'],['alias','Alias'],['pronouns','Pronouns'],['gender','Gender'],['species','Species'],['origin','Origin'],['residence','Residence'],['occupation','Occupation'],['status','Status'],['powers','Powers']];
  const links = normalizeLocationLinks(draft.details?.location_links);
  const options = compatibleLocationOptions(locationEntries, draft);
  const setLinks = next => setDraft({ ...draft, details: updateLocationLinks(draft.details, next) });
  const selectPlace = (label, key) => <label>{label}<select value={links[key] || ''} onChange={event => setLinks({ ...links, [key]: event.target.value || null })}><option value="">Sin asignar</option>{options.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label>;
  const placeChecks = (label, key) => <fieldset className="wide location-checks"><legend>{label}</legend>{options.map(place => <label key={place.id}><input type="checkbox" checked={links[key].includes(Number(place.id))} onChange={event => setLinks({ ...links, [key]: event.target.checked ? [...links[key], Number(place.id)] : links[key].filter(id => id !== Number(place.id)) })}/>{place.name}</label>)}{!options.length && <small>Creá fichas de tipo Lugar dentro de un ámbito compatible.</small>}</fieldset>;
  return <div className="form-grid"><ScopeFields draft={draft} setDraft={setDraft} universes={universes}/>{fields.map(([key,label]) => <label key={key}>{label}<input required={key === 'name'} value={draft[key] || ''} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/></label>)}<section className="wide location-section"><h3>Vínculos con lugares</h3><p>Las referencias reutilizan fichas existentes y no duplican lugares.</p><div className="form-grid">{selectPlace('Lugar de nacimiento','birthplace_id')}<label>Origen familiar o cultural<input value={links.family_cultural_origin} onChange={e => setLinks({ ...links, family_cultural_origin: e.target.value })}/></label><label>Nacionalidad<input value={links.nationality} onChange={e => setLinks({ ...links, nationality: e.target.value })}/></label>{selectPlace('Residencia actual','current_residence_id')}</div>{placeChecks('Residencias anteriores','former_residence_ids')}{placeChecks('Lugares visitados','visited_place_ids')}</section><label className="wide">Tags<input value={draft.tags || ''} onChange={e => setDraft({ ...draft, tags: e.target.value })}/></label><label className="wide">Description<textarea rows="3" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label className="wide">Biography<textarea rows="4" value={draft.biography} onChange={e => setDraft({ ...draft, biography: e.target.value })}/></label></div>;
}
function EntryForm({ draft, setDraft, universes, contentType, editing, api, onError }) {
  const setData = (key, value) => setDraft({ ...draft, data: { ...draft.data, [key]: value } });
  const customFields = contentType?.field_schema || [];
  const domainFields = draft.kind === 'group' ? [['parent_id','Subgrupo de','parent'],['group_type','Tipo de organización / familia','select','Organización, Familia, Facción, Sociedad, Clan, Institución, Empresa, Grupo político, Ejército, Personalizado'],['history','Historia','textarea'],['symbol_url','Emblema o símbolo (URL)','url'],['founded_at','Fecha de creación','text'],['dissolved_at','Fecha de disolución','text'],['location_summary','Ubicación principal','text'],['internal_structure','Estructura interna','textarea']] : draft.kind === 'species' ? [['physical_traits','Características físicas','textarea'],['biology','Características biológicas','textarea'],['natural_abilities','Habilidades naturales','textarea'],['life_expectancy','Expectativa de vida','text'],['reproduction','Reproducción','textarea'],['habitat','Hábitat','textarea'],['culture','Cultura y costumbres','textarea'],['origin','Origen','textarea'],['variants','Variantes y subespecies','textarea'],['reference_image','Imagen o referencia (URL)','url']] : draft.kind === 'magic' ? [['system_name','Nombre del sistema','text'],['origin','Origen','textarea'],['functioning','Funcionamiento','textarea'],['rules','Reglas','textarea'],['limitations','Limitaciones','textarea'],['costs','Costos o consecuencias','textarea'],['resources','Energías o recursos','textarea'],['categories','Categorías y subcategorías','textarea'],['learning','Aprendizaje o adquisición','textarea'],['exceptions','Excepciones','textarea'],['references','Imágenes o referencias (URL)','url']] : [];
  const fieldView = ([key,label,type,options]) => type==='parent' ? <div key={key} className="wide"><EntryParentPicker draft={draft} setDraft={setDraft} api={api} onError={onError}/></div> : <label className={type==='textarea'?'wide':''} key={key}>{label}{type==='textarea'?<textarea rows="3" value={draft.data?.[key]||''} onChange={event=>setData(key,event.target.value)}/>:type==='select'?<select value={draft.data?.[key]||''} onChange={event=>setData(key,event.target.value)}><option value="">Elegir un tipo</option>{options.split(', ').map(item=><option key={item}>{item}</option>)}</select>:<input type={type==='url'?'url':'text'} value={draft.data?.[key]||''} onChange={event=>setData(key,event.target.value)}/>}</label>;
  return <div className="form-grid"><ScopeFields draft={draft} setDraft={setDraft} universes={universes}/><label>Name<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label className="wide">Description<textarea rows="4" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label>{domainFields.map(fieldView)}{customFields.map(field => { const model = dynamicFieldModel(field, draft.data); const update = event => setData(field.key, dynamicFieldValue(field, field.type === 'checkbox' ? event.target.checked : event.target.value)); return <label className={field.type === 'textarea' ? 'wide' : ''} key={field.key}>{field.label}{field.type === 'textarea' ? <textarea required={model.required} rows="4" value={model.value} onChange={update}/> : field.type === 'select' ? <select required={model.required} value={model.value} onChange={update}><option value="">Elegir</option>{model.options.map(option => <option key={option}>{option}</option>)}</select> : field.type === 'checkbox' ? <input type="checkbox" checked={model.value} onChange={update}/> : <input required={model.required} type={model.inputType} value={model.value} onChange={update}/>}</label>; })}{!customFields.length&&draft.kind==='story'&&<label className="wide">Story text<textarea rows="8" value={draft.data?.content||''} onChange={e=>setData('content',e.target.value)}/></label>}{!customFields.length&&draft.kind==='event'&&<label>Event date<input type="text" value={draft.data?.date||''} onChange={e=>setData('date',e.target.value)}/></label>}{!customFields.length&&draft.kind==='gallery'&&<><label className="wide">Image URL<input type="url" value={draft.data?.image_url||''} onChange={e=>setData('image_url',e.target.value)}/></label><label className="wide">Alt text<input value={draft.data?.alt_text||''} onChange={e=>setData('alt_text',e.target.value)}/></label></>}{draft.kind==='group'&&<label className="wide">Miembros y cargos<p>Agregá participantes y asigná rol, período y estado después de guardar la ficha.</p></label>}{editing?.id&&<div className="wide"><EntryLinkEditor entry={draft} api={api} onError={setError}/></div>}<label className="wide">Tags<input value={draft.tags||''} onChange={e=>setDraft({...draft,tags:e.target.value})}/></label></div>;
}

function EntryParentPicker({draft,setDraft,api,onError}){
  const [groups,setGroups]=useState([]);
  useEffect(()=>{let live=true;api('/entries?scope=all&kind=group').then(rows=>{if(live)setGroups(rows);}).catch(error=>onError(error.message));return()=>{live=false};},[draft.scope_kind,draft.universe_id]);
  const descendants=new Set();if(draft.id){let changed=true;while(changed){changed=false;for(const row of groups)if(Number(row.parent_id)===Number(draft.id)||descendants.has(Number(row.parent_id))){if(!descendants.has(Number(row.id))){descendants.add(Number(row.id));changed=true;}}}}
  const options=groups.filter(row=>Number(row.id)!==Number(draft.id)&&!descendants.has(Number(row.id))&&row.scope_kind===draft.scope_kind&&Number(row.universe_id||0)===Number(draft.universe_id||0));
  return <label>Grupo u organización superior<select value={draft.parent_id||''} onChange={event=>setDraft({...draft,parent_id:event.target.value?Number(event.target.value):null})}><option value="">Nivel raíz</option>{options.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>;
}

function EntryLinkEditor({entry,api,onError}){
  const [links,setLinks]=useState([]),[targets,setTargets]=useState([]),[target,setTarget]=useState(''),[relation,setRelation]=useState(entry.kind==='group'?'Miembro':'Relacionado con'),[description,setDescription]=useState(''),[role,setRole]=useState(''),[start,setStart]=useState(''),[end,setEnd]=useState(''),[status,setStatus]=useState('Activo'),[editing,setEditing]=useState(null);
  useEffect(()=>{let live=true;Promise.all([api(`/entries/${entry.id}/links`),api('/entries?scope=all'),api('/characters?scope=all')]).then(([saved,items,people])=>{if(!live)return;setLinks(saved);const compatible=row=>row.scope_kind===entry.scope_kind&&Number(row.universe_id||0)===Number(entry.universe_id||0);setTargets([...items.filter(row=>Number(row.id)!==Number(entry.id)&&compatible(row)).map(row=>({...row,target_type:'entry'})),...people.filter(compatible).map(row=>({...row,target_type:'character'}))]);}).catch(error=>onError(error.message));return()=>{live=false};},[entry.id,entry.scope_kind,entry.universe_id]);
  async function add(){const [type,id]=target.split(':');if(!id)return;try{const item=targets.find(row=>row.target_type===type&&String(row.id)===id);const result=await api(`/entries/${entry.id}/links`,{method:'POST',body:JSON.stringify({target_type:type,target_id:Number(id),relation_type:relation,description,details:{role,start_date:start,end_date:end,status}})});setLinks([...links,{...result,target_entry_name:type==='entry'?item?.name:null,target_character_name:type==='character'?item?.name:null}]);setTarget('');setDescription('');setRole('');}catch(error){onError(error.message);}}
  async function saveEdit(){try{const result=await api(`/entry-links/${editing.id}`,{method:'PUT',body:JSON.stringify({relation_type:editing.relation_type,description:editing.description,details:editing.details})});setLinks(links.map(row=>row.id===result.id?{...row,...result}:row));setEditing(null);}catch(error){onError(error.message);}}
  async function remove(id){try{await api(`/entry-links/${id}`,{method:'DELETE'});setLinks(links.filter(row=>row.id!==id));}catch(error){onError(error.message);}}
  return <section className="entry-relations"><span className="eyebrow">FICHAS CONECTADAS</span><h3>{entry.kind==='group'?'Miembros, líderes y organizaciones relacionadas':'Vínculos con otros elementos'}</h3><div className="entry-link-add"><select required value={target} onChange={event=>setTarget(event.target.value)}><option value="">Elegir una ficha del mismo ámbito</option>{targets.map(row=><option key={`${row.target_type}:${row.id}`} value={`${row.target_type}:${row.id}`}>{row.name} · {row.target_type==='character'?'Personaje':row.kind}</option>)}</select><input value={relation} onChange={event=>setRelation(event.target.value)} placeholder="Tipo de vínculo"/><input value={role} onChange={event=>setRole(event.target.value)} placeholder="Cargo o rol"/><input value={status} onChange={event=>setStatus(event.target.value)} placeholder="Estado"/><input value={start} onChange={event=>setStart(event.target.value)} placeholder="Ingreso / inicio"/><input value={end} onChange={event=>setEnd(event.target.value)} placeholder="Salida / finalización"/><textarea value={description} onChange={event=>setDescription(event.target.value)} placeholder="Descripción del vínculo"/><button type="button" className="secondary" disabled={!target} onClick={add}><Plus size={13}/> Conectar ficha</button></div><div className="entry-relation-list">{links.map(link=><article key={link.id}><div><b>{link.target_character_name||link.target_entry_name||'Ficha relacionada'}</b><span>{link.relation_type}{link.details?.role?` · ${link.details.role}`:''}{link.details?.status?` · ${link.details.status}`:''}</span><small>{link.details?.start_date||''}{link.details?.end_date?` — ${link.details.end_date}`:''}</small><p>{link.description}</p></div><button type="button" onClick={()=>{setEditing({...link});}} title="Editar vínculo"><Pencil size={13}/></button><button type="button" onClick={()=>remove(link.id)} title="Quitar vínculo"><Trash2 size={13}/></button></article>)}</div>{editing&&<div className="entry-link-edit"><h4>Editar relación</h4><input value={editing.relation_type} onChange={event=>setEditing({...editing,relation_type:event.target.value})}/><textarea value={editing.description} onChange={event=>setEditing({...editing,description:event.target.value})}/><input value={editing.details?.role||''} onChange={event=>setEditing({...editing,details:{...editing.details,role:event.target.value}})} placeholder="Cargo o rol"/><input value={editing.details?.status||''} onChange={event=>setEditing({...editing,details:{...editing.details,status:event.target.value}})} placeholder="Estado"/><input value={editing.details?.start_date||''} onChange={event=>setEditing({...editing,details:{...editing.details,start_date:event.target.value}})} placeholder="Inicio"/><input value={editing.details?.end_date||''} onChange={event=>setEditing({...editing,details:{...editing.details,end_date:event.target.value}})} placeholder="Fin"/><button type="button" className="primary" onClick={saveEdit}>Guardar vínculo</button><button type="button" className="secondary" onClick={()=>setEditing(null)}>Cancelar</button></div>}</section>;
}
function NodeForm({ draft, setDraft, nodes, editingId }) {
  return <div className="form-grid"><label>Name<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>Type (custom)<input required value={draft.node_type} onChange={e => setDraft({ ...draft, node_type: e.target.value })}/></label><label>Parent level<select value={draft.parent_id || ''} onChange={e => setDraft({ ...draft, parent_id: e.target.value })}><option value="">Universe root</option>{nodes.filter(n => Number(n.id) !== Number(editingId)).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label><label>Order<input type="number" value={draft.sort_order} onChange={e => setDraft({ ...draft, sort_order: Number(e.target.value) })}/></label><label className="wide">Description<textarea rows="3" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label></div>;
}
function Empty({ title, text }) { return <div className="empty"><span>✧</span><h2>{title}</h2><p>{text}</p></div>; }

function FavoritesPanel({ rows, onOpen }) {
  return rows.length ? <div className="content-list">{rows.map(row => <article key={row.favorite_id}><div><span className="eyebrow">{row.entity_type}</span><h3>{row.name}</h3><p>{row.description}</p></div><button className="secondary" onClick={() => onOpen(row)}>Abrir</button></article>)}</div> : <Empty title="Todavía no hay favoritos" text="Guardá universos, personajes o elementos desde sus fichas."/>;
}

function RelationshipPanel({ rows, characters, onChanged, onError }) {
  const [source, setSource] = useState(''), [target, setTarget] = useState(''), [type, setType] = useState('relación');
  async function add(event) { event.preventDefault(); try { await api('/relationships', { method: 'POST', body: JSON.stringify({ source_character_id: Number(source), target_character_id: Number(target), relation_type: type }) }); await onChanged(); } catch (error) { onError(error.message); } }
  async function remove(id) { try { await api(`/relationships/${id}`, { method: 'DELETE' }); await onChanged(); } catch (error) { onError(error.message); } }
  return <><form className="panel" onSubmit={add}><h2>Vincular personajes del ámbito actual</h2><select required value={source} onChange={e => setSource(e.target.value)}><option value="">Desde…</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><select required value={target} onChange={e => setTarget(e.target.value)}><option value="">Hacia…</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input value={type} onChange={e => setType(e.target.value)} aria-label="Tipo de relación"/><button className="primary">Crear relación</button></form><div className="content-list">{rows.map(row => <article key={row.id}><div><b>{row.source_name}</b> — {row.relation_type} — <b>{row.target_name}</b><p>{row.description}</p></div><button className="secondary" onClick={() => remove(row.id)}>Quitar</button></article>)}</div>{!rows.length && <Empty title="Sin relaciones" text="Las relaciones conectan personajes del mismo universo o ámbito."/>}</>;
}

function AccountSettings({ user, onUser, onLogout, onError }) {
  const [profile, setProfile] = useState({ username: user.username, email: user.email, bio: user.bio || '', avatar_url: user.avatar_url || '' });
  const [password, setPassword] = useState({ current_password: '', new_password: '' });
  const [confirmPassword, setConfirmPassword] = useState('');
  async function updateProfile(event) { event.preventDefault(); try { const result = await api('/auth/profile', { method: 'PUT', body: JSON.stringify(profile) }); onUser(result.user); onError('Perfil actualizado.'); } catch (error) { onError(error.message); } }
  async function updatePassword(event) { event.preventDefault(); try { await api('/auth/password', { method: 'PUT', body: JSON.stringify(password) }); onError('Contraseña cambiada.'); await onLogout(); } catch (error) { onError(error.message); } }
  async function deleteAccount() { if (!window.confirm('Se eliminará permanentemente tu cuenta y sus datos. ¿Continuar?')) return; try { await api('/auth/account', { method: 'DELETE', body: JSON.stringify({ password: confirmPassword }) }); await onLogout(); } catch (error) { onError(error.message); } }
  return <div className="settings-grid"><section className="panel"><h2>Perfil</h2><form className="settings-form" onSubmit={updateProfile}><label>Usuario<input required minLength="3" maxLength="32" value={profile.username} onChange={e => setProfile({ ...profile, username: e.target.value })}/></label><label>Email<input required type="email" value={profile.email} onChange={e => setProfile({ ...profile, email: e.target.value })}/></label><label>Biografía<textarea value={profile.bio} onChange={e => setProfile({ ...profile, bio: e.target.value })}/></label><label>URL del avatar<input type="url" value={profile.avatar_url} onChange={e => setProfile({ ...profile, avatar_url: e.target.value })}/></label><button className="secondary">Guardar perfil</button></form></section><section className="panel"><h2>Seguridad</h2><form className="settings-form" onSubmit={updatePassword}><label>Contraseña actual<input required type="password" value={password.current_password} onChange={e => setPassword({ ...password, current_password: e.target.value })}/></label><label>Nueva contraseña<input required minLength="10" type="password" value={password.new_password} onChange={e => setPassword({ ...password, new_password: e.target.value })}/></label><button className="secondary">Cambiar contraseña</button></form><label>Confirmar contraseña para eliminar cuenta<input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}/></label><button className="danger-button" onClick={deleteAccount}>Eliminar cuenta</button></section></div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);

