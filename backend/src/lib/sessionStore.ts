import { query } from './db';

export interface SessionData {
  userId?: string;
  roleCode?: string;
  loginAt?: number;
  lastSeenAt?: number;
}

/**
 * Minimal server-side session store backed by our own `sessions` table.
 * (connect-pg-simple assumes an Express-style `connect` Store interface;
 * rather than shim that onto Fastify, this implements exactly the three
 * operations @fastify/session's SessionStore interface needs — get, set,
 * destroy — directly against Postgres. Same security properties: nothing
 * about the session lives in the cookie except an opaque, signed ID.)
 */
export class PgSessionStore {
  async get(sid: string, cb: (err: any, session?: any) => void): Promise<void> {
    try {
      const { rows } = await query<{ data: SessionData; expires_at: string }>(
        'SELECT data, expires_at FROM sessions WHERE sid = $1',
        [sid]
      );
      const row = rows[0];
      if (!row) return cb(null, null);
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, row.data);
    } catch (err) {
      cb(err);
    }
  }

  async set(sid: string, session: any, cb: (err?: any) => void): Promise<void> {
    try {
      const maxAgeMs = Number(process.env.SESSION_MAX_AGE_MS ?? 28_800_000);
      const expiresAt = new Date(Date.now() + maxAgeMs);
      await query(
        `INSERT INTO sessions (sid, data, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET data = $2, expires_at = $3`,
        [sid, JSON.stringify(session), expiresAt]
      );
      cb();
    } catch (err) {
      cb(err);
    }
  }

  async destroy(sid: string, cb: (err?: any) => void): Promise<void> {
    try {
      await query('DELETE FROM sessions WHERE sid = $1', [sid]);
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

/** Periodic sweep of expired sessions — call once at server startup. */
export function startSessionSweeper(intervalMs = 15 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    query('DELETE FROM sessions WHERE expires_at < now()').catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Session sweep failed', err);
    });
  }, intervalMs);
}
