import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { createInvoice } from '../services/invoiceService';
import { cancelInvoice } from '../services/paymentService';
import { query } from '../lib/db';
import { AppError } from '../lib/errors';

const lineSchema = z.object({
  productId: z.string().min(1),
  qty: z.union([z.string(), z.number()]),
  rate: z.union([z.string(), z.number()]).optional(),
  discountPct: z.union([z.string(), z.number()]).optional(),
  batchId: z.string().optional()
});

const createInvoiceSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  dueDate: z.string().optional(),
  lines: z.array(lineSchema).min(1),
  initialPayment: z.object({ amount: z.union([z.string(), z.number()]), method: z.string(), reference: z.string().optional() }).optional()
});

const cancelSchema = z.object({ reason: z.string().min(1, 'A cancellation reason is required.') });

export default async function invoiceRoutes(app: FastifyInstance) {
  app.post('/api/v1/invoices', { preHandler: [requireAuth, requirePermission('invoice.create')] }, async (req, reply) => {
    const body = createInvoiceSchema.parse(req.body);
    const result = await createInvoice({ ...body, lines: body.lines as any, createdById: req.session.userId! });
    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/api/v1/invoices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query(`SELECT i.*, c.name AS "customerName", c.gstin AS "customerGstin", c.address AS "customerAddress" FROM invoices i JOIN customers c ON c.id = i."customerId" WHERE i.id = $1`, [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
    const { rows: items } = await query(
      `SELECT ii.*, p.name AS "productName", p.sku, u.code AS "unitCode"
       FROM invoice_items ii JOIN products p ON p.id = ii."productId" JOIN units u ON u.id = ii."unitId"
       WHERE ii."invoiceId" = $1`,
      [id]
    );
    const { rows: payments } = await query(`SELECT * FROM payments WHERE "invoiceId" = $1 ORDER BY date`, [id]);
    return reply.send({ success: true, data: { ...rows[0], items, payments } });
  });

  app.get('/api/v1/invoices', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(
      `SELECT i.*, c.name AS "customerName", c.gstin AS "customerGstin",
              (SELECT COUNT(*) FROM invoice_items WHERE "invoiceId" = i.id)::int AS "itemCount"
       FROM invoices i JOIN customers c ON c.id = i."customerId"
       ORDER BY i.date DESC LIMIT 200`
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/invoices/:id/cancel', { preHandler: [requireAuth, requirePermission('invoice.cancel')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cancelSchema.parse(req.body);
    const result = await cancelInvoice({ invoiceId: id, reason: body.reason, cancelledById: req.session.userId! });
    return reply.send({ success: true, data: result });
  });
}
