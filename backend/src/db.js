import pg from 'pg';

const { Pool, types } = pg;

// PostgreSQL DATE is a calendar day, not a moment in time. The default parser
// turns it into a JavaScript Date, which serializes as an ISO timestamp and is
// invalid when assigned to `<input type="date">` or combined with a time again.
// Keep DATE values in their native YYYY-MM-DD form throughout the API.
types.setTypeParser(1082, value => value);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
