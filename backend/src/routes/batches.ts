import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query, withTransaction } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import { computeBatchStatus, insertStockMovement } from '../services/stockService';

const batchSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  batchNo: z.string().min(1),
  qty: z.union([z.string(), z.number()]),
  mfgDate: z.string().optional(),
  expiryDate: z.string().optional(),
  purchaseRate: z.union([z.string(), z.number()])
});

const adjustSchema = z.object({
  batchId: z.string().min(1),
  type: z.enum(['ADD', 'REMOVE', 'DAMAGE', 'EXPIRY', 'CORRECTION']),
  qty: z.union([z.string(), z.number()]),
  reason: z.string().min(1, 'A reason is required for every stock adjustment.')
});

export default async function batchRoutes(app: FastifyInstance) {
  app.get('/api/v1/batches', { preHandler: requireAuth }, async (_req, reply) => {
    
    const { rows: full } = await query(`SELECT b.*, p.name AS "productName", p.sku, w.name AS "warehouseName" FROM batches b JOIN products p ON p.id = b."productId" JOIN warehouses w ON w.id = b."warehouseId" ORDER BY b."createdAt" DESC`);
    const withStatus = full.map((b: any) => ({ ...b, status: computeBatchStatus(b.qty, b.expiryDate ? new Date(b.expiryDate) : null) }));
    return reply.send({ success: true, data: withStatus });
  });

  app.post('/api/v1/batches', { preHandler: [requireAuth, requirePermission('batch.create')] }, async (req, reply) => {
    const body = batchSchema.parse(req.body);
    const { rows: dupe } = await query(`SELECT id FROM batches WHERE "productId"=$1 AND "warehouseId"=$2 AND "batchNo"=$3`, [body.productId, body.warehouseId, body.batchNo]);
    if (dupe[0]) throw new AppError('DUPLICATE_BATCH', `Batch "${body.batchNo}" already exists for this product in this warehouse.`, 409);
    const id = newId('batch');
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO batches (id, "productId", "warehouseId", "batchNo", qty, "mfgDate", "expiryDate", "purchaseRate")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.productId, body.warehouseId, body.batchNo, body.qty, body.mfgDate ?? null, body.expiryDate ?? null, body.purchaseRate]
      );
      await insertStockMovement(client, { productId: body.productId, batchId: id, warehouseId: body.warehouseId, type: 'OPENING_STOCK', qty: body.qty, referenceId: body.batchNo });
    });
    return reply.status(201).send({ success: true, data: { id } });
  });

  app.post('/api/v1/inventory/adjustments', { preHandler: [requireAuth, requirePermission('inventory.adjust')] }, async (req, reply) => {
    const body = adjustSchema.parse(req.body);
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; productid: string; warehouseid: string; qty: string }>(
        `SELECT id, "productId" AS productid, "warehouseId" AS warehouseid, qty::text FROM batches WHERE id = $1 FOR UPDATE`,
        [body.batchId]
      );
      const batch = rows[0];
      if (!batch) throw new AppError('NOT_FOUND', 'Batch not found.', 404);
      const qty = new Decimal(body.qty);

      if (body.type === 'CORRECTION') {
        const diff = qty.minus(batch.qty);
        await client.query(`UPDATE batches SET qty = $2 WHERE id = $1`, [batch.id, qty.toString()]);
        await insertStockMovement(client, { productId: batch.productid, batchId: batch.id, warehouseId: batch.warehouseid, type: 'STOCK_ADJUSTMENT', qty: diff, note: body.reason });
        return { batchId: batch.id, newQty: qty };
      }
      if (!qty.gt(0)) throw new AppError('VALIDATION_ERROR', 'Quantity must be greater than 0.', 400);
      if (body.type === 'ADD') {
        await client.query(`UPDATE batches SET qty = qty + $2 WHERE id = $1`, [batch.id, qty.toString()]);
        await insertStockMovement(client, { productId: batch.productid, batchId: batch.id, warehouseId: batch.warehouseid, type: 'STOCK_ADJUSTMENT', qty, note: body.reason });
      } else {
        const { rows: dec } = await client.query<{ qty: string }>(`UPDATE batches SET qty = qty - $2 WHERE id = $1 AND qty >= $2 RETURNING qty::text`, [batch.id, qty.toString()]);
        if (!dec[0]) throw new AppError('INSUFFICIENT_STOCK', `Only ${batch.qty} available.`, 409);
        const movementType = body.type === 'DAMAGE' ? 'DAMAGE' : body.type === 'EXPIRY' ? 'EXPIRED' : 'STOCK_ADJUSTMENT';
        await insertStockMovement(client, { productId: batch.productid, batchId: batch.id, warehouseId: batch.warehouseid, type: movementType, qty: qty.negated(), note: body.reason });
      }
      const { rows: final } = await client.query<{ qty: string }>(`SELECT qty::text FROM batches WHERE id = $1`, [batch.id]);
      return { batchId: batch.id, newQty: new Decimal(final[0]!.qty) };
    });
    await query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", reason, "newValue") VALUES ($1,$2,$3,'batch',$4,$5,$6)`,
      [newId('au'), req.session.userId, `Stock adjustment (${body.type})`, body.batchId, body.reason, JSON.stringify({ qty: body.qty })]);
    return reply.send({ success: true, data: { ...result, newQty: result.newQty.toString() } });
  });
}
