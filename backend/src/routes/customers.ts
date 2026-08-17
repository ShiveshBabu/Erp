import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import { customerOutstanding } from '../services/calcService';

const customerSchema = z.object({
  name: z.string().min(1),
  subArea: z.string().optional(),
  owner: z.string().optional(),
  type: z.string().min(1),
  gstin: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  creditLimit: z.union([z.string(), z.number()]).optional()
});

export default async function customerRoutes(app: FastifyInstance) {
  app.get('/api/v1/customers', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM customers ORDER BY name`);
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/customers', { preHandler: [requireAuth, requirePermission('customer.create')] }, async (req, reply) => {
    const body = customerSchema.parse(req.body);
    const id = newId('cust');
    await query(
      `INSERT INTO customers (id, name, "subArea", owner, type, gstin, phone, email, address, "creditLimit")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, body.name, body.subArea ?? null, body.owner ?? null, body.type, body.gstin ?? null, body.phone ?? null, body.email || null, body.address ?? null, body.creditLimit ?? 0]
    );
    return reply.status(201).send({ success: true, data: { id } });
  });

  app.patch('/api/v1/customers/:id', { preHandler: [requireAuth, requirePermission('customer.edit')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = customerSchema.partial().parse(req.body);
    const { rows } = await query(`SELECT id FROM customers WHERE id = $1`, [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Customer not found.', 404);
    const fields = Object.entries(body).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return reply.send({ success: true, data: { id } });
    const setClause = fields.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
    await query(`UPDATE customers SET ${setClause} WHERE id = $1`, [id, ...fields.map(([, v]) => v)]);
    return reply.send({ success: true, data: { id } });
  });

  // Customer ledger: derived from invoices+payments at read time — not a
  // separately stored table, per the "don't duplicate business data" rule.
  app.get('/api/v1/customers/:id/ledger', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows: invoices } = await query<{ number: string; date: string; grandtotal: string }>(
      `SELECT number, date, "grandTotal"::text AS grandtotal FROM invoices WHERE "customerId" = $1 AND status != 'CANCELLED' ORDER BY date`,
      [id]
    );
    const { rows: payments } = await query<{ date: string; amount: string; method: string; invoicenumber: string }>(
      `SELECT p.date, p.amount::text, p.method, i.number AS invoicenumber
       FROM payments p JOIN invoices i ON i.id = p."invoiceId"
       WHERE i."customerId" = $1 AND p.reversed = false ORDER BY p.date`,
      [id]
    );
    const entries = [
      ...invoices.map((i) => ({ date: i.date, type: 'INVOICE' as const, ref: i.number, amount: i.grandtotal })),
      ...payments.map((p) => ({ date: p.date, type: 'PAYMENT' as const, ref: p.invoicenumber, amount: `-${p.amount}` }))
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let running = 0;
    const ledger = entries.map((e) => {
      running += Number(e.amount);
      return { ...e, balance: running.toFixed(2) };
    });
    const outstanding = await customerOutstanding(id);
    return reply.send({ success: true, data: { ledger, outstanding: outstanding.toFixed(2) } });
  });
}
