import { readdir, readFile } from 'node:fs/promises';
import { pool } from './db.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrations = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();

for (const migration of migrations) {
  const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
  await pool.query(sql);
}

await pool.end();
