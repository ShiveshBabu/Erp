import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query } from '../lib/db';
import { newId } from '../lib/id';
import { supplierPayable } from '../services/calcService';

const supplierSchema = z.object({
  name: z.string().min(1),
  contact: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  gstin: z.string().optional(),
  address: z.string().optional(),
  paymentTerms: z.string().optional()
});

export default async function supplierRoutes(app: FastifyInstance) {
  app.get('/api/v1/suppliers', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM suppliers ORDER BY name`);
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/suppliers', { preHandler: [requireAuth, requirePermission('supplier.manage')] }, async (req, reply) => {
    const body = supplierSchema.parse(req.body);
    const id = newId('sup');
    await query(`INSERT INTO suppliers (id, name, contact, phone, email, gstin, address, "paymentTerms") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, body.name, body.contact ?? null, body.phone ?? null, body.email || null, body.gstin ?? null, body.address ?? null, body.paymentTerms ?? 'Net 30']);
    return reply.status(201).send({ success: true, data: { id } });
  });

  app.get('/api/v1/suppliers/:id/ledger', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows: bills } = await query<{ number: string; date: string; amount: string }>(
      `SELECT number, date, amount::text FROM purchase_bills WHERE "supplierId" = $1 AND status != 'CANCELLED' ORDER BY date`, [id]
    );
    const { rows: payments } = await query<{ date: string; amount: string; billnumber: string }>(
      `SELECT sp.date, sp.amount::text, pb.number AS billnumber
       FROM supplier_payments sp JOIN purchase_bills pb ON pb.id = sp."purchaseBillId"
       WHERE pb."supplierId" = $1 ORDER BY sp.date`, [id]
    );
    const entries = [
      ...bills.map((b) => ({ date: b.date, type: 'BILL' as const, ref: b.number, amount: b.amount })),
      ...payments.map((p) => ({ date: p.date, type: 'PAYMENT' as const, ref: p.billnumber, amount: `-${p.amount}` }))
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let running = 0;
    const ledger = entries.map((e) => { running += Number(e.amount); return { ...e, balance: running.toFixed(2) }; });
    const payable = await supplierPayable(id);
    return reply.send({ success: true, data: { ledger, payable: payable.toFixed(2) } });
  });
}
