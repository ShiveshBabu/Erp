import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { recordPayment, reversePayment } from '../services/paymentService';

const paySchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  reference: z.string().optional()
});

export default async function paymentRoutes(app: FastifyInstance) {
  app.post('/api/v1/payments', { preHandler: [requireAuth, requirePermission('payment.create')] }, async (req, reply) => {
    const body = paySchema.parse(req.body);
    const result = await recordPayment({ ...body, createdById: req.session.userId! });
    return reply.status(201).send({ success: true, data: result });
  });

  app.post('/api/v1/payments/:id/reverse', { preHandler: [requireAuth, requirePermission('payment.reverse')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await reversePayment({ paymentId: id, reversedById: req.session.userId! });
    return reply.send({ success: true, data: result });
  });
}
