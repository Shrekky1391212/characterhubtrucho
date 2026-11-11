import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqliteFile = resolve(process.env.SQLITE_FILE || resolve(here, '../data/archive.sqlite'));

if (!existsSync(sqliteFile)) {
  throw new Error(`SQLite source file not found: ${sqliteFile}. Set SQLITE_FILE to its path.`);
}

const source = new DatabaseSync(sqliteFile, { readOnly: true });
const tables = [
  {
    table: 'universes',
    columns: ['id', 'name', 'description', 'genre', 'tone', 'color', 'created_at', 'updated_at'],
  },
  {
    table: 'characters',
    columns: ['id', 'universe_id', 'name', 'alias', 'pronouns', 'gender', 'species', 'origin', 'residence', 'occupation', 'status', 'powers', 'tags', 'description', 'biography', 'created_at', 'updated_at'],
  },
  {
    table: 'universe_themes',
    columns: ['universe_id', 'prompt', 'page_bg', 'panel_bg', 'ink', 'muted', 'line', 'accent', 'sidebar_bg', 'heading_font', 'texture', 'corner', 'updated_at'],
  },
];

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function migrate() {
  let client;
  let transactionOpen = false;
  try {
    await initializeDatabase();
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const destination = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM universes) AS universes,
        (SELECT COUNT(*) FROM characters) AS characters,
        (SELECT COUNT(*) FROM universe_themes) AS themes`);
    const existing = Object.values(destination.rows[0]).reduce((sum, count) => sum + Number(count), 0);
    if (existing > 0) {
      throw new Error('The Neon destination is not empty. Migration stopped to avoid overwriting existing records. Use a fresh database or merge the data manually.');
    }

    const totals = {};
    for (const { table, columns } of tables) {
      const rows = source.prepare(`SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(columns[0])}`).all();
      totals[table] = rows.length;
      if (!rows.length) continue;

      const names = columns.map(quoteIdentifier).join(', ');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const insert = `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`;
      for (const row of rows) await client.query(insert, columns.map(column => row[column]));
    }

    for (const table of ['universes', 'characters']) {
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence($1, 'id'),
          COALESCE((SELECT MAX(id) FROM ${quoteIdentifier(table)}), 1),
          EXISTS (SELECT 1 FROM ${quoteIdentifier(table)})
        )`, [table]);
    }

    await client.query('COMMIT');
    transactionOpen = false;
    console.log(`Migration completed: ${totals.universes} universes, ${totals.characters} characters, ${totals.universe_themes} themes.`);
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    source.close();
    await pool.end();
  }
}

await migrate();
