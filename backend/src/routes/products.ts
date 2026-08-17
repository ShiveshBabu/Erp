import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';

const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  categoryId: z.string().min(1),
  hsn: z.string().optional(),
  unitId: z.string().min(1),
  purchasePrice: z.union([z.string(), z.number()]),
  sellingPrice: z.union([z.string(), z.number()]).optional(),
  gstRate: z.union([z.string(), z.number()]),
  reorderLevel: z.union([z.string(), z.number()]).optional(),
  expiryTracking: z.boolean().optional(),
  type: z.enum(['MANUFACTURED', 'TRADED', 'RAW']).optional()
});

export default async function productRoutes(app: FastifyInstance) {
  app.get('/api/v1/products', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT p.*, (SELECT COALESCE(SUM(qty),0) FROM batches WHERE "productId" = p.id)::text AS "totalStock" FROM products p ORDER BY name`);
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/products', { preHandler: [requireAuth, requirePermission('product.create')] }, async (req, reply) => {
    const body = productSchema.parse(req.body);
    const { rows: dupe } = await query(`SELECT id FROM products WHERE sku = $1`, [body.sku]);
    if (dupe[0]) throw new AppError('DUPLICATE_SKU', `SKU "${body.sku}" already exists.`, 409);
    const id = newId('prod');
    await query(
      `INSERT INTO products (id, sku, name, "categoryId", hsn, "unitId", "purchasePrice", "sellingPrice", "gstRate", "reorderLevel", "expiryTracking", type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, body.sku, body.name, body.categoryId, body.hsn ?? null, body.unitId, body.purchasePrice, body.sellingPrice ?? null,
        body.gstRate, body.reorderLevel ?? 0, body.expiryTracking ?? false, body.type ?? 'TRADED']
    );
    return reply.status(201).send({ success: true, data: { id } });
  });

  app.patch('/api/v1/products/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = productSchema.partial().parse(req.body);
    const { rows } = await query<{ purchaseprice: string; sellingprice: string | null }>(
      `SELECT "purchasePrice"::text AS purchaseprice, "sellingPrice"::text AS sellingprice FROM products WHERE id = $1`, [id]
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Product not found.', 404);

    const priceChanged = (body.purchasePrice !== undefined && String(body.purchasePrice) !== rows[0].purchaseprice) ||
      (body.sellingPrice !== undefined && String(body.sellingPrice) !== rows[0].sellingprice);
    if (priceChanged) {
      // Independent server-side check: price edits require a dedicated permission
      // even for a user who otherwise can edit non-price product fields.
      await requirePermission('product.edit_price')(req, reply);
    }

    const fields = Object.entries(body).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return reply.send({ success: true, data: { id } });
    const setClause = fields.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
    await query(`UPDATE products SET ${setClause} WHERE id = $1`, [id, ...fields.map(([, v]) => v)]);

    if (priceChanged) {
      await query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "oldValue", "newValue") VALUES ($1,$2,'Product price changed','product',$3,$4,$5)`,
        [newId('au'), req.session.userId, id, JSON.stringify(rows[0]), JSON.stringify({ purchasePrice: body.purchasePrice, sellingPrice: body.sellingPrice })]);
    }
    return reply.send({ success: true, data: { id } });
  });

  app.get('/api/v1/product-categories', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM product_categories ORDER BY name`);
    return reply.send({ success: true, data: rows });
  });

  app.get('/api/v1/units', { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(`SELECT * FROM units ORDER BY code`);
    return reply.send({ success: true, data: rows });
  });
}
