import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import { transferStock } from '../services/stockService';
import { withTransaction } from '../lib/db';

const warehouseSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  address: z.string().optional(),
  managerId: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional()
});

const transferSchema = z.object({
  batchId: z.string().min(1),
  toWarehouseId: z.string().min(1),
  qty: z.union([z.string(), z.number()])
});

export default async function warehouseRoutes(app: FastifyInstance) {
  app.get('/api/v1/warehouses', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM warehouses ORDER BY name`);
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/warehouses', { preHandler: [requireAuth, requirePermission('warehouse.manage')] }, async (req, reply) => {
    const body = warehouseSchema.parse(req.body);
    const { rows: dupe } = await query(`SELECT id FROM warehouses WHERE code = $1`, [body.code]);
    if (dupe[0]) throw new AppError('VALIDATION_ERROR', `Warehouse code "${body.code}" already exists.`, 409);
    const id = newId('wh');
    await query(`INSERT INTO warehouses (id, name, code, address, "managerId", status) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, body.name, body.code, body.address ?? null, body.managerId ?? null, body.status ?? 'ACTIVE']);
    return reply.status(201).send({ success: true, data: { id } });
  });

  app.get('/api/v1/inventory', { preHandler: requireAuth }, async (_req, reply) => {
    // Derived view: on-hand = SUM(batches.qty) grouped by product+warehouse. No separate stock table.
    const { rows } = await query(
      `SELECT p.id AS "productId", p.name AS "productName", p.sku, w.id AS "warehouseId", w.name AS "warehouseName",
              SUM(b.qty)::text AS "onHand", p."reorderLevel"::text AS "reorderLevel"
       FROM batches b JOIN products p ON p.id = b."productId" JOIN warehouses w ON w.id = b."warehouseId"
       GROUP BY p.id, p.name, p.sku, w.id, w.name, p."reorderLevel"
       HAVING SUM(b.qty) > 0
       ORDER BY p.name, w.name`
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/inventory/transfer', { preHandler: [requireAuth, requirePermission('inventory.transfer')] }, async (req, reply) => {
    const body = transferSchema.parse(req.body);
    const result = await withTransaction(async (client) => transferStock(client, body));
    await query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Stock transfer','batch',$3,$4)`,
      [newId('au'), req.session.userId, body.batchId, JSON.stringify({ toWarehouseId: body.toWarehouseId, qty: body.qty })]);
    return reply.send({ success: true, data: { fromQty: result.fromQty.toString(), toQty: result.toQty.toString() } });
  });
}
