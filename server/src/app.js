import express from 'express';
import cors from 'cors';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { initializeDatabase, pool } from './db.js';

const app = express();
const scrypt = promisify(scryptCallback);
const localOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://shrekky1391212.github.io'];
const allowedOrigins = (process.env.CORS_ORIGINS || localOrigins.join(','))
  .split(',').map(origin => origin.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '1mb' }));

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const normalizeUser = row => ({ id: row.id, username: row.username, email: row.email, bio: row.bio, avatar_url: row.avatar_url, created_at: row.created_at });

const registerSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
});
const loginSchema = z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) });
const profileSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.email().max(254),
  bio: z.string().max(2000).optional().default(''),
  avatar_url: z.union([z.literal(''), z.url()]).optional().default(''),
});
const passwordSchema = z.object({ current_password: z.string().min(1).max(128), new_password: z.string().min(10).max(128) });
const accountDeleteSchema = z.object({ password: z.string().min(1).max(128) });
const universeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(10000).optional().default(''),
  genre: z.string().max(100).optional().default(''),
  tone: z.string().max(100).optional().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#c2a878'),
  icon: z.string().max(80).optional().default(''),
  cover_url: z.union([z.literal(''), z.url()]).optional().default(''),
  lore: z.string().max(20000).optional().default(''),
  history: z.string().max(20000).optional().default(''),
  tags: z.array(z.string().max(60)).max(30).optional().default([]),
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
  details: z.record(z.string(), z.unknown()).optional().default({}),
});
const themeSchema = z.object({
  prompt: z.string().max(1000).optional().default(''),
  page_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/), panel_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ink: z.string().regex(/^#[0-9a-fA-F]{6}$/), muted: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  line: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sidebar_bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  heading_font: z.enum(['serif', 'sans', 'mono']), texture: z.enum(['plain', 'grain', 'grid']), corner: z.enum(['soft', 'square', 'round']),
});
const appearanceSchema = z.object({
  scope_type: z.enum(['application', 'section', 'universe', 'character', 'entry']),
  scope_id: z.string().min(1).max(100),
  prompt: z.string().max(1200).optional().default(''),
  tokens: z.record(z.string(), z.unknown()),
});
const entrySchema = z.object({
  kind: z.string().trim().min(1).max(48).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().trim().min(1).max(180),
  description: z.string().max(20000).optional().default(''),
  universe_id: z.coerce.number().int().positive().nullable().optional(),
  parent_id: z.coerce.number().int().positive().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(40).optional().default([]),
  data: z.record(z.string(), z.unknown()).optional().default({}),
});
const relationshipSchema = z.object({
  source_character_id: z.coerce.number().int().positive(),
  target_character_id: z.coerce.number().int().positive(),
  relation_type: z.string().trim().min(1).max(80),
  status: z.string().max(80).optional().default(''),
  description: z.string().max(4000).optional().default(''),
  dynamics: z.string().max(4000).optional().default(''),
  details: z.record(z.string(), z.unknown()).optional().default({}),
});
const contentTypeSchema = z.object({ label: z.string().trim().min(1).max(60), icon: z.string().max(50).optional().default('archive') });
const mediaSchema = z.object({
  entity_type: z.enum(['character', 'entry']), entity_id: z.coerce.number().int().positive(),
  image_url: z.url(), caption: z.string().max(240).optional().default(''),
  alt_text: z.string().max(240).optional().default(''), tags: z.array(z.string().max(60)).max(30).optional().default([]),
});

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 64);
  return { salt, hash: key.toString('hex') };
}

async function passwordMatches(password, salt, expectedHash) {
  const actual = await hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, 'hex');
  const derived = Buffer.from(actual.hash, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

async function createSession(client, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await client.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, expiresAt]);
  return token;
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los datos de registro.', details: z.flattenError(parsed.error) });
  const { username, email, password } = parsed.data;
  const normalizedUsername = username.toLowerCase();
  const normalizedEmail = email.toLowerCase();
  const { salt, hash } = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(83019411)');
    const priorUsers = await client.query('SELECT COUNT(*)::int AS count FROM users');
    if (priorUsers.rows[0].count === 0) {
      const legacyRows = await client.query('SELECT (SELECT COUNT(*) FROM universes WHERE owner_id IS NULL) + (SELECT COUNT(*) FROM characters WHERE owner_id IS NULL) AS count');
      const initialOwnerEmail = process.env.INITIAL_OWNER_EMAIL?.trim().toLowerCase();
      if (Number(legacyRows.rows[0].count) > 0 && (!initialOwnerEmail || initialOwnerEmail !== normalizedEmail)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'El primer registro debe usar el email configurado como INITIAL_OWNER_EMAIL para reclamar los datos existentes.' });
      }
    }
    const inserted = await client.query(
      `INSERT INTO users (username, email, password_hash, password_salt)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [normalizedUsername, normalizedEmail, hash, salt],
    );
    const user = inserted.rows[0];
    if (priorUsers.rows[0].count === 0) {
      await client.query('UPDATE universes SET owner_id = $1 WHERE owner_id IS NULL', [user.id]);
      await client.query('UPDATE characters SET owner_id = $1 WHERE owner_id IS NULL', [user.id]);
      await client.query(
        `UPDATE universe_themes t SET owner_id = $1 FROM universes u
         WHERE t.universe_id = u.id AND t.owner_id IS NULL AND u.owner_id = $1`, [user.id],
      );
    }
    await client.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    const token = await createSession(client, user.id);
    await client.query('COMMIT');
    res.status(201).json({ token, user: normalizeUser(user) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ingresá usuario/email y contraseña.' });
  const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1', [parsed.data.identifier]);
  const user = result.rows[0];
  if (!user || !(await passwordMatches(parsed.data.password, user.password_salt, user.password_hash))) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  const token = await createSession(pool, user.id);
  res.json({ token, user: normalizeUser(user) });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  res.status(204).end();
}));

const authenticate = asyncRoute(async (req, res, next) => {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
  const result = await pool.query(
    `SELECT u.id, u.username, u.email, u.bio, u.avatar_url, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
    [hashToken(token)],
  );
  if (!result.rowCount) return res.status(401).json({ error: 'La sesión venció. Volvé a iniciar sesión.' });
  req.user = result.rows[0];
  next();
});

app.use(authenticate);

app.get('/api/auth/me', (req, res) => res.json({ user: normalizeUser(req.user) }));

app.put('/api/auth/profile', asyncRoute(async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los datos del perfil.', details: z.flattenError(parsed.error) });
  const { username, email, bio, avatar_url } = parsed.data;
  const result = await pool.query(
    `UPDATE users SET username = $1, email = $2, bio = $3, avatar_url = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 RETURNING *`,
    [username.toLowerCase(), email.toLowerCase(), bio, avatar_url, req.user.id],
  );
  res.json({ user: normalizeUser(result.rows[0]) });
}));

app.put('/api/auth/password', asyncRoute(async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres.' });
  const result = await pool.query('SELECT password_hash, password_salt FROM users WHERE id = $1', [req.user.id]);
  const account = result.rows[0];
  if (!(await passwordMatches(parsed.data.current_password, account.password_salt, account.password_hash))) {
    return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
  }
  const next = await hashPassword(parsed.data.new_password);
  await pool.query('UPDATE users SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [next.hash, next.salt, req.user.id]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
  res.status(204).end();
}));

app.delete('/api/auth/account', asyncRoute(async (req, res) => {
  const parsed = accountDeleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Confirmá la contraseña para eliminar la cuenta.' });
  const result = await pool.query('SELECT password_hash, password_salt FROM users WHERE id = $1', [req.user.id]);
  const account = result.rows[0];
  if (!(await passwordMatches(parsed.data.password, account.password_salt, account.password_hash))) {
    return res.status(401).json({ error: 'La contraseña no es correcta.' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
  res.status(204).end();
}));

const themeDefaults = {
  prompt: '', page_bg: '#f7f6f2', panel_bg: '#fffefa', ink: '#282720', muted: '#8c8980',
  line: '#e9e7df', accent: '#9b845c', sidebar_bg: '#24231f', heading_font: 'serif', texture: 'plain', corner: 'soft',
};

async function ownedUniverse(ownerId, universeId) {
  if (!universeId) return true;
  const result = await pool.query('SELECT id FROM universes WHERE id = $1 AND owner_id = $2', [universeId, ownerId]);
  return result.rowCount > 0;
}

async function ownedEntry(ownerId, entryId) {
  if (!entryId) return true;
  const result = await pool.query('SELECT id FROM archive_entries WHERE id = $1 AND owner_id = $2', [entryId, ownerId]);
  return result.rowCount > 0;
}

const universeSelect = 'SELECT * FROM universes WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC';
app.get('/api/universes', asyncRoute(async (req, res) => {
  const result = await pool.query(universeSelect, [req.user.id]);
  res.json(result.rows);
}));

app.post('/api/universes', asyncRoute(async (req, res) => {
  const parsed = universeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del universo.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  const result = await pool.query(
    `INSERT INTO universes (owner_id, name, description, genre, tone, color, icon, cover_url, lore, history, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [req.user.id, d.name, d.description, d.genre, d.tone, d.color, d.icon, d.cover_url, d.lore, d.history, d.tags],
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/universes/:id', asyncRoute(async (req, res) => {
  const parsed = universeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del universo.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  const result = await pool.query(
    `UPDATE universes SET name=$1, description=$2, genre=$3, tone=$4, color=$5, icon=$6,
       cover_url=$7, lore=$8, history=$9, tags=$10, updated_at=CURRENT_TIMESTAMP
     WHERE id=$11 AND owner_id=$12 RETURNING *`,
    [d.name, d.description, d.genre, d.tone, d.color, d.icon, d.cover_url, d.lore, d.history, d.tags, req.params.id, req.user.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  res.json(result.rows[0]);
}));

app.delete('/api/universes/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM universes WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  res.status(204).end();
}));

app.get('/api/universes/:id/theme', asyncRoute(async (req, res) => {
  const universe = await pool.query('SELECT id FROM universes WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
  if (!universe.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  const result = await pool.query('SELECT * FROM universe_themes WHERE universe_id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
  res.json(result.rows[0] || { universe_id: Number(req.params.id), owner_id: req.user.id, ...themeDefaults });
}));

app.put('/api/universes/:id/theme', asyncRoute(async (req, res) => {
  const parsed = themeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los ajustes visuales.', details: z.flattenError(parsed.error) });
  const universe = await pool.query('SELECT id FROM universes WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
  if (!universe.rowCount) return res.status(404).json({ error: 'Universo no encontrado.' });
  const d = parsed.data;
  const result = await pool.query(
    `INSERT INTO universe_themes (universe_id, owner_id, prompt, page_bg, panel_bg, ink, muted, line, accent, sidebar_bg, heading_font, texture, corner)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (universe_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, prompt=EXCLUDED.prompt,
       page_bg=EXCLUDED.page_bg, panel_bg=EXCLUDED.panel_bg, ink=EXCLUDED.ink, muted=EXCLUDED.muted,
       line=EXCLUDED.line, accent=EXCLUDED.accent, sidebar_bg=EXCLUDED.sidebar_bg,
       heading_font=EXCLUDED.heading_font, texture=EXCLUDED.texture, corner=EXCLUDED.corner, updated_at=CURRENT_TIMESTAMP
     RETURNING *`,
    [Number(req.params.id), req.user.id, d.prompt, d.page_bg, d.panel_bg, d.ink, d.muted, d.line, d.accent, d.sidebar_bg, d.heading_font, d.texture, d.corner],
  );
  res.json(result.rows[0]);
}));

const characterSelect = `SELECT c.*, u.name AS universe_name, u.color AS universe_color
  FROM characters c LEFT JOIN universes u ON u.id = c.universe_id AND u.owner_id = c.owner_id`;
app.get('/api/characters', asyncRoute(async (req, res) => {
  const { q = '', universe = '', gender = '', species = '', status = '', origin = '', residence = '', tag = '' } = req.query;
  const values = [req.user.id];
  const filters = ['c.owner_id = $1'];
  const add = (sql, value) => { values.push(value); filters.push(sql.replace('?', `$${values.length}`)); };
  if (q) {
    const start = values.length + 1, term = `%${q}%`;
    values.push(term, term, term, term, term);
    filters.push(`(c.name ILIKE $${start} OR c.alias ILIKE $${start + 1} OR c.description ILIKE $${start + 2} OR c.biography ILIKE $${start + 3} OR c.tags ILIKE $${start + 4})`);
  }
  if (universe) {
    const id = Number(universe);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'El filtro de universo no es válido.' });
    add('c.universe_id = ?', id);
  }
  for (const [value, column] of [[gender, 'c.gender'], [species, 'c.species'], [status, 'c.status'], [origin, 'c.origin'], [residence, 'c.residence']]) if (value) add(`${column} = ?`, value);
  if (tag) add('c.tags ILIKE ?', `%${tag}%`);
  const result = await pool.query(`${characterSelect} WHERE ${filters.join(' AND ')} ORDER BY c.updated_at DESC, c.id DESC`, values);
  res.json(result.rows);
}));

app.post('/api/characters', asyncRoute(async (req, res) => {
  const parsed = characterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del personaje.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  if (!(await ownedUniverse(req.user.id, d.universe_id))) return res.status(400).json({ error: 'El universo no existe en tu archivo.' });
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO characters (owner_id, universe_id, name, alias, pronouns, gender, species, origin, residence, occupation, status, powers, tags, description, biography, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
     ) SELECT inserted.*, u.name AS universe_name, u.color AS universe_color FROM inserted
       LEFT JOIN universes u ON u.id=inserted.universe_id AND u.owner_id=inserted.owner_id`,
    [req.user.id, d.universe_id || null, d.name, d.alias, d.pronouns, d.gender, d.species, d.origin, d.residence, d.occupation, d.status, d.powers, d.tags, d.description, d.biography, d.details],
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/characters/:id', asyncRoute(async (req, res) => {
  const parsed = characterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los campos del personaje.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  if (!(await ownedUniverse(req.user.id, d.universe_id))) return res.status(400).json({ error: 'El universo no existe en tu archivo.' });
  const result = await pool.query(
    `WITH updated AS (
       UPDATE characters SET universe_id=$1, name=$2, alias=$3, pronouns=$4, gender=$5, species=$6, origin=$7,
         residence=$8, occupation=$9, status=$10, powers=$11, tags=$12, description=$13, biography=$14,
         details=$15, updated_at=CURRENT_TIMESTAMP WHERE id=$16 AND owner_id=$17 RETURNING *
     ) SELECT updated.*, u.name AS universe_name, u.color AS universe_color FROM updated
       LEFT JOIN universes u ON u.id=updated.universe_id AND u.owner_id=updated.owner_id`,
    [d.universe_id || null, d.name, d.alias, d.pronouns, d.gender, d.species, d.origin, d.residence, d.occupation, d.status, d.powers, d.tags, d.description, d.biography, d.details, req.params.id, req.user.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Personaje no encontrado.' });
  res.json(result.rows[0]);
}));

app.delete('/api/characters/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM characters WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Personaje no encontrado.' });
  res.status(204).end();
}));

app.get('/api/entries', asyncRoute(async (req, res) => {
  const values = [req.user.id];
  const filters = ['e.owner_id=$1'];
  const add = (sql, value) => { values.push(value); filters.push(sql.replace('?', `$${values.length}`)); };
  if (req.query.kind) add('e.kind = ?', String(req.query.kind));
  if (req.query.universe) add('e.universe_id = ?', Number(req.query.universe));
  if (req.query.parent) add('e.parent_id = ?', Number(req.query.parent));
  if (req.query.q) {
    values.push(`%${req.query.q}%`);
    filters.push(`(e.name ILIKE $${values.length} OR e.description ILIKE $${values.length} OR e.data::text ILIKE $${values.length})`);
  }
  if (req.query.tag) add('? = ANY(e.tags)', String(req.query.tag));
  const result = await pool.query(
    `SELECT e.*, u.name AS universe_name, p.name AS parent_name
     FROM archive_entries e
     LEFT JOIN universes u ON u.id=e.universe_id AND u.owner_id=e.owner_id
     LEFT JOIN archive_entries p ON p.id=e.parent_id AND p.owner_id=e.owner_id
     WHERE ${filters.join(' AND ')} ORDER BY e.updated_at DESC, e.id DESC`, values,
  );
  res.json(result.rows);
}));

app.get('/api/entries/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM archive_entries WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Elemento no encontrado.' });
  res.json(result.rows[0]);
}));

app.post('/api/entries', asyncRoute(async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los datos del elemento.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  if (!(await ownedUniverse(req.user.id, d.universe_id)) || !(await ownedEntry(req.user.id, d.parent_id))) return res.status(400).json({ error: 'El universo o elemento superior no pertenece a tu archivo.' });
  const result = await pool.query(
    `INSERT INTO archive_entries (owner_id, universe_id, parent_id, kind, name, description, tags, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id, d.universe_id || null, d.parent_id || null, d.kind, d.name, d.description, d.tags, d.data],
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/entries/:id', asyncRoute(async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los datos del elemento.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  if (!(await ownedUniverse(req.user.id, d.universe_id)) || !(await ownedEntry(req.user.id, d.parent_id))) return res.status(400).json({ error: 'El universo o elemento superior no pertenece a tu archivo.' });
  const result = await pool.query(
    `UPDATE archive_entries SET universe_id=$1, parent_id=$2, kind=$3, name=$4, description=$5, tags=$6, data=$7, updated_at=CURRENT_TIMESTAMP
     WHERE id=$8 AND owner_id=$9 RETURNING *`,
    [d.universe_id || null, d.parent_id || null, d.kind, d.name, d.description, d.tags, d.data, req.params.id, req.user.id],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Elemento no encontrado.' });
  res.json(result.rows[0]);
}));

app.delete('/api/entries/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM archive_entries WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Elemento no encontrado.' });
  res.status(204).end();
}));

app.get('/api/entries/:id/links', asyncRoute(async (req, res) => {
  const owned = await ownedEntry(req.user.id, req.params.id);
  if (!owned) return res.status(404).json({ error: 'Elemento no encontrado.' });
  const result = await pool.query(
    `SELECT l.*, t.name AS target_entry_name, c.name AS target_character_name
     FROM entry_links l
     LEFT JOIN archive_entries t ON t.id=l.target_entry_id AND t.owner_id=l.owner_id
     LEFT JOIN characters c ON c.id=l.target_character_id AND c.owner_id=l.owner_id
     WHERE l.owner_id=$1 AND l.source_entry_id=$2 ORDER BY l.created_at DESC`, [req.user.id, req.params.id],
  );
  res.json(result.rows);
}));

app.post('/api/entries/:id/links', asyncRoute(async (req, res) => {
  const schema = z.object({ target_type: z.enum(['entry', 'character']), target_id: z.coerce.number().int().positive(), relation_type: z.string().trim().min(1).max(80), description: z.string().max(3000).optional().default(''), details: z.record(z.string(), z.unknown()).optional().default({}) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá la relación.' });
  if (!(await ownedEntry(req.user.id, req.params.id))) return res.status(404).json({ error: 'Elemento no encontrado.' });
  const target = parsed.data.target_type === 'entry'
    ? await ownedEntry(req.user.id, parsed.data.target_id)
    : (await pool.query('SELECT id FROM characters WHERE id=$1 AND owner_id=$2', [parsed.data.target_id, req.user.id])).rowCount > 0;
  if (!target) return res.status(404).json({ error: 'El destino no existe en tu archivo.' });
  const result = await pool.query(
    `INSERT INTO entry_links (owner_id, source_entry_id, target_entry_id, target_character_id, relation_type, description, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id, req.params.id, parsed.data.target_type === 'entry' ? parsed.data.target_id : null, parsed.data.target_type === 'character' ? parsed.data.target_id : null, parsed.data.relation_type, parsed.data.description, parsed.data.details],
  );
  res.status(201).json(result.rows[0]);
}));

app.delete('/api/entry-links/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM entry_links WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Relación no encontrada.' });
  res.status(204).end();
}));

app.get('/api/relationships', asyncRoute(async (req, res) => {
  const values = [req.user.id];
  let filter = 'r.owner_id=$1';
  if (req.query.character_id) {
    values.push(Number(req.query.character_id));
    filter += ` AND (r.source_character_id=$${values.length} OR r.target_character_id=$${values.length})`;
  }
  const result = await pool.query(
    `SELECT r.*, s.name AS source_name, t.name AS target_name
     FROM character_relationships r
     JOIN characters s ON s.id=r.source_character_id AND s.owner_id=r.owner_id
     JOIN characters t ON t.id=r.target_character_id AND t.owner_id=r.owner_id
     WHERE ${filter} ORDER BY r.updated_at DESC, r.id DESC`, values,
  );
  res.json(result.rows);
}));

app.post('/api/relationships', asyncRoute(async (req, res) => {
  const parsed = relationshipSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los datos de la relación.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  const characters = await pool.query('SELECT id FROM characters WHERE owner_id=$1 AND id = ANY($2::int[])', [req.user.id, [d.source_character_id, d.target_character_id]]);
  if (characters.rowCount !== 2) return res.status(404).json({ error: 'Ambos personajes deben pertenecer a tu archivo.' });
  const result = await pool.query(
    `INSERT INTO character_relationships (owner_id, source_character_id, target_character_id, relation_type, status, description, dynamics, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id, d.source_character_id, d.target_character_id, d.relation_type, d.status, d.description, d.dynamics, d.details],
  );
  res.status(201).json(result.rows[0]);
}));

app.delete('/api/relationships/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM character_relationships WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Relación no encontrada.' });
  res.status(204).end();
}));

app.get('/api/favorites', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT f.id AS favorite_id, 'universe' AS entity_type, u.id AS entity_id, u.name, u.description, f.created_at
       FROM favorites f JOIN universes u ON u.id=f.universe_id AND u.owner_id=f.owner_id WHERE f.owner_id=$1
     UNION ALL
     SELECT f.id, 'character', c.id, c.name, c.description, f.created_at
       FROM favorites f JOIN characters c ON c.id=f.character_id AND c.owner_id=f.owner_id WHERE f.owner_id=$1
     UNION ALL
     SELECT f.id, e.kind, e.id, e.name, e.description, f.created_at
       FROM favorites f JOIN archive_entries e ON e.id=f.entry_id AND e.owner_id=f.owner_id WHERE f.owner_id=$1
     ORDER BY created_at DESC`, [req.user.id],
  );
  res.json(result.rows);
}));

app.post('/api/favorites', asyncRoute(async (req, res) => {
  const parsed = z.object({ entity_type: z.enum(['universe', 'character', 'entry']), entity_id: z.coerce.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Elemento favorito no válido.' });
  const { entity_type, entity_id } = parsed.data;
  const table = { universe: 'universes', character: 'characters', entry: 'archive_entries' }[entity_type];
  const owned = await pool.query(`SELECT id FROM ${table} WHERE id=$1 AND owner_id=$2`, [entity_id, req.user.id]);
  if (!owned.rowCount) return res.status(404).json({ error: 'Elemento no encontrado.' });
  const column = { universe: 'universe_id', character: 'character_id', entry: 'entry_id' }[entity_type];
  const result = await pool.query(`INSERT INTO favorites (owner_id, ${column}) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *`, [req.user.id, entity_id]);
  res.status(201).json(result.rows[0] || { owner_id: req.user.id, entity_type, entity_id, already_favorite: true });
}));

app.delete('/api/favorites/:entityType/:entityId', asyncRoute(async (req, res) => {
  const column = { universe: 'universe_id', character: 'character_id', entry: 'entry_id' }[req.params.entityType];
  if (!column) return res.status(400).json({ error: 'Tipo de favorito no válido.' });
  await pool.query(`DELETE FROM favorites WHERE owner_id=$1 AND ${column}=$2`, [req.user.id, req.params.entityId]);
  res.status(204).end();
}));

app.get('/api/search', asyncRoute(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json([]);
  const term = `%${query}%`;
  const result = await pool.query(
    `SELECT * FROM (
       SELECT 'character' AS entity_type, id, name, description, universe_id, updated_at FROM characters WHERE owner_id=$1 AND (name ILIKE $2 OR alias ILIKE $2 OR description ILIKE $2 OR tags ILIKE $2 OR details::text ILIKE $2)
       UNION ALL
       SELECT 'universe', id, name, description, id AS universe_id, updated_at FROM universes WHERE owner_id=$1 AND (name ILIKE $2 OR description ILIKE $2 OR lore ILIKE $2 OR history ILIKE $2)
       UNION ALL
       SELECT kind, id, name, description, universe_id, updated_at FROM archive_entries WHERE owner_id=$1 AND (name ILIKE $2 OR description ILIKE $2 OR array_to_string(tags, ',') ILIKE $2 OR data::text ILIKE $2)
     ) results ORDER BY updated_at DESC LIMIT 60`, [req.user.id, term],
  );
  res.json(result.rows);
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const [universes, characters, entries, recent, favorites, settings] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM universes WHERE owner_id=$1', [req.user.id]),
    pool.query('SELECT COUNT(*)::int AS count FROM characters WHERE owner_id=$1', [req.user.id]),
    pool.query('SELECT COUNT(*)::int AS count FROM archive_entries WHERE owner_id=$1', [req.user.id]),
    pool.query(`SELECT id, kind, name, description, updated_at FROM archive_entries WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 6`, [req.user.id]),
    pool.query(`SELECT c.id, c.name, c.description, c.updated_at, 'character' AS kind FROM favorites f JOIN characters c ON c.id=f.character_id AND c.owner_id=f.owner_id WHERE f.owner_id=$1 ORDER BY f.created_at DESC LIMIT 6`, [req.user.id]),
    pool.query('SELECT dashboard_widgets FROM user_settings WHERE user_id=$1', [req.user.id]),
  ]);
  res.json({ counts: { universes: universes.rows[0].count, characters: characters.rows[0].count, entries: entries.rows[0].count }, recent: recent.rows, favorites: favorites.rows, widgets: settings.rows[0]?.dashboard_widgets || ['stats', 'recent', 'favorites'] });
}));

app.put('/api/dashboard/widgets', asyncRoute(async (req, res) => {
  const parsed = z.object({ widgets: z.array(z.enum(['stats', 'recent', 'favorites', 'quick-actions'])).max(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'La disposición del panel no es válida.' });
  const result = await pool.query(
    `INSERT INTO user_settings (user_id, dashboard_widgets) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET dashboard_widgets=EXCLUDED.dashboard_widgets, updated_at=CURRENT_TIMESTAMP RETURNING dashboard_widgets`,
    [req.user.id, parsed.data.widgets],
  );
  res.json({ widgets: result.rows[0].dashboard_widgets });
}));

app.get('/api/appearance', asyncRoute(async (req, res) => {
  const parsed = z.object({ scope_type: appearanceSchema.shape.scope_type, scope_id: z.string().optional().default('global') }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'El alcance visual no es válido.' });
  const result = await pool.query('SELECT * FROM appearance_settings WHERE owner_id=$1 AND scope_type=$2 AND scope_id=$3', [req.user.id, parsed.data.scope_type, parsed.data.scope_id]);
  res.json(result.rows[0] || { owner_id: req.user.id, scope_type: parsed.data.scope_type, scope_id: parsed.data.scope_id, prompt: '', tokens: {} });
}));

app.put('/api/appearance', asyncRoute(async (req, res) => {
  const parsed = appearanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá la apariencia.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  if (d.scope_type === 'universe' && !(await ownedUniverse(req.user.id, d.scope_id))) return res.status(404).json({ error: 'Universo no encontrado.' });
  if (d.scope_type === 'entry' && !(await ownedEntry(req.user.id, d.scope_id))) return res.status(404).json({ error: 'Elemento no encontrado.' });
  if (d.scope_type === 'character' && !(await pool.query('SELECT id FROM characters WHERE id=$1 AND owner_id=$2', [d.scope_id, req.user.id])).rowCount) return res.status(404).json({ error: 'Personaje no encontrado.' });
  const result = await pool.query(
    `INSERT INTO appearance_settings (owner_id, scope_type, scope_id, prompt, tokens) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_id,scope_type,scope_id) DO UPDATE SET prompt=EXCLUDED.prompt, tokens=EXCLUDED.tokens, updated_at=CURRENT_TIMESTAMP RETURNING *`,
    [req.user.id, d.scope_type, d.scope_id, d.prompt, d.tokens],
  );
  res.json(result.rows[0]);
}));

app.get('/api/content-types', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM content_types WHERE owner_id=$1 ORDER BY label', [req.user.id]);
  res.json(result.rows);
}));

app.post('/api/content-types', asyncRoute(async (req, res) => {
  const parsed = contentTypeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ingresá un nombre de sección válido.' });
  const slug = parsed.data.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const result = await pool.query('INSERT INTO content_types (owner_id,slug,label,icon) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.id, slug, parsed.data.label, parsed.data.icon]);
  res.status(201).json(result.rows[0]);
}));

app.delete('/api/content-types/:id', asyncRoute(async (req, res) => {
  const type = await pool.query('SELECT slug FROM content_types WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
  if (!type.rowCount) return res.status(404).json({ error: 'Sección personalizada no encontrada.' });
  const entries = await pool.query('SELECT COUNT(*)::int AS count FROM archive_entries WHERE owner_id=$1 AND kind=$2', [req.user.id, type.rows[0].slug]);
  if (entries.rows[0].count) return res.status(409).json({ error: 'La sección todavía tiene elementos. Eliminá o mové sus elementos primero.' });
  await pool.query('DELETE FROM content_types WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
  res.status(204).end();
}));

app.get('/api/media', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM media_assets WHERE owner_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json(result.rows);
}));

app.post('/api/media', asyncRoute(async (req, res) => {
  const parsed = mediaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Revisá los datos de la imagen.', details: z.flattenError(parsed.error) });
  const d = parsed.data;
  const owned = d.entity_type === 'entry' ? await ownedEntry(req.user.id, d.entity_id) : (await pool.query('SELECT id FROM characters WHERE id=$1 AND owner_id=$2', [d.entity_id, req.user.id])).rowCount > 0;
  if (!owned) return res.status(404).json({ error: 'El elemento no existe en tu archivo.' });
  const result = await pool.query(
    `INSERT INTO media_assets (owner_id, character_id, entry_id, image_url, caption, alt_text, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id, d.entity_type === 'character' ? d.entity_id : null, d.entity_type === 'entry' ? d.entity_id : null, d.image_url, d.caption, d.alt_text, d.tags],
  );
  res.status(201).json(result.rows[0]);
}));

app.delete('/api/media/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM media_assets WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Imagen no encontrada.' });
  res.status(204).end();
}));

app.use((err, _req, res, _next) => {
  console.error('API request failed:', err.message);
  if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con esos datos.' });
  if (err.code === '23503') return res.status(400).json({ error: 'La entidad relacionada no existe en tu archivo.' });
  if (err.code === '22P02' || err.code === '22003') return res.status(400).json({ error: 'El identificador no es válido.' });
  res.status(500).json({ error: 'Ocurrió un error inesperado.' });
});

const port = Number(process.env.PORT || 3001);
await initializeDatabase();
const server = app.listen(port, '0.0.0.0', () => console.log(`OC Archive API listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
