import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/rbac';
import { gstSummary, profitSummary } from '../services/calcService';
import { query } from '../lib/db';

const rangeSchema = z.object({ from: z.string(), to: z.string() });

export default async function reportRoutes(app: FastifyInstance) {
  app.get('/api/v1/reports/gst', { preHandler: requireAuth }, async (req, reply) => {
    const { from, to } = rangeSchema.parse(req.query);
    const summary = await gstSummary(new Date(from), new Date(to));
    // Round CGST/SGST to currency precision FIRST, then derive the displayed
    // total from those rounded values — not independently rounded from full
    // precision — so CGST + SGST always exactly equals the displayed total.
    // (Found during audit: rounding all three independently could differ by
    // ₹0.01 when many lines' half-cent tax splits accumulate.)
    const cgstRounded = summary.cgst.toDecimalPlaces(2);
    const sgstRounded = summary.sgst.toDecimalPlaces(2);
    return reply.send({ success: true, data: {
      taxable: summary.taxable.toFixed(2), cgst: cgstRounded.toFixed(2), sgst: sgstRounded.toFixed(2),
      total: cgstRounded.plus(sgstRounded).toFixed(2),
      byRate: summary.byRate.map((r) => ({ rate: r.rate, taxable: r.taxable.toFixed(2), tax: r.tax.toFixed(2) }))
    } });
  });

  app.get('/api/v1/reports/profit-loss', { preHandler: requireAuth }, async (req, reply) => {
    const { from, to } = rangeSchema.parse(req.query);
    const summary = await profitSummary(new Date(from), new Date(to));
    return reply.send({ success: true, data: {
      revenue: summary.revenue.toFixed(2), cogs: summary.cogs.toFixed(2), gross: summary.gross.toFixed(2),
      expenses: summary.expenses.toFixed(2), net: summary.net.toFixed(2)
    } });
  });

  app.get('/api/v1/reports/sales-register', { preHandler: requireAuth }, async (req, reply) => {
    const { from, to } = rangeSchema.parse(req.query);
    const { rows } = await query(
      `SELECT i.number, i.date, c.name AS customer, i."grandTotal"::text, i.paid::text, i.balance::text, i.status
       FROM invoices i JOIN customers c ON c.id = i."customerId"
       WHERE i.date >= $1 AND i.date <= $2 AND i.status != 'CANCELLED' ORDER BY i.date DESC`,
      [from, to]
    );
    return reply.send({ success: true, data: rows });
  });

  app.get('/api/v1/reports/stock-summary', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(
      `SELECT w.name AS warehouse, SUM(b.qty * p."purchasePrice")::text AS value, COUNT(DISTINCT p.id) AS skus
       FROM batches b JOIN products p ON p.id = b."productId" JOIN warehouses w ON w.id = b."warehouseId"
       WHERE b.qty > 0 GROUP BY w.name ORDER BY w.name`
    );
    return reply.send({ success: true, data: rows });
  });
}
