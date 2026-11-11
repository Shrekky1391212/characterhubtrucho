import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { initializeDatabase, pool } from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const asyncRoute = handler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const universeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(10000).optional().default(''),
  genre: z.string().max(100).optional().default(''),
  tone: z.string().max(100).optional().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#c2a878'),
});

const characterSchema = z.object({
  universe_id: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  alias: z.string().max(240).optional().default(''),
  pronouns: z.string().max(80).optional().default(''),
  gender: z.string().max(80).optional().default(''),
  species: z.string().max(120).optional().default(''),
  origin: z.string().max(200).optional().default(''),
  residence: z.string().max(200).optional().default(''),
  occupation: z.string().max(160).optional().default(''),
  status: z.string().max(80).optional().default(''),
  powers: z.string().max(500).optional().default(''),
  tags: z.string().max(500).optional().default(''),
  description: z.string().max(3000).optional().default(''),
  biography: z.string().max(20000).optional().default(''),
});

const themeSchema = z.object({
  prompt: z.string().max(1000).optional().default(''),
  page_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  panel_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ink: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  muted: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  line: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sidebar_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  heading_font: z.enum(['serif', 'sans', 'mono']),
  texture: z.enum(['plain', 'grain', 'grid']),
  corner: z.enum(['soft', 'square', 'round']),
});

const themeDefaults = {
  prompt: '',
  page_bg: '#f7f6f2',
  panel_bg: '#fffefa',
  ink: '#282720',
  muted: '#8c8980',
  line: '#e9e7df',
  accent: '#9b845c',
  sidebar_bg: '#24231f',
  heading_font: 'serif',
  texture: 'plain',
  corner: 'soft',
};

const universeSelect = 'SELECT * FROM universes ORDER BY updated_at DESC, id DESC';
const characterById = `
  SELECT c.*, u.name AS universe_name, u.color AS universe_color
  FROM characters c
  LEFT JOIN universes u ON u.id = c.universe_id
  WHERE c.id = $1`;

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.get('/api/universes', asyncRoute(async (_req, res) => {
  const result = await pool.query(universeSelect);
  res.json(result.rows);
}));

app.post('/api/universes', asyncRoute(async (req, res) => {
  const parsed = universeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del universo.', details: z.flattenError(parsed.error) });

  const { name, description, genre, tone, color } = parsed.data;
  const result = await pool.query(
    `INSERT INTO universes (name, description, genre, tone, color)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, description, genre, tone, color],
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/universes/:id', asyncRoute(async (req, res) => {
  const parsed = universeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del universo.', details: parsed.error.flatten() });

  const { name, description, genre, tone, color } = parsed.data;
  const result = await pool.query(
    `UPDATE universes
     SET name = $1, description = $2, genre = $3, tone = $4, color = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $6 RETURNING *`,
    [name, description, genre, tone, color, req.params.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  res.json(result.rows[0]);
}));

app.delete('/api/universes/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM universes WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  res.status(204).end();
}));

app.get('/api/universes/:id/theme', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM universe_themes WHERE universe_id = $1', [req.params.id]);
  if (result.rowCount) return res.json(result.rows[0]);

  const universe = await pool.query('SELECT id FROM universes WHERE id = $1', [req.params.id]);
  if (!universe.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  res.json({ universe_id: Number(req.params.id), ...themeDefaults });
}));

app.put('/api/universes/:id/theme', asyncRoute(async (req, res) => {
  const parsed = themeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los ajustes visuales.', details: z.flattenError(parsed.error) });
  const universe = await pool.query('SELECT id FROM universes WHERE id = $1', [req.params.id]);
  if (!universe.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });

  const values = Object.values(parsed.data);
  const result = await pool.query(
    `INSERT INTO universe_themes (
       universe_id, prompt, page_bg, panel_bg, ink, muted, line, accent,
       sidebar_bg, heading_font, texture, corner
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (universe_id) DO UPDATE SET
       prompt = EXCLUDED.prompt, page_bg = EXCLUDED.page_bg, panel_bg = EXCLUDED.panel_bg,
       ink = EXCLUDED.ink, muted = EXCLUDED.muted, line = EXCLUDED.line,
       accent = EXCLUDED.accent, sidebar_bg = EXCLUDED.sidebar_bg,
       heading_font = EXCLUDED.heading_font, texture = EXCLUDED.texture,
       corner = EXCLUDED.corner, updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [Number(req.params.id), ...values],
  );
  res.json(result.rows[0]);
}));

app.get('/api/characters', asyncRoute(async (req, res) => {
  const { q = '', universe = '', gender = '', species = '', status = '', origin = '', residence = '', tag = '' } = req.query;
  const filters = [];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    filters.push(sql.replace('?', `$${values.length}`));
  };

  if (q) {
    const search = `%${q}%`;
    const start = values.length + 1;
    values.push(search, search, search, search, search);
    filters.push(`(c.name ILIKE $${start} OR c.alias ILIKE $${start + 1} OR c.description ILIKE $${start + 2} OR c.biography ILIKE $${start + 3} OR c.tags ILIKE $${start + 4})`);
  }

  if (universe) {
    const universeId = Number(universe);
    if (!Number.isInteger(universeId) || universeId <= 0) return res.status(400).json({ error: 'El filtro de universo no es válido.' });
    addFilter('c.universe_id = ?', universeId);
  }
  for (const [value, column] of [[gender, 'c.gender'], [species, 'c.species'], [status, 'c.status'], [origin, 'c.origin'], [residence, 'c.residence']]) {
    if (value) addFilter(`${column} = ?`, value);
  }
  if (tag) addFilter('c.tags ILIKE ?', `%${tag}%`);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT c.*, u.name AS universe_name, u.color AS universe_color
     FROM characters c
     LEFT JOIN universes u ON u.id = c.universe_id
     ${where}
     ORDER BY c.updated_at DESC, c.id DESC`,
    values,
  );
  res.json(result.rows);
}));

app.post('/api/characters', asyncRoute(async (req, res) => {
  const parsed = characterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del personaje.', details: z.flattenError(parsed.error) });

  const d = parsed.data;
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO characters (
         universe_id, name, alias, pronouns, gender, species, origin, residence,
         occupation, status, powers, tags, description, biography
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *
     )
     SELECT inserted.*, u.name AS universe_name, u.color AS universe_color
     FROM inserted LEFT JOIN universes u ON u.id = inserted.universe_id`,
    [d.universe_id || null, d.name, d.alias, d.pronouns, d.gender, d.species, d.origin, d.residence, d.occupation, d.status, d.powers, d.tags, d.description, d.biography],
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/characters/:id', asyncRoute(async (req, res) => {
  const parsed = characterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del personaje.', details: z.flattenError(parsed.error) });

  const d = parsed.data;
  const result = await pool.query(
    `WITH updated AS (
       UPDATE characters SET
         universe_id = $1, name = $2, alias = $3, pronouns = $4, gender = $5,
         species = $6, origin = $7, residence = $8, occupation = $9, status = $10,
         powers = $11, tags = $12, description = $13, biography = $14,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $15 RETURNING *
     )
     SELECT updated.*, u.name AS universe_name, u.color AS universe_color
     FROM updated LEFT JOIN universes u ON u.id = updated.universe_id`,
    [d.universe_id || null, d.name, d.alias, d.pronouns, d.gender, d.species, d.origin, d.residence, d.occupation, d.status, d.powers, d.tags, d.description, d.biography, req.params.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Personaje no encontrado.' });
  res.json(result.rows[0]);
}));

app.delete('/api/characters/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM characters WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Personaje no encontrado.' });
  res.status(204).end();
}));

app.use((err, _req, res, _next) => {
  console.error('API request failed:', err.message);
  if (err.code === '23503') return res.status(400).json({ error: 'La entidad relacionada no existe.' });
  if (err.code === '22P02' || err.code === '22003') return res.status(400).json({ error: 'El identificador no es válido.' });
  res.status(500).json({ error: 'Ocurrió un error inesperado.' });
});

const port = Number(process.env.PORT || 3001);
await initializeDatabase();
const server = app.listen(port, '0.0.0.0', () => console.log(`OC Archive API listening on port ${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    await pool.end();
    process.exit(0);
  }));
}
