import { readdir, readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { pool } from './db.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrations = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

for (const filename of migrations) {
  const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applied = await client.query('SELECT checksum_sha256 FROM schema_migrations WHERE filename=$1 FOR UPDATE', [filename]);
    if (applied.rows[0]) {
      if (applied.rows[0].checksum_sha256 !== checksum) {
        throw new Error(`Migration ${filename} was changed after it was applied. Create a new migration instead.`);
      }
    } else {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum_sha256) VALUES ($1,$2)', [filename, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();
