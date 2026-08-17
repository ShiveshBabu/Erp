import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { withTransaction, query } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import { incrementOrCreateBatch, insertStockMovement } from '../services/stockService';

const purchaseSchema = z.object({
  supplierId: z.string().min(1),
  warehouseId: z.string().min(1),
  productId: z.string().min(1),
  batchNo: z.string().optional(),
  qty: z.union([z.string(), z.number()]),
  rate: z.union([z.string(), z.number()]),
  mfgDate: z.string().optional(),
  expiryDate: z.string().optional()
});

const supplierPaymentSchema = z.object({
  purchaseBillId: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  reference: z.string().optional()
});

export default async function purchaseRoutes(app: FastifyInstance) {
  app.post('/api/v1/purchases', { preHandler: [requireAuth, requirePermission('inventory.add_stock')] }, async (req, reply) => {
    const body = purchaseSchema.parse(req.body);
    const qty = new Decimal(body.qty);
    const rate = new Decimal(body.rate);
    if (!qty.gt(0)) throw new AppError('VALIDATION_ERROR', 'Quantity must be greater than 0.', 400);
    if (rate.lt(0)) throw new AppError('VALIDATION_ERROR', 'Rate cannot be negative.', 400);

    const result = await withTransaction(async (client) => {
      const { rows: prodRows } = await client.query<{ id: string }>(`SELECT id FROM products WHERE id = $1`, [body.productId]);
      if (!prodRows[0]) throw new AppError('NOT_FOUND', 'Product not found.', 404);
      const { rows: supRows } = await client.query<{ id: string }>(`SELECT id FROM suppliers WHERE id = $1`, [body.supplierId]);
      if (!supRows[0]) throw new AppError('NOT_FOUND', 'Supplier not found.', 404);

      const batchNo = body.batchNo || `PO-${newId().slice(0, 8).toUpperCase()}`;
      const batchId = await incrementOrCreateBatch(client, {
        productId: body.productId, warehouseId: body.warehouseId, batchNo, qty,
        mfgDate: body.mfgDate ? new Date(body.mfgDate) : null,
        expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
        purchaseRate: rate, supplierId: body.supplierId
      });
      await insertStockMovement(client, { productId: body.productId, batchId, warehouseId: body.warehouseId, type: 'PURCHASE', qty, referenceId: batchNo });

      const amount = qty.mul(rate).toDecimalPlaces(2);
      const { rows: seqRows } = await client.query<{ nextvalue: string }>(
        `INSERT INTO sequences (name, "nextValue") VALUES ('purchase_bill', 2)
         ON CONFLICT (name) DO UPDATE SET "nextValue" = sequences."nextValue" + 1 RETURNING "nextValue" - 1 AS nextvalue`
      );
      const billNumber = `PB-${String(seqRows[0]!.nextvalue).padStart(4, '0')}`;
      const billId = newId('pb');
      await client.query(`INSERT INTO purchase_bills (id, number, "supplierId", amount, paid, balance, status) VALUES ($1,$2,$3,$4,0,$4,'UNPAID')`,
        [billId, billNumber, body.supplierId, amount.toString()]);
      await client.query(`INSERT INTO purchase_bill_items (id, "purchaseBillId", "productId", qty, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId('pbi'), billId, body.productId, qty.toString(), rate.toString(), amount.toString()]);

      await client.query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Purchase recorded','purchase_bill',$3,$4)`,
        [newId('au'), req.session.userId, billId, JSON.stringify({ batchNo, qty: qty.toString(), amount: amount.toString() })]);

      return { batchId, purchaseBillId: billId, purchaseBillNumber: billNumber, amount };
    });
    return reply.status(201).send({ success: true, data: result });
  });

  app.post('/api/v1/purchases/:billId/payments', { preHandler: [requireAuth, requirePermission('supplier.manage')] }, async (req, reply) => {
    const body = supplierPaymentSchema.parse({ ...(req.body as object), purchaseBillId: (req.params as any).billId });
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; balance: string; paid: string }>(
        `SELECT id, balance::text, paid::text FROM purchase_bills WHERE id = $1 FOR UPDATE`, [body.purchaseBillId]
      );
      const bill = rows[0];
      if (!bill) throw new AppError('NOT_FOUND', 'Purchase bill not found.', 404);
      const amount = new Decimal(body.amount);
      if (!amount.gt(0)) throw new AppError('INVALID_PAYMENT_AMOUNT', 'Amount must be greater than 0.', 400);
      const balance = new Decimal(bill.balance);
      if (amount.gt(balance.plus(0.5))) throw new AppError('PAYMENT_EXCEEDS_BALANCE', 'Amount exceeds outstanding balance.', 409);

      const newBalance = balance.minus(amount);
      const newPaid = new Decimal(bill.paid).plus(amount);
      const status = newBalance.lte(0.5) ? 'PAID' : 'PARTIALLY_PAID';
      await client.query(`INSERT INTO supplier_payments (id, "purchaseBillId", amount, method, reference) VALUES ($1,$2,$3,$4,$5)`,
        [newId('spay'), body.purchaseBillId, amount.toString(), body.method, body.reference ?? null]);
      await client.query(`UPDATE purchase_bills SET paid = $1, balance = $2, status = $3 WHERE id = $4`,
        [newPaid.toString(), newBalance.toString(), status, body.purchaseBillId]);
      return { purchaseBillId: body.purchaseBillId, balance: newBalance, status };
    });
    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/api/v1/purchases', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM purchase_bills ORDER BY date DESC`);
    return reply.send({ success: true, data: rows });
  });
}
