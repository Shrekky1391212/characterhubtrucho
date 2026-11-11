import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, Search, Plus, Users, Globe2, Sparkles, Settings, MapPin, Heart, BookOpen, ScrollText, Clock3, Image, Network, FlaskConical, Boxes, LogOut, ChevronRight, Trash2, Pencil, X, Star } from 'lucide-react';
import './app.css';
import './settings.css';
import './extra.css';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const tokenKey = 'oc-archive-session';
async function api(path, options = {}) {
  if (import.meta.env.PROD && !API) throw new Error('Falta configurar VITE_API_URL con la URL del backend en Render.');
  let response;
  try { response = await fetch(`${API}/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(localStorage.getItem(tokenKey) ? { Authorization: `Bearer ${localStorage.getItem(tokenKey)}` } : {}), ...options.headers } }); }
  catch { throw new Error('No se pudo conectar con el servidor. Comprobá la API y VITE_API_URL.'); }
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Error ${response.status}`); }
  return response.status === 204 ? null : response.json();
}
const nav = [
  { id: 'dashboard', label: 'Inicio', icon: Archive },
  { id: 'universes', label: 'Universos', icon: Globe2 },
  { id: 'characters', label: 'Personajes', icon: Users },
  { id: 'locations', label: 'Lugares', icon: MapPin },
  { id: 'relationships', label: 'Relaciones', icon: Network },
  { id: 'groups', label: 'Grupos y facciones', icon: Users },
  { id: 'species', label: 'Especies', icon: FlaskConical },
  { id: 'magic', label: 'Sistemas de magia', icon: Sparkles },
  { id: 'artifacts', label: 'Objetos y artefactos', icon: Boxes },
  { id: 'events', label: 'Cronología', icon: Clock3 },
  { id: 'stories', label: 'Historias', icon: BookOpen },
  { id: 'gallery', label: 'Galería', icon: Image },
  { id: 'notes', label: 'Notas', icon: ScrollText },
  { id: 'favorites', label: 'Favoritos', icon: Star },
  { id: 'settings', label: 'Ajustes', icon: Settings },
];
const kinds = { locations: 'location', groups: 'group', species: 'species', magic: 'magic', artifacts: 'artifact', events: 'event', stories: 'story', gallery: 'gallery', notes: 'note' };
const labels = Object.fromEntries(nav.map(item => [item.id, item.label]));
const emptyUniverse = { name: '', description: '', genre: '', tone: '', color: '#a78c62', icon: '', cover_url: '', lore: '', history: '', tags: [] };
const emptyCharacter = { universe_id: '', name: '', alias: '', pronouns: '', gender: '', species: '', origin: '', residence: '', occupation: '', status: '', powers: '', tags: '', description: '', biography: '', details: {} };
const emptyEntry = { name: '', description: '', universe_id: '', tags: '', data: {} };

function Auth({ onLogin }) {
  const [mode, setMode] = useState('login'), [form, setForm] = useState({ identifier: '', username: '', email: '', password: '' }), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(mode === 'login' ? { identifier: form.identifier, password: form.password } : { username: form.username, email: form.email, password: form.password }) });
      localStorage.setItem(tokenKey, result.token); onLogin(result.user);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <main className="auth"><div className="auth-card"><div className="seal"><Archive/></div><div className="eyebrow">UN ARCHIVO PARA TUS MUNDOS</div><h1>OC Archive</h1><p>Un lugar privado para todo lo que imaginás.</p><div className="auth-tabs"><button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Ingresar</button><button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>Crear cuenta</button></div><form onSubmit={submit}>{mode === 'register' ? <><label>Nombre de usuario<input required minLength="3" maxLength="32" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}/></label><label>Email<input required type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}/></label></> : <label>Usuario o email<input required value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })}/></label>}<label>Contraseña<input required type="password" minLength={mode === 'register' ? 10 : 1} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}/>{mode === 'register' && <small>Al menos 10 caracteres.</small>}</label>{error && <div className="error">{error}</div>}<button className="primary full" disabled={busy}>{busy ? 'Conectando…' : mode === 'login' ? 'Entrar al archivo' : 'Crear mi archivo'}</button></form><small className="private-note">Tus fichas se guardan en tu cuenta privada.</small></div></main>;
}

function App() {
  const [user, setUser] = useState(null), [authCheck, setAuthCheck] = useState(true), [page, setPage] = useState('dashboard');
  const [universes, setUniverses] = useState([]), [characters, setCharacters] = useState([]), [entries, setEntries] = useState([]), [dashboard, setDashboard] = useState(null);
  const [query, setQuery] = useState(''), [searchResults, setSearchResults] = useState(null), [modal, setModal] = useState(null), [draft, setDraft] = useState(null), [editing, setEditing] = useState(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [theme, setTheme] = useState(null), [prompt, setPrompt] = useState('');
  const currentLabel = labels[page] || page;
  async function load() {
    setLoading(true); setError('');
    try {
      const [u, c, d] = await Promise.all([api('/universes'), api('/characters'), api('/dashboard')]);
      setUniverses(u); setCharacters(c); setDashboard(d);
      if (kinds[page]) setEntries(await api(`/entries?kind=${kinds[page]}`));
      else if (page === 'stories') setEntries(await api('/entries?kind=story'));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => {
    if (!localStorage.getItem(tokenKey)) { setAuthCheck(false); return; }
    api('/auth/me').then(({ user: current }) => setUser(current)).catch(() => localStorage.removeItem(tokenKey)).finally(() => setAuthCheck(false));
  }, []);
  useEffect(() => { if (user) load(); }, [user, page]);
  useEffect(() => {
    if (!user) return;
    api('/appearance?scope_type=application&scope_id=global')
      .then(value => { setPrompt(value.prompt || ''); if (value.tokens && Object.keys(value.tokens).length) setTheme(value.tokens); })
      .catch(err => setError(err.message));
  }, [user]);
  useEffect(() => { if (theme) Object.entries(theme).forEach(([key, value]) => document.documentElement.style.setProperty(`--${key.replaceAll('_', '-')}`, value)); }, [theme]);
  useEffect(() => { if (!user || query.trim().length < 2) { setSearchResults(null); return; } const timer = setTimeout(() => api(`/search?q=${encodeURIComponent(query)}`).then(setSearchResults).catch(err => setError(err.message)), 240); return () => clearTimeout(timer); }, [query, user]);
  const species = useMemo(() => [...new Set(characters.map(c => c.species).filter(Boolean))], [characters]);
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch {} localStorage.removeItem(tokenKey); setUser(null); setPage('dashboard'); }
  function open(kind, row = null) {
    setError(''); setEditing(row); setModal(kind);
    setDraft(kind === 'universe' ? { ...emptyUniverse, ...(row || {}) } : kind === 'character' ? { ...emptyCharacter, ...(row || {}), universe_id: row?.universe_id || '' } : { ...emptyEntry, ...(row || {}), universe_id: row?.universe_id || '', tags: (row?.tags || []).join?.(', ') || row?.tags || '' });
  }
  async function save(e) {
    e.preventDefault(); setError('');
    try {
      if (modal === 'universe') {
        const body = { ...draft, tags: typeof draft.tags === 'string' ? draft.tags.split(',').map(x => x.trim()).filter(Boolean) : draft.tags };
        await api(`/universes${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      } else if (modal === 'character') {
        const body = { ...draft, universe_id: draft.universe_id ? Number(draft.universe_id) : null };
        await api(`/characters${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      } else {
        const body = { kind: kinds[page], ...draft, universe_id: draft.universe_id ? Number(draft.universe_id) : null, tags: String(draft.tags || '').split(',').map(x => x.trim()).filter(Boolean) };
        await api(`/entries${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      }
      setModal(null); await load();
    } catch (err) { setError(err.message); }
  }
  async function remove(type, row) {
    if (!window.confirm(`¿Eliminar “${row.name}”?`)) return;
    try { await api(type === 'universe' ? `/universes/${row.id}` : type === 'character' ? `/characters/${row.id}` : `/entries/${row.id}`, { method: 'DELETE' }); await load(); }
    catch (err) { setError(err.message); }
  }
  async function favorite(type, row) {
    try { await api('/favorites', { method: 'POST', body: JSON.stringify({ entity_type: type, entity_id: row.id }) }); }
    catch (err) { setError(err.message); }
  }
  function setThemeFromPrompt() {
    const p = prompt.toLowerCase();
    const presets = [
      { words: ['gótico', 'gothic', 'dark academia', 'oscuro'], tokens: { page_bg: '#191917', panel_bg: '#24231f', ink: '#ede8dc', muted: '#aaa395', line: '#403d35', accent: '#b69a68', sidebar_bg: '#11110f' } },
      { words: ['bosque', 'herbario', 'forest', 'verde'], tokens: { page_bg: '#e9eee5', panel_bg: '#f7f8f2', ink: '#263329', muted: '#778575', line: '#d0d9cd', accent: '#627e63', sidebar_bg: '#25352c' } },
      { words: ['cielo', 'cosmos', 'noche', 'lunar'], tokens: { page_bg: '#171a24', panel_bg: '#222635', ink: '#eceaf4', muted: '#a6a5bb', line: '#37394b', accent: '#ad91e2', sidebar_bg: '#11131b' } },
      { words: ['papel', 'antiguo', 'vintage', 'biblioteca'], tokens: { page_bg: '#f1eadd', panel_bg: '#fffaf0', ink: '#342d24', muted: '#81766a', line: '#dfd4c3', accent: '#a36f48', sidebar_bg: '#342d29' } },
    ];
    const preset = presets.find(item => item.words.some(word => p.includes(word))) || presets[3];
    setTheme({ ...preset.tokens, heading_font: 'serif', texture: p.includes('cuad') ? 'grid' : 'grain', corner: 'soft' });
  }
  async function saveTheme() {
    try { const body = { scope_type: 'application', scope_id: 'global', prompt, tokens: theme || {} }; await api('/appearance', { method: 'PUT', body: JSON.stringify(body) }); setError('Apariencia guardada.'); }
    catch (err) { setError(err.message); }
  }
  if (authCheck) return <div className="boot">Abriendo el archivo…</div>;
  if (!user) return <Auth onLogin={setUser}/>;
  const isUniversal = page === 'universes', isCharacters = page === 'characters', isDashboard = page === 'dashboard';
  const isGeneric = Boolean(kinds[page]);
  const rows = page === 'stories' || page === 'events' || page === 'locations' || page === 'groups' || page === 'species' || page === 'magic' || page === 'artifacts' || page === 'gallery' || page === 'notes' ? entries : [];
  const heading = isDashboard ? 'Tu archivo, en una mirada' : page === 'favorites' ? 'Tus elementos guardados' : page === 'settings' ? 'Preferencias del archivo' : currentLabel;
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-seal"><Archive size={18}/></span><span><b>OC ARCHIVE</b><small>EL ATLAS PERSONAL</small></span></div><div className="side-caption">BIBLIOTECA</div><nav>{nav.map(item => <button key={item.id} className={page === item.id ? 'nav active' : 'nav'} onClick={() => { setPage(item.id); setQuery(''); setSearchResults(null); }}><item.icon size={16}/><span>{item.label}</span>{page === item.id && <ChevronRight size={14}/>}</button>)}</nav><div className="side-foot"><div className="profile-mark">{user.username.slice(0, 1).toUpperCase()}</div><div className="profile-name"><b>{user.username}</b><small>Archivo privado</small></div><button className="icon-btn" title="Cerrar sesión" onClick={logout}><LogOut size={16}/></button></div></aside>
    <main className="main"><header className="topbar"><span>ARCHIVO <ChevronRight size={13}/> <b>{currentLabel}</b></span><div className="top-search"><Search size={16}/><input placeholder="Buscar en tu archivo…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button onClick={() => setQuery('')}><X size={14}/></button>}</div><button className="avatar" onClick={() => setPage('settings')}>{user.username.slice(0, 1).toUpperCase()}</button></header><div className="content"><section className="heading"><div><div className="eyebrow">CUADERNO DE CAMPO <span>✳</span></div><h1>{heading}</h1><p>{isDashboard ? 'Ideas, personajes y mundos que toman forma.' : `Todo lo que reuniste en ${currentLabel.toLowerCase()}.`}</p></div>{(isUniversal || isCharacters || isGeneric) && <button className="primary" onClick={() => open(isUniversal ? 'universe' : isCharacters ? 'character' : 'entry')}><Plus size={16}/> Nuevo registro</button>}</section>
      {error && <div className="notice">{error}<button onClick={() => setError('')}><X size={15}/></button></div>}
      {query && searchResults && <section className="search-results"><h2>Resultados de búsqueda <small>{searchResults.length}</small></h2>{searchResults.map((row, i) => <article key={`${row.entity_type}-${row.id}-${i}`}><span>{row.entity_type}</span><b>{row.name}</b><p>{row.description}</p></article>)}</section>}
      {isDashboard && dashboard && <><section className="stats"><div><Globe2/><b>{dashboard.counts.universes}</b><small>Universos</small></div><div><Users/><b>{dashboard.counts.characters}</b><small>Personajes</small></div><div><BookOpen/><b>{dashboard.counts.entries}</b><small>Registros de mundo</small></div><div><Heart/><b>{species.length}</b><small>Especies nombradas</small></div></section><section className="panel"><div className="panel-head"><div><div className="eyebrow">ACTIVIDAD RECIENTE</div><h2>Volvé a donde estabas</h2></div><button className="text-btn" onClick={() => setPage('characters')}>Ver personajes <ChevronRight size={14}/></button></div>{dashboard.recent.length ? <div className="recent">{dashboard.recent.map(row => <button key={row.id} onClick={() => setPage(kinds[row.kind] ? Object.keys(kinds).find(k => kinds[k] === row.kind) : 'stories')}><span className="recent-icon"><ScrollText size={17}/></span><span><b>{row.name}</b><small>{row.kind} · {new Date(row.updated_at).toLocaleDateString()}</small></span><ChevronRight size={15}/></button>)}</div> : <Empty title="El archivo está en blanco" text="Creá universos y fichas para comenzar a construir tu atlas."/>}</section></>}
      {isUniversal && <CardGrid rows={universes} type="universe" onEdit={row => open('universe', row)} onDelete={row => remove('universe', row)} onFavorite={row => favorite('universe', row)} onOpen={row => { setPage('characters'); }}/>}
      {isCharacters && <><div className="filters"><select id="speciesFilter"><option value="">Todas las especies</option>{species.map(item => <option key={item}>{item}</option>)}</select><span>{characters.length} fichas</span></div><CardGrid rows={characters.filter(row => !query || `${row.name} ${row.alias} ${row.description}`.toLowerCase().includes(query.toLowerCase()))} type="character" onEdit={row => open('character', row)} onDelete={row => remove('character', row)} onFavorite={row => favorite('character', row)}/></>}
      {isGeneric && <>{page === 'events' ? <div className="timeline">{rows.slice().sort((a,b) => String(a.data?.date || '').localeCompare(String(b.data?.date || ''))).map(row => <article key={row.id}><time>{row.data?.date || 'Fecha sin definir'}</time><div><h3>{row.name}</h3><p>{row.description}</p><button className="text-btn" onClick={() => open('entry', row)}><Pencil size={13}/> Editar evento</button></div></article>)}</div> : <CardGrid rows={rows} type="entry" onEdit={row => open('entry', row)} onDelete={row => remove('entry', row)} onFavorite={row => favorite('entry', row)}/>}</>}
      {page === 'relationships' && <Relationships characters={characters} onError={setError}/>}
      {page === 'favorites' && <Favorites onError={setError} onJump={id => setPage(id)}/>}
      {page === 'settings' && <SettingsPage user={user} onUser={setUser} onLogout={logout} prompt={prompt} setPrompt={setPrompt} apply={setThemeFromPrompt} saveTheme={saveTheme} theme={theme} onError={setError}/>}
      {loading && <div className="loading">Consultando tu archivo…</div>}
      {!loading && ((isUniversal && !universes.length) || (isCharacters && !characters.length) || (isGeneric && !rows.length)) && <Empty title="Todavía no hay registros" text={`Agregá el primer elemento a ${currentLabel.toLowerCase()}.`}/>}
    </div></main>
    {modal && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setModal(null)}><form className="modal" onSubmit={save}><header><div className="eyebrow">{editing ? 'EDITAR FICHA' : 'NUEVO REGISTRO'}</div><h2>{editing ? 'Editar' : 'Crear'} {modal === 'universe' ? 'universo' : modal === 'character' ? 'personaje' : labels[page]?.toLowerCase()}</h2><button type="button" className="icon-btn" onClick={() => setModal(null)}><X/></button></header><div className="form-scroll">{modal === 'universe' ? <UniverseForm draft={draft} setDraft={setDraft}/> : modal === 'character' ? <CharacterForm draft={draft} setDraft={setDraft} universes={universes}/> : <EntryForm draft={draft} setDraft={setDraft} universes={universes} page={page}/ >}{error && <div className="error">{error}</div>}</div><footer><button type="button" className="secondary" onClick={() => setModal(null)}>Cancelar</button><button className="primary">Guardar ficha</button></footer></form></div>}
  </div>;
}

function Empty({ title, text }) { return <div className="empty"><span>✧</span><h2>{title}</h2><p>{text}</p></div>; }
function CardGrid({ rows, type, onEdit, onDelete, onFavorite, onOpen }) {
  if (!rows.length) return <Empty title="Sin fichas para mostrar" text="Tu próximo personaje o idea empieza acá." />;
  return <div className="cards">{rows.map((row, i) => <article className="card" key={row.id}><div className={`card-art art-${i % 5}`} onClick={() => onOpen?.(row)}>{row.data?.image_url ? <img src={row.data.image_url} alt={row.name}/> : <span>{(row.icon || row.name || '?').slice(0, 1).toUpperCase()}</span>}<button title="Guardar en favoritos" onClick={e => { e.stopPropagation(); onFavorite(row); }}><Heart size={15}/></button></div><div className="card-copy"><div className="card-meta">{type === 'character' ? row.universe_name || 'SIN UNIVERSO' : type === 'universe' ? row.genre || 'MUNDO' : row.kind || 'ARCHIVO'}<span><button onClick={() => onEdit(row)} title="Editar"><Pencil size={14}/></button><button onClick={() => onDelete(row)} title="Eliminar"><Trash2 size={14}/></button></span></div><h3>{row.name}</h3>{row.alias && <em>“{row.alias}”</em>}<p>{row.description || row.lore || 'Sin descripción.'}</p><div className="tags">{(Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',')).slice(0, 4).map((tag, i) => tag && <span key={i}>{tag}</span>)}</div></div></article>)}</div>;
}
function UniverseForm({ draft, setDraft }) { return <div className="form-grid"><label>Nombre<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>Género<input value={draft.genre} onChange={e => setDraft({ ...draft, genre: e.target.value })}/></label><label>Tono<input value={draft.tone} onChange={e => setDraft({ ...draft, tone: e.target.value })}/></label><label>Color<input type="color" value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value })}/></label><label className="wide">Descripción<textarea rows="3" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label className="wide">Lore<textarea rows="4" value={draft.lore} onChange={e => setDraft({ ...draft, lore: e.target.value })}/></label><label className="wide">Historia<textarea rows="4" value={draft.history} onChange={e => setDraft({ ...draft, history: e.target.value })}/></label><label className="wide">Etiquetas<input value={Array.isArray(draft.tags) ? draft.tags.join(', ') : draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })}/></label></div>; }
function CharacterForm({ draft, setDraft, universes }) { const fields = [['name','Nombre'],['alias','Alias'],['pronouns','Pronombres'],['gender','Género'],['species','Especie'],['origin','Origen'],['residence','Residencia'],['occupation','Ocupación'],['status','Estado vital'],['powers','Poderes']]; const detailFields = [['appearance','Aspecto'],['personality','Personalidad'],['goals','Motivaciones'],['fears','Temores'],['voice','Voz y gestos'],['skills','Habilidades'],['weaknesses','Debilidades']]; return <div className="form-grid"><label>Universo<select value={draft.universe_id} onChange={e => setDraft({ ...draft, universe_id: e.target.value })}><option value="">Sin universo</option>{universes.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>{fields.map(([key,label]) => <label key={key}>{label}<input required={key === 'name'} value={draft[key] || ''} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/></label>)}<label className="wide">Etiquetas<input value={draft.tags || ''} onChange={e => setDraft({ ...draft, tags: e.target.value })}/></label><label className="wide">Descripción<textarea rows="3" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label className="wide">Biografía<textarea rows="5" value={draft.biography} onChange={e => setDraft({ ...draft, biography: e.target.value })}/></label><h3 className="wide extra-heading">Detalles de personaje</h3>{detailFields.map(([key,label]) => <label className="wide" key={key}>{label}<textarea rows="2" value={draft.details?.[key] || ''} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })}/></label>)}</div>; }
function EntryForm({ draft, setDraft, universes, page }) { return <div className="form-grid"><label>Nombre<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>Universo<select value={draft.universe_id} onChange={e => setDraft({ ...draft, universe_id: e.target.value })}><option value="">General</option>{universes.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label className="wide">Descripción<textarea rows="4" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label className="wide">Etiquetas<input value={draft.tags || ''} onChange={e => setDraft({ ...draft, tags: e.target.value })}/></label>{page === 'events' && <label>Fecha<input type="date" value={draft.data?.date || ''} onChange={e => setDraft({ ...draft, data: { ...draft.data, date: e.target.value } })}/></label>}{page === 'stories' && <label className="wide">Texto<textarea rows="10" value={draft.data?.content || ''} onChange={e => setDraft({ ...draft, data: { ...draft.data, content: e.target.value } })}/></label>}{page === 'gallery' && <label className="wide">URL de imagen<input type="url" value={draft.data?.image_url || ''} onChange={e => setDraft({ ...draft, data: { ...draft.data, image_url: e.target.value } })}/><small>Se guarda un enlace. Para subir archivos hace falta conectar almacenamiento de objetos.</small></label>}</div>; }
function Relationships({ characters, onError }) {
 const [rows, setRows] = useState([]), [source, setSource] = useState(''), [target, setTarget] = useState(''), [type, setType] = useState('amistad'), [description, setDescription] = useState('');
 const load = () => api('/relationships').then(setRows).catch(err => onError(err.message));
 useEffect(() => { load(); }, []);
 async function add(e) { e.preventDefault(); try { await api('/relationships', { method: 'POST', body: JSON.stringify({ source_character_id: Number(source), target_character_id: Number(target), relation_type: type, description }) }); setDescription(''); await load(); } catch (err) { onError(err.message); } }
 return <><form className="relation-form" onSubmit={add}><h2>Conectar personajes</h2><select required value={source} onChange={e => setSource(e.target.value)}><option value="">Desde…</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><select required value={target} onChange={e => setTarget(e.target.value)}><option value="">Hacia…</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input value={type} onChange={e => setType(e.target.value)} placeholder="Tipo de relación"/><input value={description} onChange={e => setDescription(e.target.value)} placeholder="Descripción"/><button className="primary"><Plus size={15}/> Crear vínculo</button></form><div className="relation-list">{rows.map(row => <article key={row.id}><b>{row.source_name}</b><span>— {row.relation_type} —</span><b>{row.target_name}</b><p>{row.description}</p><button className="text-btn" onClick={async () => { await api(`/relationships/${row.id}`, { method: 'DELETE' }); load(); }}>Quitar vínculo</button></article>)}</div>{!rows.length && <Empty title="Todavía no hay vínculos" text="Conectá dos personajes para visualizar su relación."/>}</>;
}
function Favorites({ onError, onJump }) { const [rows, setRows] = useState([]); useEffect(() => { api('/favorites').then(setRows).catch(err => onError(err.message)); }, []); return <div className="cards">{rows.map(row => <article className="card" key={row.favorite_id}><div className="card-copy"><div className="card-meta">{row.entity_type}</div><h3>{row.name}</h3><p>{row.description}</p><button className="text-btn" onClick={() => onJump(row.entity_type === 'universe' ? 'universes' : row.entity_type === 'character' ? 'characters' : 'notes')}>Abrir en archivo <ChevronRight size={14}/></button></div></article>)}</div>; }
function SettingsPage({ user, onUser, onLogout, prompt, setPrompt, apply, saveTheme, theme, onError }) {
 const [profile, setProfile] = useState({ username: user.username, email: user.email, bio: user.bio || '', avatar_url: user.avatar_url || '' });
 const [password, setPassword] = useState({ current_password: '', new_password: '' });
 const [confirmPassword, setConfirmPassword] = useState('');
 async function updateProfile(e) { e.preventDefault(); try { const result = await api('/auth/profile', { method: 'PUT', body: JSON.stringify(profile) }); onUser(result.user); onError('Perfil actualizado.'); } catch (err) { onError(err.message); } }
 async function updatePassword(e) { e.preventDefault(); try { await api('/auth/password', { method: 'PUT', body: JSON.stringify(password) }); setPassword({ current_password: '', new_password: '' }); onError('Contraseña cambiada. Iniciá sesión de nuevo.'); await onLogout(); } catch (err) { onError(err.message); } }
 async function deleteAccount() { if (!window.confirm('Se eliminarán permanentemente tu cuenta y todas sus fichas. ¿Continuar?')) return; try { await api('/auth/account', { method: 'DELETE', body: JSON.stringify({ password: confirmPassword }) }); setConfirmPassword(''); await onLogout(); } catch (err) { onError(err.message); } }
 return <div className="settings-grid"><section className="panel"><div className="eyebrow">APARIENCIA LOCAL</div><h2>Diseñá el ambiente</h2><p>Escribí un prompt estético. El parser corre en tu navegador y aplica una paleta cercana desde sus reglas locales.</p><textarea rows="4" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Archivo gótico, papel envejecido y tinta verde oscura…"/><div className="settings-actions"><button className="secondary" onClick={apply}><Sparkles size={15}/> Aplicar prompt</button><button className="primary" onClick={saveTheme}>Guardar apariencia</button></div>{theme && <small>Tokens activos: {Object.keys(theme).length}. La apariencia se sincroniza en tu cuenta.</small>}</section><section className="panel"><div className="eyebrow">PERFIL</div><h2>{user.username}</h2><form className="settings-form" onSubmit={updateProfile}><label>Nombre de usuario<input required minLength="3" maxLength="32" value={profile.username} onChange={e => setProfile({ ...profile, username: e.target.value })}/></label><label>Email<input required type="email" value={profile.email} onChange={e => setProfile({ ...profile, email: e.target.value })}/></label><label>Biografía<textarea rows="3" value={profile.bio} onChange={e => setProfile({ ...profile, bio: e.target.value })}/></label><label>URL de avatar<input type="url" value={profile.avatar_url} onChange={e => setProfile({ ...profile, avatar_url: e.target.value })}/></label><button className="secondary">Guardar perfil</button></form></section><section className="panel"><div className="eyebrow">SEGURIDAD</div><h2>Cambiar contraseña</h2><form className="settings-form" onSubmit={updatePassword}><label>Contraseña actual<input required type="password" value={password.current_password} onChange={e => setPassword({ ...password, current_password: e.target.value })}/></label><label>Nueva contraseña<input required minLength="10" type="password" value={password.new_password} onChange={e => setPassword({ ...password, new_password: e.target.value })}/></label><button className="secondary">Actualizar contraseña</button></form></section><section className="panel danger-zone"><div className="eyebrow">CUENTA PRIVADA</div><h2>Eliminar cuenta</h2><p>La acción borra permanentemente tus fichas y preferencias.</p><label>Confirmá con tu contraseña<input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}/></label><button className="danger-button" onClick={deleteAccount}>Eliminar mi cuenta</button><small>La sesión se guarda en este navegador. Cerrá sesión si compartís el dispositivo.</small></section></div>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);

