import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query, withTransaction } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import { createProductionOrder, completeProduction, materialAvailabilitySummary } from '../services/manufacturingService';

const bomItemSchema = z.object({ materialProductId: z.string().min(1), qty: z.union([z.string(), z.number()]), unitId: z.string().min(1) });
const bomSchema = z.object({
  code: z.string().min(1),
  outputProductId: z.string().min(1),
  batchSize: z.union([z.string(), z.number()]),
  items: z.array(bomItemSchema).min(1)
});

const productionOrderSchema = z.object({
  bomId: z.string().min(1),
  plannedQty: z.union([z.string(), z.number()]),
  warehouseId: z.string().min(1),
  batchNo: z.string().optional()
});

export default async function manufacturingRoutes(app: FastifyInstance) {
  app.post('/api/v1/boms', { preHandler: [requireAuth, requirePermission('manufacturing.manage')] }, async (req, reply) => {
    const body = bomSchema.parse(req.body);
    // Duplicate-material-in-BOM is enforced at the DB level (unique constraint),
    // but we check first for a friendly error rather than a raw constraint violation.
    const materialIds = body.items.map((i) => i.materialProductId);
    if (new Set(materialIds).size !== materialIds.length) {
      throw new AppError('DUPLICATE_MATERIAL_IN_BOM', 'The same material cannot appear twice in one BOM.', 409);
    }
    const result = await withTransaction(async (client) => {
      const id = newId('bom');
      await client.query(`INSERT INTO boms (id, code, "outputProductId", "batchSize", status) VALUES ($1,$2,$3,$4,'ACTIVE')`,
        [id, body.code, body.outputProductId, String(body.batchSize)]);
      for (const item of body.items) {
        await client.query(`INSERT INTO bom_items (id, "bomId", "materialProductId", qty, "unitId") VALUES ($1,$2,$3,$4,$5)`,
          [newId('bi'), id, item.materialProductId, String(item.qty), item.unitId]);
      }
      return { id, code: body.code };
    });
    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/api/v1/boms', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows: boms } = await query(`SELECT * FROM boms ORDER BY "createdAt" DESC`);
    for (const bom of boms as any[]) {
      const { rows: items } = await query(`SELECT * FROM bom_items WHERE "bomId" = $1`, [bom.id]);
      bom.items = items;
    }
    return reply.send({ success: true, data: boms });
  });

  app.get('/api/v1/production-orders', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM production_orders ORDER BY date DESC`);
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/production-orders', { preHandler: [requireAuth, requirePermission('manufacturing.manage')] }, async (req, reply) => {
    const body = productionOrderSchema.parse(req.body);
    const result = await createProductionOrder({ ...body, createdById: req.session.userId! });
    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/api/v1/production-orders/:id/availability', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await query<{ bomid: string; plannedqty: string }>(`SELECT "bomId" AS bomid, "plannedQty"::text AS plannedqty FROM production_orders WHERE id = $1`, [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Production order not found.', 404);
    const summary = await materialAvailabilitySummary(rows[0].bomid, rows[0].plannedqty);
    return reply.send({ success: true, data: summary });
  });

  app.post('/api/v1/production-orders/:id/complete', { preHandler: [requireAuth, requirePermission('manufacturing.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await completeProduction({ productionOrderId: id, completedById: req.session.userId! });
    return reply.send({ success: true, data: result });
  });
}
