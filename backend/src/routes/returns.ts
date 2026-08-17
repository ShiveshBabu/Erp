import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { recordSalesReturn } from '../services/returnService';

const returnSchema = z.object({
  invoiceItemId: z.string().min(1),
  qty: z.union([z.string(), z.number()]),
  reason: z.string().optional()
});

export default async function returnRoutes(app: FastifyInstance) {
  app.post('/api/v1/returns', { preHandler: [requireAuth, requirePermission('return.create')] }, async (req, reply) => {
    const body = returnSchema.parse(req.body);
    const result = await recordSalesReturn({ ...body, createdById: req.session.userId! });
    return reply.status(201).send({ success: true, data: result });
  });
}
