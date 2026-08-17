import { Pool, PoolClient } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle PostgreSQL client', err);
});

export async function query<T = any>(text: string, params: any[] = []): Promise<{ rows: T[]; rowCount: number }> {
  const result = await pool.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/**
 * Run `fn` inside a single PostgreSQL transaction. Commits on success,
 * rolls back on any thrown error — this is the mechanism every
 * multi-step business operation (invoice creation, production
 * completion, transfers, etc.) is required to use per the frozen
 * transaction-boundary rules.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export default pool;
