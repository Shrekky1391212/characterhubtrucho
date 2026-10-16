import express from 'express';
import cors from 'cors';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbFile = resolve(here, '../data/archive.sqlite');
mkdirSync(dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS universes (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#c2a878', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS characters (
 id INTEGER PRIMARY KEY, universe_id INTEGER REFERENCES universes(id) ON DELETE SET NULL,
 name TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '', pronouns TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '', species TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT '', residence TEXT NOT NULL DEFAULT '', occupation TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', powers TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', biography TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS universe_themes (
 universe_id INTEGER PRIMARY KEY REFERENCES universes(id) ON DELETE CASCADE,
 prompt TEXT NOT NULL DEFAULT '',
 page_bg TEXT NOT NULL DEFAULT '#f7f6f2', panel_bg TEXT NOT NULL DEFAULT '#fffefa',
 ink TEXT NOT NULL DEFAULT '#282720', muted TEXT NOT NULL DEFAULT '#8c8980',
 line TEXT NOT NULL DEFAULT '#e9e7df', accent TEXT NOT NULL DEFAULT '#9b845c',
 sidebar_bg TEXT NOT NULL DEFAULT '#24231f', heading_font TEXT NOT NULL DEFAULT 'serif',
 texture TEXT NOT NULL DEFAULT 'plain', corner TEXT NOT NULL DEFAULT 'soft',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_characters_universe ON characters(universe_id);
CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name COLLATE NOCASE);
`);

const app = express();
app.use(cors()); app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { try { next(); } catch (error) { next(error); } });
const universeSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(10000).optional().default(''), genre: z.string().max(100).optional().default(''), tone: z.string().max(100).optional().default(''), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#c2a878') });
const characterSchema = z.object({ universe_id: z.coerce.number().int().positive().nullable().optional(), name: z.string().trim().min(1).max(120), alias: z.string().max(240).optional().default(''), pronouns: z.string().max(80).optional().default(''), gender: z.string().max(80).optional().default(''), species: z.string().max(120).optional().default(''), origin: z.string().max(200).optional().default(''), residence: z.string().max(200).optional().default(''), occupation: z.string().max(160).optional().default(''), status: z.string().max(80).optional().default(''), powers: z.string().max(500).optional().default(''), tags: z.string().max(500).optional().default(''), description: z.string().max(3000).optional().default(''), biography: z.string().max(20000).optional().default('') });
const themeSchema = z.object({ prompt: z.string().max(1000).optional().default(''), page_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/), panel_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/), ink: z.string().regex(/^#[0-9a-fA-F]{6}$/), muted: z.string().regex(/^#[0-9a-fA-F]{6}$/), line: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), sidebar_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/), heading_font: z.enum(['serif', 'sans', 'mono']), texture: z.enum(['plain', 'grain', 'grid']), corner: z.enum(['soft', 'square', 'round']) });
const all = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC, id DESC`).all();
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/universes', (_req, res) => res.json(all('universes')));
app.post('/api/universes', (req, res) => {
 const parsed = universeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del universo.', details: parsed.error.flatten() });
 const d = parsed.data; const result = db.prepare('INSERT INTO universes (name,description,genre,tone,color) VALUES (@name,@description,@genre,@tone,@color)').run(d); res.status(201).json(db.prepare('SELECT * FROM universes WHERE id=?').get(result.lastInsertRowid));
});
app.put('/api/universes/:id', (req, res) => {
 const parsed = universeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del universo.', details: parsed.error.flatten() });
 const d = parsed.data; const result = db.prepare('UPDATE universes SET name=@name,description=@description,genre=@genre,tone=@tone,color=@color,updated_at=CURRENT_TIMESTAMP WHERE id=@id').run({ ...d, id: req.params.id }); if (!result.changes) return res.status(404).json({ error: 'Universo no encontrado.' }); res.json(db.prepare('SELECT * FROM universes WHERE id=?').get(req.params.id));
});
app.delete('/api/universes/:id', (req, res) => { const result = db.prepare('DELETE FROM universes WHERE id=?').run(req.params.id); if (!result.changes) return res.status(404).json({ error: 'Universo no encontrado.' }); res.status(204).end(); });
app.get('/api/universes/:id/theme', (req, res) => {
 const universe = db.prepare('SELECT id FROM universes WHERE id=?').get(req.params.id); if (!universe) return res.status(404).json({ error: 'Universo no encontrado.' });
 res.json(db.prepare('SELECT * FROM universe_themes WHERE universe_id=?').get(req.params.id) || { universe_id: Number(req.params.id), prompt: '', page_bg: '#f7f6f2', panel_bg: '#fffefa', ink: '#282720', muted: '#8c8980', line: '#e9e7df', accent: '#9b845c', sidebar_bg: '#24231f', heading_font: 'serif', texture: 'plain', corner: 'soft' });
});
app.put('/api/universes/:id/theme', (req, res) => {
 const universe = db.prepare('SELECT id FROM universes WHERE id=?').get(req.params.id); if (!universe) return res.status(404).json({ error: 'Universo no encontrado.' });
 const parsed = themeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Revisá los ajustes visuales.', details: parsed.error.flatten() });
 const d = parsed.data; db.prepare(`INSERT INTO universe_themes (universe_id,prompt,page_bg,panel_bg,ink,muted,line,accent,sidebar_bg,heading_font,texture,corner) VALUES (@universe_id,@prompt,@page_bg,@panel_bg,@ink,@muted,@line,@accent,@sidebar_bg,@heading_font,@texture,@corner) ON CONFLICT(universe_id) DO UPDATE SET prompt=excluded.prompt,page_bg=excluded.page_bg,panel_bg=excluded.panel_bg,ink=excluded.ink,muted=excluded.muted,line=excluded.line,accent=excluded.accent,sidebar_bg=excluded.sidebar_bg,heading_font=excluded.heading_font,texture=excluded.texture,corner=excluded.corner,updated_at=CURRENT_TIMESTAMP`).run({ ...d, universe_id: Number(req.params.id) });
 res.json(db.prepare('SELECT * FROM universe_themes WHERE universe_id=?').get(req.params.id));
});
app.get('/api/characters', (req, res) => {
 const { q = '', universe = '', gender = '', species = '', status = '', origin = '', residence = '', tag = '' } = req.query;
 const where = []; const p = {};
 if (q) { where.push('(c.name LIKE @q OR c.alias LIKE @q OR c.description LIKE @q OR c.biography LIKE @q OR c.tags LIKE @q)'); p.q = `%${q}%`; }
 for (const [key, col] of Object.entries({ universe: 'c.universe_id', gender: 'c.gender', species: 'c.species', status: 'c.status', origin: 'c.origin', residence: 'c.residence' })) if (req.query[key]) { where.push(`${col} = @${key}`); p[key] = key === 'universe' ? Number(req.query[key]) : req.query[key]; }
 if (tag) { where.push('c.tags LIKE @tag'); p.tag = `%${tag}%`; }
 const sql = `SELECT c.*, u.name AS universe_name, u.color AS universe_color FROM characters c LEFT JOIN universes u ON u.id=c.universe_id ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY c.updated_at DESC, c.id DESC`;
 res.json(db.prepare(sql).all(p));
});
app.post('/api/characters', (req, res) => {
 const parsed = characterSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del personaje.', details: parsed.error.flatten() });
 const d = parsed.data; const result = db.prepare('INSERT INTO characters (universe_id,name,alias,pronouns,gender,species,origin,residence,occupation,status,powers,tags,description,biography) VALUES (@universe_id,@name,@alias,@pronouns,@gender,@species,@origin,@residence,@occupation,@status,@powers,@tags,@description,@biography)').run({ ...d, universe_id: d.universe_id || null }); res.status(201).json(db.prepare('SELECT c.*,u.name AS universe_name,u.color AS universe_color FROM characters c LEFT JOIN universes u ON u.id=c.universe_id WHERE c.id=?').get(result.lastInsertRowid));
});
app.put('/api/characters/:id', (req, res) => {
 const parsed = characterSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del personaje.', details: parsed.error.flatten() });
 const d = parsed.data; const result = db.prepare('UPDATE characters SET universe_id=@universe_id,name=@name,alias=@alias,pronouns=@pronouns,gender=@gender,species=@species,origin=@origin,residence=@residence,occupation=@occupation,status=@status,powers=@powers,tags=@tags,description=@description,biography=@biography,updated_at=CURRENT_TIMESTAMP WHERE id=@id').run({ ...d, universe_id: d.universe_id || null, id: req.params.id }); if (!result.changes) return res.status(404).json({ error: 'Personaje no encontrado.' }); res.json(db.prepare('SELECT c.*,u.name AS universe_name,u.color AS universe_color FROM characters c LEFT JOIN universes u ON u.id=c.universe_id WHERE c.id=?').get(req.params.id));
});
app.delete('/api/characters/:id', (req, res) => { const result = db.prepare('DELETE FROM characters WHERE id=?').run(req.params.id); if (!result.changes) return res.status(404).json({ error: 'Personaje no encontrado.' }); res.status(204).end(); });
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Ocurrió un error inesperado.' }); });
const port = Number(process.env.PORT || 3001); app.listen(port, '127.0.0.1', () => console.log(`OC Archive API: http://127.0.0.1:${port}`));
