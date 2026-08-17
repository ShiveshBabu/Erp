import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query, withTransaction } from '../lib/db';
import { newId } from '../lib/id';

const expenseSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  warehouseId: z.string().optional(),
  employee: z.string().optional(),
  notes: z.string().optional()
});

export default async function expenseRoutes(app: FastifyInstance) {
  app.get('/api/v1/expenses', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM expenses ORDER BY date DESC`);
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/expenses', { preHandler: [requireAuth, requirePermission('expense.manage')] }, async (req, reply) => {
    const body = expenseSchema.parse(req.body);
    const result = await withTransaction(async (client) => {
      const { rows: seqRows } = await client.query<{ nextvalue: string }>(
        `INSERT INTO sequences (name, "nextValue") VALUES ('expense', 2)
         ON CONFLICT (name) DO UPDATE SET "nextValue" = sequences."nextValue" + 1 RETURNING "nextValue" - 1 AS nextvalue`
      );
      const number = `EXP-${String(seqRows[0]!.nextvalue).padStart(4, '0')}`;
      const id = newId('exp');
      await client.query(
        `INSERT INTO expenses (id, number, category, description, amount, method, "warehouseId", employee, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, number, body.category, body.description, body.amount, body.method, body.warehouseId ?? null, body.employee ?? null, body.notes ?? null]
      );
      return { id, number };
    });
    return reply.status(201).send({ success: true, data: result });
  });
}
