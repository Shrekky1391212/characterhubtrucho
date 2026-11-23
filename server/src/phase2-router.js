import express from 'express';
import { z } from 'zod';
import { getContentItem, getContentItemBySource, listContentItems } from './phase2-content-service.js';

const idSchema = z.coerce.number().int().positive();
const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(40);
const fieldsSchema = z.array(z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'textarea', 'number', 'date', 'url', 'select', 'checkbox', 'tags']),
  required: z.boolean().optional(),
  options: z.array(z.string().max(100)).max(100).optional(),
}).strict()).max(100).superRefine((fields, ctx) => {
  const keys = new Set();
  fields.forEach((field, index) => {
    if (keys.has(field.key)) ctx.addIssue({ code: 'custom', path: [index, 'key'], message: 'La clave del campo debe ser única.' });
    keys.add(field.key);
    if (field.type === 'select' && !field.options) ctx.addIssue({ code: 'custom', path: [index, 'options'], message: 'Los campos select requieren opciones.' });
  });
});
const groupSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(10000).optional().default(''),
  image_url: z.union([z.literal(''), z.url()]).optional().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#9b845c'),
  tags: tagsSchema.optional().default([]),
  sort_order: z.coerce.number().int().min(-100000).max(100000).optional().default(0),
  space_type: z.enum(['account', 'universe']).optional(),
  universe_id: idSchema.nullable().optional(),
  parent_group_id: idSchema.nullable().optional().default(null),
});
const groupUpdateSchema = groupSchema.partial().omit({ space_type: true, universe_id: true, parent_group_id: true });
const typeCreateSchema = z.object({
  label: z.string().trim().min(1).max(60),
  icon: z.string().trim().min(1).max(50).optional().default('archive'),
  field_schema: fieldsSchema.optional().default([]),
}).superRefine((data, ctx) => {
  if (!slugFor(data.label)) ctx.addIssue({ code: 'custom', path: ['label'], message: 'El nombre debe incluir letras o números.' });
});
const typeUpdateSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().min(1).max(50).optional(),
  field_schema: fieldsSchema.optional(),
  sort_order: z.coerce.number().int().min(-100000).max(100000).optional(),
});

const fail = (status, error, code) => Object.assign(new Error(error), { status, publicCode: code });
const slugFor = value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function respondError(error, res) {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Los datos enviados no son válidos.', code: 'VALIDATION_ERROR', details: z.flattenError(error) });
  if (error.status) return res.status(error.status).json({ error: error.message, code: error.publicCode });
  if (error.code === '42P01') return res.status(503).json({ error: 'El esquema v2 todavía no está instalado en esta base.', code: 'PHASE2_SCHEMA_NOT_INSTALLED' });
  if (['23503', '23505', '23514'].includes(error.code)) return res.status(409).json({ error: error.message, code: 'CONTENT_CONFLICT' });
  console.error('Phase 2 API request failed:', error.message);
  return res.status(500).json({ error: 'No se pudo completar la operación.', code: 'PHASE2_API_ERROR' });
}

async function requireSchema(pool, _req, res, next) {
  try {
    const result = await pool.query(`SELECT to_regclass('public.content_items') IS NOT NULL AS items,
      to_regclass('public.content_groups') IS NOT NULL AS groups,
      to_regclass('public.content_group_items') IS NOT NULL AS memberships,
      to_regclass('public.content_type_configs') IS NOT NULL AS configs`);
    if (Object.values(result.rows[0]).some(value => !value)) return res.status(503).json({ error: 'La API v2 no está habilitada en esta base.', code: 'PHASE2_SCHEMA_NOT_INSTALLED' });
    next();
  } catch (error) { respondError(error, res); }
}

export function createPhase2Router(pool) {
  const router = express.Router();
  router.use(requireSchema.bind(null, pool));

  // Canonical IDs refer only to content_items. Legacy identities use an
  // explicit table + source id so overlapping character/entry ids stay unique.
  router.get('/content-items', async (req, res) => {
    try {
      const filters = z.object({ type: z.string().max(48).optional(), scope: z.enum(['universe', 'global', 'pending']).optional(), universe_id: idSchema.optional() }).parse(req.query);
      res.json(await listContentItems(pool, req.user.id, { type: filters.type, scope: filters.scope, universeId: filters.universe_id }));
    } catch (error) { respondError(error, res); }
  });
  router.get('/content-items/source/:sourceTable/:sourceId', async (req, res) => {
    try {
      const table = z.enum(['characters', 'archive_entries']).parse(req.params.sourceTable);
      const item = await getContentItemBySource(pool, req.user.id, table, idSchema.parse(req.params.sourceId));
      if (!item) return res.status(404).json({ error: 'Elemento no encontrado.', code: 'CONTENT_NOT_FOUND' });
      res.json(item);
    } catch (error) { respondError(error, res); }
  });

  router.get('/groups', async (req, res) => {
    try {
      const filter = z.object({ space_type: z.enum(['account', 'universe']).optional(), universe_id: idSchema.optional() }).parse(req.query);
      const result = await pool.query(
        `SELECT * FROM content_groups WHERE owner_id=$1 AND ($2::text IS NULL OR space_type=$2)
         AND ($3::int IS NULL OR universe_id=$3) ORDER BY sort_order,id`,
        [req.user.id, filter.space_type ?? null, filter.universe_id ?? null],
      );
      res.json(result.rows);
    } catch (error) { respondError(error, res); }
  });
  router.post('/groups', async (req, res) => {
    try {
      const data = groupSchema.parse(req.body);
      const group = await transaction(pool, async client => {
        let space = data.space_type;
        let universeId = data.universe_id ?? null;
        if (data.parent_group_id !== null) {
          const parent = await client.query('SELECT space_type,universe_id FROM content_groups WHERE id=$1 AND owner_id=$2', [data.parent_group_id, req.user.id]);
          if (!parent.rowCount) throw fail(404, 'Grupo padre no encontrado.', 'GROUP_NOT_FOUND');
          if ((space && space !== parent.rows[0].space_type) || (universeId !== null && universeId !== parent.rows[0].universe_id)) throw fail(400, 'El subgrupo hereda el espacio de su grupo padre.', 'GROUP_SPACE_MISMATCH');
          space = parent.rows[0].space_type;
          universeId = parent.rows[0].universe_id;
        }
        if (!space) space = universeId === null ? 'account' : 'universe';
        if ((space === 'account' && universeId !== null) || (space === 'universe' && universeId === null)) throw fail(400, 'Espacio y universo incompatibles.', 'GROUP_SPACE_MISMATCH');
        if (universeId !== null && !(await client.query('SELECT id FROM universes WHERE id=$1 AND owner_id=$2', [universeId, req.user.id])).rowCount) throw fail(404, 'Universo no encontrado.', 'UNIVERSE_NOT_FOUND');
        const result = await client.query(
          `INSERT INTO content_groups(owner_id,space_type,universe_id,parent_group_id,name,description,image_url,color,tags,sort_order)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [req.user.id, space, universeId, data.parent_group_id, data.name, data.description, data.image_url, data.color, data.tags, data.sort_order],
        );
        return result.rows[0];
      });
      res.status(201).json(group);
    } catch (error) { respondError(error, res); }
  });
  router.get('/groups/:id', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM content_groups WHERE owner_id=$1 AND id=$2', [req.user.id, idSchema.parse(req.params.id)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Grupo no encontrado.', code: 'GROUP_NOT_FOUND' });
      res.json(result.rows[0]);
    } catch (error) { respondError(error, res); }
  });
  router.patch('/groups/:id/move', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id);
      const data = z.object({ parent_group_id: idSchema.nullable(), space_type: z.enum(['account', 'universe']).optional(), universe_id: idSchema.nullable().optional() }).parse(req.body);
      const group = await transaction(pool, async client => {
        const current = await client.query('SELECT * FROM content_groups WHERE owner_id=$1 AND id=$2 FOR UPDATE', [req.user.id, id]);
        if (!current.rowCount) throw fail(404, 'Grupo no encontrado.', 'GROUP_NOT_FOUND');
        let space = data.space_type ?? current.rows[0].space_type;
        let universeId = data.universe_id === undefined ? current.rows[0].universe_id : data.universe_id;
        if (data.parent_group_id !== null) {
          const parent = await client.query('SELECT * FROM content_groups WHERE owner_id=$1 AND id=$2 FOR UPDATE', [req.user.id, data.parent_group_id]);
          if (!parent.rowCount) throw fail(404, 'Grupo padre no encontrado.', 'GROUP_NOT_FOUND');
          if (parent.rows[0].id === id) throw fail(400, 'Un grupo no puede ser su propio padre.', 'GROUP_CYCLE');
          if ((data.space_type && data.space_type !== parent.rows[0].space_type) || (data.universe_id !== undefined && data.universe_id !== parent.rows[0].universe_id)) throw fail(400, 'El subgrupo hereda el espacio de su padre.', 'GROUP_SPACE_MISMATCH');
          space = parent.rows[0].space_type;
          universeId = parent.rows[0].universe_id;
        }
        if ((space === 'account' && universeId !== null) || (space === 'universe' && universeId === null)) throw fail(400, 'Espacio y universo incompatibles.', 'GROUP_SPACE_MISMATCH');
        if (universeId !== null && !(await client.query('SELECT id FROM universes WHERE owner_id=$1 AND id=$2', [req.user.id, universeId])).rowCount) throw fail(404, 'Universo no encontrado.', 'UNIVERSE_NOT_FOUND');
        const moved = await client.query('UPDATE content_groups SET parent_group_id=$1,space_type=$2,universe_id=$3,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$4 AND id=$5 RETURNING *', [data.parent_group_id, space, universeId, req.user.id, id]);
        return moved.rows[0];
      });
      res.json(group);
    } catch (error) { respondError(error, res); }
  });
  router.patch('/groups/:id/reorder', async (req, res) => {
    try {
      const data = z.object({ sort_order: z.coerce.number().int().min(-100000).max(100000) }).parse(req.body);
      const result = await pool.query('UPDATE content_groups SET sort_order=$1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$2 AND id=$3 RETURNING *', [data.sort_order, req.user.id, idSchema.parse(req.params.id)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Grupo no encontrado.', code: 'GROUP_NOT_FOUND' });
      res.json(result.rows[0]);
    } catch (error) { respondError(error, res); }
  });
  router.patch('/groups/:id', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id); const data = groupUpdateSchema.parse(req.body);
      const allowed = ['name', 'description', 'image_url', 'color', 'tags', 'sort_order'];
      const values = [req.user.id, id]; const sets = [];
      for (const key of allowed) if (data[key] !== undefined) { values.push(data[key]); sets.push(`${key}=$${values.length}`); }
      if (!sets.length) return res.status(400).json({ error: 'No hay campos para modificar.', code: 'EMPTY_UPDATE' });
      sets.push('updated_at=CURRENT_TIMESTAMP');
      const result = await pool.query(`UPDATE content_groups SET ${sets.join(',')} WHERE owner_id=$1 AND id=$2 RETURNING *`, values);
      if (!result.rowCount) return res.status(404).json({ error: 'Grupo no encontrado.', code: 'GROUP_NOT_FOUND' });
      res.json(result.rows[0]);
    } catch (error) { respondError(error, res); }
  });
  router.get('/groups/:id/items', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id);
      const group = await pool.query('SELECT id FROM content_groups WHERE owner_id=$1 AND id=$2', [req.user.id, id]);
      if (!group.rowCount) return res.status(404).json({ error: 'Grupo no encontrado.', code: 'GROUP_NOT_FOUND' });
      const result = await pool.query(`SELECT i.*,m.sort_order AS membership_order FROM content_group_items m
        JOIN content_items i ON i.owner_id=m.owner_id AND i.id=m.item_id
        WHERE m.owner_id=$1 AND m.group_id=$2 ORDER BY m.sort_order,i.id`, [req.user.id, id]);
      res.json(result.rows);
    } catch (error) { respondError(error, res); }
  });
  router.post('/groups/:id/items', async (req, res) => {
    try {
      const groupId = idSchema.parse(req.params.id);
      const data = z.object({ item_id: idSchema, sort_order: z.coerce.number().int().min(-100000).max(100000).optional().default(0) }).parse(req.body);
      const membership = await transaction(pool, async client => {
        const group = await client.query('SELECT id FROM content_groups WHERE owner_id=$1 AND id=$2', [req.user.id, groupId]);
        if (!group.rowCount) throw fail(404, 'Grupo no encontrado.', 'GROUP_NOT_FOUND');
        if (!(await getContentItem(client, req.user.id, data.item_id))) throw fail(409, 'El elemento todavía no está migrado a content_items.', 'CONTENT_ITEM_NOT_MIGRATED');
        const result = await client.query(`INSERT INTO content_group_items(owner_id,group_id,item_id,sort_order) VALUES($1,$2,$3,$4)
          ON CONFLICT(owner_id,group_id,item_id) DO UPDATE SET sort_order=EXCLUDED.sort_order RETURNING *`, [req.user.id, groupId, data.item_id, data.sort_order]);
        return result.rows[0];
      });
      res.status(201).json(membership);
    } catch (error) { respondError(error, res); }
  });
  router.delete('/groups/:id/items/:itemId', async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM content_group_items WHERE owner_id=$1 AND group_id=$2 AND item_id=$3 RETURNING id', [req.user.id, idSchema.parse(req.params.id), idSchema.parse(req.params.itemId)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Membresía no encontrada.', code: 'MEMBERSHIP_NOT_FOUND' });
      res.status(204).end();
    } catch (error) { respondError(error, res); }
  });
  router.delete('/groups/:id', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id);
      await transaction(pool, async client => {
        const group = await client.query('SELECT id FROM content_groups WHERE owner_id=$1 AND id=$2 FOR UPDATE', [req.user.id, id]);
        if (!group.rowCount) throw fail(404, 'Grupo no encontrado.', 'GROUP_NOT_FOUND');
        if ((await client.query('SELECT id FROM content_groups WHERE owner_id=$1 AND parent_group_id=$2 LIMIT 1', [req.user.id, id])).rowCount) throw fail(409, 'Resolvé primero los subgrupos.', 'GROUP_HAS_CHILDREN');
        await client.query('DELETE FROM content_groups WHERE owner_id=$1 AND id=$2', [req.user.id, id]);
      });
      res.status(204).end();
    } catch (error) { respondError(error, res); }
  });

  router.get('/content-types', async (req, res) => {
    try {
      const result = await pool.query(`SELECT t.*,COALESCE(c.sort_order,0) AS sort_order,
        COALESCE(c.field_schema,'[]'::jsonb) AS field_schema,COALESCE(c.is_active,TRUE) AS is_active,
        COALESCE(c.is_system,FALSE) AS is_system FROM content_types t
        LEFT JOIN content_type_configs c ON c.content_type_id=t.id AND c.owner_id=t.owner_id
        WHERE t.owner_id=$1 ORDER BY sort_order,t.label`, [req.user.id]);
      res.json(result.rows);
    } catch (error) { respondError(error, res); }
  });
  router.post('/content-types', async (req, res) => {
    try {
      const data = typeCreateSchema.parse(req.body);
      const type = await transaction(pool, async client => {
        const result = await client.query('INSERT INTO content_types(owner_id,slug,label,icon) VALUES($1,$2,$3,$4) RETURNING *', [req.user.id, slugFor(data.label), data.label, data.icon]);
        await client.query('INSERT INTO content_type_configs(content_type_id,owner_id,field_schema) VALUES($1,$2,$3)', [result.rows[0].id, req.user.id, JSON.stringify(data.field_schema)]);
        return result.rows[0];
      });
      res.status(201).json(type);
    } catch (error) { respondError(error, res); }
  });
  router.patch('/content-types/reorder', async (req, res) => {
    try {
      const { ids } = z.object({ ids: z.array(idSchema).min(1).max(200).superRefine((values, ctx) => {
        if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'No se permiten IDs repetidos.' });
      }) }).parse(req.body);
      const ordered = await transaction(pool, async client => {
        const owned = await client.query('SELECT id FROM content_types WHERE owner_id=$1 AND id=ANY($2::int[]) FOR UPDATE', [req.user.id, ids]);
        if (owned.rowCount !== new Set(ids).size) throw fail(404, 'Algún tipo no pertenece a tu cuenta.', 'TYPE_NOT_FOUND');
        for (const [index, id] of ids.entries()) await client.query(`INSERT INTO content_type_configs(content_type_id,owner_id,sort_order)
          VALUES($1,$2,$3) ON CONFLICT(content_type_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,updated_at=CURRENT_TIMESTAMP`, [id, req.user.id, index]);
        return ids;
      });
      res.json({ ids: ordered });
    } catch (error) { respondError(error, res); }
  });
  router.patch('/content-types/:id', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id); const data = typeUpdateSchema.parse(req.body);
      const type = await transaction(pool, async client => {
        const existing = await client.query('SELECT id FROM content_types WHERE owner_id=$1 AND id=$2 FOR UPDATE', [req.user.id, id]);
        if (!existing.rowCount) throw fail(404, 'Tipo no encontrado.', 'TYPE_NOT_FOUND');
        const updated = await client.query('UPDATE content_types SET label=COALESCE($1,label),icon=COALESCE($2,icon) WHERE owner_id=$3 AND id=$4 RETURNING *', [data.label ?? null, data.icon ?? null, req.user.id, id]);
        if (data.field_schema !== undefined || data.sort_order !== undefined) {
          const config = await client.query('SELECT field_schema,sort_order FROM content_type_configs WHERE owner_id=$1 AND content_type_id=$2 FOR UPDATE', [req.user.id, id]);
          const fields = data.field_schema === undefined ? config.rows[0]?.field_schema ?? [] : data.field_schema;
          const order = data.sort_order === undefined ? config.rows[0]?.sort_order ?? 0 : data.sort_order;
          await client.query(`INSERT INTO content_type_configs(content_type_id,owner_id,field_schema,sort_order) VALUES($1,$2,$3,$4)
            ON CONFLICT(content_type_id) DO UPDATE SET field_schema=EXCLUDED.field_schema,sort_order=EXCLUDED.sort_order,updated_at=CURRENT_TIMESTAMP`, [id, req.user.id, JSON.stringify(fields), order]);
        }
        return updated.rows[0];
      });
      res.json(type);
    } catch (error) { respondError(error, res); }
  });
  router.post('/content-types/:id/retire', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id);
      await transaction(pool, async client => {
        if (!(await client.query('SELECT id FROM content_types WHERE owner_id=$1 AND id=$2', [req.user.id, id])).rowCount) throw fail(404, 'Tipo no encontrado.', 'TYPE_NOT_FOUND');
        await client.query(`INSERT INTO content_type_configs(content_type_id,owner_id,is_active) VALUES($1,$2,FALSE)
          ON CONFLICT(content_type_id) DO UPDATE SET is_active=FALSE,updated_at=CURRENT_TIMESTAMP`, [id, req.user.id]);
      });
      res.json({ id, is_active: false });
    } catch (error) { respondError(error, res); }
  });
  router.delete('/content-types/:id', async (req, res) => {
    try {
      const id = idSchema.parse(req.params.id);
      await transaction(pool, async client => {
        const type = await client.query('SELECT id,slug FROM content_types WHERE owner_id=$1 AND id=$2 FOR UPDATE', [req.user.id, id]);
        if (!type.rowCount) throw fail(404, 'Tipo no encontrado.', 'TYPE_NOT_FOUND');
        const use = await client.query(`SELECT (SELECT count(*) FROM content_items WHERE owner_id=$1 AND content_type_id=$2)::int
          +(SELECT count(*) FROM archive_entries WHERE owner_id=$1 AND kind=$3)::int AS count`, [req.user.id, id, type.rows[0].slug]);
        if (Number(use.rows[0].count)) throw fail(409, 'El tipo conserva elementos y no puede eliminarse físicamente.', 'TYPE_IN_USE');
        await client.query('DELETE FROM content_type_configs WHERE owner_id=$1 AND content_type_id=$2', [req.user.id, id]);
        await client.query('DELETE FROM content_types WHERE owner_id=$1 AND id=$2', [req.user.id, id]);
      });
      res.status(204).end();
    } catch (error) { respondError(error, res); }
  });

  router.use((error, _req, res, _next) => respondError(error, res));
  return router;
}
