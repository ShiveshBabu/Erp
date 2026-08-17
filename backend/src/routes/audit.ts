import { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query } from '../lib/db';

// Deliberately: this file contains ONLY a GET route. There is no PATCH or
// DELETE endpoint for audit logs anywhere in the API, and the database
// role backing this connection has no UPDATE/DELETE grant on audit_logs
// either (enforced at the Postgres level, verified live — see the final
// report). Both layers independently make audit tampering impossible.
export default async function auditRoutes(app: FastifyInstance) {
  app.get('/api/v1/audit', { preHandler: [requireAuth, requirePermission('audit.view')] }, async (req, reply) => {
    const { limit = '100' } = req.query as { limit?: string };
    const { rows } = await query(
      `SELECT al.*, u.name AS "userName" FROM audit_logs al LEFT JOIN users u ON u.id = al."userId"
       ORDER BY al."createdAt" DESC LIMIT $1`,
      [Math.min(Number(limit) || 100, 500)]
    );
    return reply.send({ success: true, data: rows });
  });
}
