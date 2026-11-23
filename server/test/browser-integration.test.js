import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { initializeDatabase } from '../src/db.js';
import { applyPhase2SchemaForIsolatedTest } from '../src/phase2-schema.js';

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgePath = edgeCandidates.find(existsSync);

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function waitFor(check, description, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function browserConnection(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) { events.push(message); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  return {
    async open() { await opened; },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser JavaScript failed');
      return response.result?.value;
    },
    events,
    close() { socket.close(); },
  };
}

test('Edge browser exercises login, 503 fallback, library, groups, memberships, and dynamic forms', { skip: !edgePath && 'Microsoft Edge was not found' }, async t => {
  assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL must be absent');
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'TEST_DATABASE_URL must be absent');
  const db = new PGlite('memory://');
  const identity = await db.query('SELECT version() AS version, inet_server_addr() AS address');
  assert.match(identity.rows[0].version, /PGlite/);
  assert.equal(identity.rows[0].address, null);
  const query = (...args) => db.query(...args);
  const pool = { query, async connect() { return { query, release() {} }; }, async end() { await db.close(); } };
  const apiPort = await freePort();
  const vitePort = await freePort();
  const debugPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${vitePort}`;
  const profile = mkdtempSync(join(tmpdir(), 'oc-archive-edge-'));
  const previousCorsOrigins = process.env.CORS_ORIGINS;
  let apiServer;
  let vite;
  let edge;
  let cdp;

  try {
    await initializeDatabase(pool);
    process.env.CORS_ORIGINS = webOrigin;
    const app = createApp({ databasePool: pool });
    apiServer = await new Promise(resolve => {
      const listening = app.listen(apiPort, '127.0.0.1', () => resolve(listening));
    });
    const registration = await fetch(`${apiOrigin}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'browser-writer', email: 'browser@example.test', password: 'browser-password-123' }),
    });
    assert.equal(registration.status, 201);
    await registration.json();
    const clientRoot = resolve(import.meta.dirname, '../../client');
    vite = spawn(process.execPath, [join(clientRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: clientRoot,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, VITE_API_URL: apiOrigin },
    });
    await waitFor(async () => (await fetch(webOrigin)).ok, 'Vite frontend');

    edge = spawn(edgePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok, 'Edge DevTools');
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    assert.equal(targetResponse.ok, true);
    const target = await targetResponse.json();
    cdp = browserConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: webOrigin });
    await waitFor(() => cdp.evaluate("document.querySelector('.auth') !== null"), 'login page');

    async function clickButton(text) {
      const clicked = await waitFor(() => cdp.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(item=>item.textContent.includes(${JSON.stringify(text)})); if(!button) return false; button.click(); return true; })()`), `button '${text}'`, 5000);
      assert.equal(clicked, true, `button '${text}' is available`);
    }
    async function fillLabel(labelText, value, root = 'body') {
      const filled = await cdp.evaluate(`(() => {
        const label=[...document.querySelectorAll(${JSON.stringify(root + ' label')})].find(item=>item.textContent.trim().startsWith(${JSON.stringify(labelText)}));
        const control=label?.querySelector('input,textarea,select'); if(!control) return false;
        const prototype=control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set; setter.call(control,${JSON.stringify(value)});
        control.dispatchEvent(new Event('input',{bubbles:true})); control.dispatchEvent(new Event('change',{bubbles:true})); return true;
      })()`);
      assert.equal(filled, true, `field '${labelText}' is available`);
    }
    async function fillPlaceholder(placeholder, value, root = 'body') {
      const filled = await cdp.evaluate(`(() => { const control=[...document.querySelectorAll(${JSON.stringify(root + ' input, ' + root + ' textarea')})].find(item=>item.placeholder===${JSON.stringify(placeholder)}); if(!control)return false; const prototype=control instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(control,${JSON.stringify(value)}); control.dispatchEvent(new Event('input',{bubbles:true})); control.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
      assert.equal(filled, true, `placeholder '${placeholder}' is available`);
    }
    async function submit(selector) {
      const submitted = await cdp.evaluate(`(() => { const form=document.querySelector(${JSON.stringify(selector)}); if(!form) return false; form.requestSubmit(); return true; })()`);
      assert.equal(submitted, true, `form '${selector}' is available`);
    }
    async function chooseGroup(name) {
      const selected = await cdp.evaluate(`(() => { const select=document.querySelector('.phase2-toolbar select'); const option=[...select.options].find(item=>item.textContent.includes(${JSON.stringify(name)})); if(!option) return false; select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
      assert.equal(selected, true, `group '${name}' is selectable`);
    }

    await fillLabel('Usuario o email', 'browser@example.test', '.auth-card');
    await fillLabel('Contrasena', 'browser-password-123', '.auth-card');
    await submit('.auth-card form');
    try { await waitFor(() => cdp.evaluate("document.querySelector('.shell') !== null"), 'authenticated app shell'); }
    catch (error) { throw new Error(`${error.message}\nURL: ${await cdp.evaluate('location.href')}\nReady: ${await cdp.evaluate('document.readyState')}\nHTML: ${(await cdp.evaluate('document.documentElement.outerHTML')).slice(0,1200)}\nEvents: ${JSON.stringify(cdp.events.slice(-8))}`); }
    const token = await cdp.evaluate("localStorage.getItem('oc-archive-session')");
    assert.ok(token, 'login stores a persistent session token');
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate("document.querySelector('.shell') !== null"), 'session restored after reload');
    assert.equal(await cdp.evaluate("localStorage.getItem('oc-archive-session')"), token, 'session survives a browser reload');

    const apiRequest = async (path, method = 'GET', body) => {
      const response = await fetch(apiOrigin + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    };
    const universe = await apiRequest('/api/universes', 'POST', { name: 'Browser universe' });
    const character = await apiRequest('/api/characters', 'POST', { name: 'Mira', scope_kind: 'universe', universe_id: universe.data.id });
    const globalEntry = await apiRequest('/api/entries', 'POST', { name: 'Global note', kind: 'note', scope_kind: 'global' });
    const pendingEntry = await apiRequest('/api/entries', 'POST', { name: 'Pending diary', kind: 'note', scope_kind: 'pending' });
    assert.equal(character.status, 201);
    assert.equal(globalEntry.status, 201);
    assert.equal(pendingEntry.status, 201);
    await db.query('UPDATE characters SET details=$1 WHERE owner_id=$2 AND id=$3', [{ unrendered: 'preserve' }, universe.data.owner_id, character.data.id]);

    await clickButton('Biblioteca');
    await waitFor(() => cdp.evaluate("document.querySelector('.phase2-banner')?.textContent.includes('no disponible')"), 'visible Phase 2 schema-unavailable state');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Mira') && document.body.innerText.includes('Global note')"), 'legacy library rows');
    assert.equal(await cdp.evaluate("document.body.innerText.includes('Mira') && document.body.innerText.includes('Global note')"), true, 'legacy library content remains available during the 503 fallback');

    await applyPhase2SchemaForIsolatedTest(db);
    const syntheticRegistry = await db.query(`INSERT INTO content_items(owner_id,type_key,source_kind,source_id,scope_kind,universe_id,name,description,tags,data)
      SELECT owner_id,'character','character',id,scope_kind,universe_id,name,description,
        CASE WHEN NULLIF(btrim(tags),'') IS NULL THEN '{}'::text[] ELSE regexp_split_to_array(tags,'\\s*,\\s*') END,to_jsonb(characters)
      FROM characters WHERE owner_id=$1 AND id=$2 RETURNING id`, [universe.data.owner_id, character.data.id]);
    assert.equal(syntheticRegistry.rowCount, 1, 'the browser fixture models one record that the separately authorized backfill would have registered');
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate("document.querySelector('.shell') !== null && !document.querySelector('.phase2-banner')"), 'Phase 2 ready state');
    await clickButton('Biblioteca');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Mira')"), 'unified library item');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Global note')"), 'global library item');
    const openedMigratedCharacter = await cdp.evaluate(`(() => {
      const card=[...document.querySelectorAll('.content-list article')].find(item=>item.querySelector('h3')?.textContent==='Mira');
      const button=[...(card?.querySelectorAll('button')||[])].find(item=>item.textContent.includes('Clasificar / editar'));
      if(!button) return false; button.click(); return true;
    })()`);
    assert.equal(openedMigratedCharacter, true, 'a migrated character opens through its source table identity');
    await waitFor(() => cdp.evaluate("document.querySelector('.modal') !== null"), 'migrated character editor');
    await fillLabel('Alias', 'Mira Prime', '.modal');
    await submit('.modal');
    await waitFor(async () => {
      const saved = await db.query('SELECT alias,details FROM characters WHERE owner_id=$1 AND id=$2', [universe.data.owner_id, character.data.id]);
      return saved.rows[0]?.alias === 'Mira Prime' && saved.rows[0]?.details?.unrendered === 'preserve';
    }, 'migrated character edit preserving hidden details');
    await clickButton('Personajes');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.card h3')].some(item=>item.textContent==='Mira')"), 'character cards');
    await clickButton('Abrir ficha');
    await waitFor(() => cdp.evaluate("document.querySelector('.character-sheet') !== null"), 'character sheet viewer');
    await clickButton('Personalizar ficha');
    await fillLabel('Nombre de sección personalizada', 'Solo Mira', '.sheet-manage');
    await clickButton('Crear sección');
    await waitFor(() => cdp.evaluate("document.querySelector('.sheet-detail h2')?.textContent==='Solo Mira'"), 'personal section creation');
    await fillLabel('Contenido', 'A section unique to Mira', '.sheet-section-editor');
    await clickButton('Guardar sección');
    await waitFor(async () => (await db.query('SELECT details->\'character_sheet\'->\'sections\' AS sections FROM characters WHERE id=$1', [character.data.id])).rows[0]?.sections?.some(section=>section.name==='Solo Mira'&&section.content==='A section unique to Mira'), 'personal section persistence');
    await clickButton('Línea temporal');
    await fillPlaceholder('Fecha o período','Año 4','.sheet-event-form');
    await fillPlaceholder('Acontecimiento','Primera expedición','.sheet-event-form');
    await fillPlaceholder('Descripción','Mira encuentra la ciudad perdida.','.sheet-event-form');
    await clickButton('Agregar acontecimiento');
    await waitFor(async () => (await db.query('SELECT details->\'character_sheet\'->\'timeline\' AS timeline FROM characters WHERE id=$1',[character.data.id])).rows[0]?.timeline?.some(item=>item.title==='Primera expedición'),'personal timeline persistence');
    await clickButton('Galería de imágenes');
    await waitFor(() => cdp.evaluate("document.querySelector('.sheet-gallery .sheet-image-add')!==null"),'gallery section opened');
    await fillPlaceholder('URL de imagen','https://images.example.test/mira.png','.sheet-image-add');
    await fillPlaceholder('Descripción o comentario','Retrato de viaje','.sheet-image-add');
    await clickButton('Agregar imagen');
    await waitFor(async () => (await db.query('SELECT count(*)::int AS count FROM media_assets WHERE owner_id=$1 AND character_id=$2',[universe.data.owner_id,character.data.id])).rows[0]?.count===1,'character gallery image persistence');
    await clickButton('Cerrar ficha');
    await clickButton('Biblioteca');
    await fillLabel('Scope', 'global', '.phase2-filters');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Global note') && !document.body.innerText.includes('Mira')"), 'global scope filter');
    await fillLabel('Scope', 'universe', '.phase2-filters');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Mira') && !document.body.innerText.includes('Global note')"), 'universe scope filter');
    await clickButton('Pendiente de organizar');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Pending diary') && !document.body.innerText.includes('Global note')"), 'separate pending view');

    await clickButton('Agrupaciones');
    await clickButton('Nuevo grupo');
    await fillLabel('Nombre', 'Browser crew', '.phase2-form');
    await submit('.phase2-form');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.phase2-toolbar select option')].some(option=>option.textContent.includes('Browser crew'))"), 'created group');
    await chooseGroup('Browser crew');
    await clickButton('Subgrupo');
    await fillLabel('Nombre', 'Inner circle', '.phase2-form');
    await submit('.phase2-form');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.phase2-toolbar select option')].some(option=>option.textContent.includes('Inner circle'))"), 'created subgroup');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('select option')].some(option=>option.textContent.includes('Mira'))"), 'member item selector');
    const selectedMember = await cdp.evaluate(`(() => { const select=[...document.querySelectorAll('select')].find(item=>[...item.options].some(option=>option.textContent.includes('Mira'))); const option=[...select.options].find(item=>item.textContent.includes('Mira')); select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    assert.equal(selectedMember, true);
    await clickButton('Agregar membresía');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.content-list h3')].some(item=>item.textContent==='Mira')"), 'visible group membership');

    await chooseGroup('Browser crew');
    await clickButton('Editar o mover');
    await fillLabel('Nombre', 'Browser crew renamed', '.phase2-form');
    await submit('.phase2-form');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.phase2-toolbar select option')].some(option=>option.textContent.includes('Browser crew renamed'))"), 'edited group');

    await clickButton('Tipos de contenido');
    await clickButton('Nuevo tipo');
    await fillLabel('Nombre', 'Relic', '.phase2-type-form');
    await fillLabel('Clave', 'rarity', '.phase2-new-field');
    await fillLabel('Etiqueta', 'Rarity', '.phase2-new-field');
    await clickButton('Añadir campo');
    await submit('.phase2-type-form');
    await waitFor(() => cdp.evaluate("[...document.querySelectorAll('.nav')].some(button=>button.textContent.includes('Relic'))"), 'dynamic type navigation');
    await clickButton('Relic');
    await clickButton('New Relic');
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.modal label')].some(label=>label.textContent.includes('Rarity'))"), true, 'dynamic field appears in the generated item form');
    await fillLabel('Name', 'Moonstone', '.modal');
    await fillLabel('Rarity', 'rare', '.modal');
    await submit('.modal');
    await waitFor(() => cdp.evaluate("document.body.innerText.includes('Moonstone')"), 'dynamic item form submission');
  } finally {
    try { await cdp?.send('Browser.close'); } catch {}
    cdp?.close();
    if (edge && edge.exitCode === null) edge.kill();
    if (vite && vite.exitCode === null) vite.kill();
    if (edge && edge.exitCode === null) await Promise.race([new Promise(resolve => edge.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (vite && vite.exitCode === null) await Promise.race([new Promise(resolve => vite.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (apiServer) await new Promise(resolve => apiServer.close(resolve));
    await pool.end();
    for (let attempt = 0; attempt < 8 && existsSync(profile); attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (previousCorsOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previousCorsOrigins;
  }
});
