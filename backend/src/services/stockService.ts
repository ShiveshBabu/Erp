import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { query } from '../lib/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/id';

const EXPIRY_WARNING_DAYS = 30;

export type BatchStatusValue = 'ACTIVE' | 'NEAR_EXPIRY' | 'EXPIRED' | 'DEPLETED';

export function computeBatchStatus(qty: Decimal.Value, expiryDate: Date | null, today = new Date()): BatchStatusValue {
  if (new Decimal(qty).lte(0)) return 'DEPLETED';
  if (!expiryDate) return 'ACTIVE';
  const days = Math.floor((expiryDate.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return 'EXPIRED';
  if (days <= EXPIRY_WARNING_DAYS) return 'NEAR_EXPIRY';
  return 'ACTIVE';
}

export interface BatchRow {
  id: string;
  productid: string;
  batchno: string;
  warehouseid: string;
  qty: string;
  mfgdate: string | null;
  expirydate: string | null;
  purchaserate: string;
}

/** FEFO: earliest-expiry-first among valid (non-expired, qty>0) batches.
 * Batches with no expiry sort last. Mirrors the frozen `fefoBatches()` rule
 * exactly — this is the single enforcement point that makes "cannot sell
 * expired stock" true everywhere that calls it. */
export async function fefoBatches(client: PoolClient, productId: string, warehouseId: string): Promise<BatchRow[]> {
  const result = await client.query<BatchRow>(
    `SELECT id, "productId" AS productid, "batchNo" AS batchno, "warehouseId" AS warehouseid,
            qty::text, "mfgDate" AS mfgdate, "expiryDate" AS expirydate, "purchaseRate"::text AS purchaserate
     FROM batches
     WHERE "productId" = $1 AND "warehouseId" = $2 AND qty > 0
       AND ("expiryDate" IS NULL OR "expiryDate" >= now())
     ORDER BY ("expiryDate" IS NULL), "expiryDate" ASC`,
    [productId, warehouseId]
  );
  return result.rows;
}

/** Atomically decrement a batch's quantity, guarded so it can never go
 * negative even under concurrent requests — the core concurrency-safety
 * mechanism (§13/§25 of the migration spec): a conditional UPDATE, not a
 * read-then-write. Returns the batch's new quantity, or throws
 * INSUFFICIENT_STOCK if the guard clause matched zero rows. */
export async function decrementBatchAtomic(client: PoolClient, batchId: string, qty: Decimal.Value): Promise<Decimal> {
  const { rows } = await client.query<{ qty: string }>(
    `UPDATE batches SET qty = qty - $2 WHERE id = $1 AND qty >= $2 RETURNING qty::text`,
    [batchId, new Decimal(qty).toString()]
  );
  if (rows.length === 0) {
    throw new AppError('INSUFFICIENT_STOCK', 'Requested quantity is no longer available (concurrent update).', 409);
  }
  return new Decimal(rows[0]!.qty);
}

export async function incrementOrCreateBatch(
  client: PoolClient,
  params: { productId: string; warehouseId: string; batchNo: string; qty: Decimal.Value; mfgDate?: Date | null; expiryDate?: Date | null; purchaseRate: Decimal.Value; supplierId?: string | null }
): Promise<string> {
  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM batches WHERE "productId" = $1 AND "warehouseId" = $2 AND "batchNo" = $3`,
    [params.productId, params.warehouseId, params.batchNo]
  );
  if (existing[0]) {
    await client.query(`UPDATE batches SET qty = qty + $2 WHERE id = $1`, [existing[0].id, new Decimal(params.qty).toString()]);
    return existing[0].id;
  }
  const id = newId('batch');
  await client.query(
    `INSERT INTO batches (id, "productId", "warehouseId", "batchNo", qty, "mfgDate", "expiryDate", "purchaseRate", "supplierId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, params.productId, params.warehouseId, params.batchNo, new Decimal(params.qty).toString(),
      params.mfgDate ?? null, params.expiryDate ?? null, new Decimal(params.purchaseRate).toString(), params.supplierId ?? null]
  );
  return id;
}

export async function insertStockMovement(
  client: PoolClient,
  params: { productId: string; batchId: string | null; warehouseId: string; type: string; qty: Decimal.Value; referenceId?: string; note?: string }
): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements (id, "productId", "batchId", "warehouseId", type, qty, "referenceId", note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId('mv'), params.productId, params.batchId, params.warehouseId, params.type,
      new Decimal(params.qty).toString(), params.referenceId ?? null, params.note ?? null]
  );
}

export async function warehouseProductStock(productId: string, warehouseId: string): Promise<Decimal> {
  const { rows } = await query<{ sum: string | null }>(
    `SELECT SUM(qty)::text AS sum FROM batches WHERE "productId" = $1 AND "warehouseId" = $2`,
    [productId, warehouseId]
  );
  return new Decimal(rows[0]?.sum ?? 0);
}

export async function productTotalStock(productId: string): Promise<Decimal> {
  // Excludes expired batches: this is used exclusively for manufacturing
  // material-availability checks, where expired stock cannot actually be
  // consumed (completeProduction's FEFO query already excludes it) — so
  // counting it as "available" here would let a production order be created
  // or pass validation against stock that can never really be used. Found
  // as a real consistency gap during the production audit.
  const { rows } = await query<{ sum: string | null }>(
    `SELECT SUM(qty)::text AS sum FROM batches WHERE "productId" = $1 AND ("expiryDate" IS NULL OR "expiryDate" >= now())`,
    [productId]
  );
  return new Decimal(rows[0]?.sum ?? 0);
}

/** Atomic warehouse transfer: validate → decrement source → increment/create
 * destination, all inside the caller's transaction. Rolls back completely
 * if any step fails (the transaction wraps this whole function). */
export async function transferStock(
  client: PoolClient,
  params: { batchId: string; toWarehouseId: string; qty: Decimal.Value }
): Promise<{ fromQty: Decimal; toQty: Decimal }> {
  const { rows } = await client.query<{ productid: string; warehouseid: string; batchno: string; mfgdate: string | null; expirydate: string | null; purchaserate: string; supplierid: string | null }>(
    `SELECT "productId" AS productid, "warehouseId" AS warehouseid, "batchNo" AS batchno,
            "mfgDate" AS mfgdate, "expiryDate" AS expirydate, "purchaseRate"::text AS purchaserate, "supplierId" AS supplierid
     FROM batches WHERE id = $1`,
    [params.batchId]
  );
  const batch = rows[0];
  if (!batch) throw new AppError('NOT_FOUND', 'Batch not found.', 404);
  if (batch.warehouseid === params.toWarehouseId) {
    throw new AppError('VALIDATION_ERROR', 'Source and destination warehouse are the same.', 400);
  }
  // Expired stock must never move between warehouses (matches "never sold,
  // never transferred, never consumed in manufacturing" — a real gap found
  // during the production audit: this check was previously missing here).
  if (batch.expirydate && new Date(batch.expirydate).getTime() < Date.now()) {
    throw new AppError('BATCH_EXPIRED', 'This batch has expired and cannot be transferred.', 409);
  }

  const fromQty = await decrementBatchAtomic(client, params.batchId, params.qty);

  const destBatchId = await incrementOrCreateBatch(client, {
    productId: batch.productid, warehouseId: params.toWarehouseId, batchNo: batch.batchno,
    qty: params.qty, mfgDate: batch.mfgdate ? new Date(batch.mfgdate) : null,
    expiryDate: batch.expirydate ? new Date(batch.expirydate) : null,
    purchaseRate: batch.purchaserate, supplierId: batch.supplierid
  });
  const { rows: destRows } = await client.query<{ qty: string }>(`SELECT qty::text FROM batches WHERE id = $1`, [destBatchId]);

  await insertStockMovement(client, { productId: batch.productid, batchId: params.batchId, warehouseId: batch.warehouseid, type: 'TRANSFER_OUT', qty: params.qty, referenceId: batch.batchno, note: `To ${params.toWarehouseId}` });
  await insertStockMovement(client, { productId: batch.productid, batchId: destBatchId, warehouseId: params.toWarehouseId, type: 'TRANSFER_IN', qty: params.qty, referenceId: batch.batchno, note: `From ${batch.warehouseid}` });

  return { fromQty, toQty: new Decimal(destRows[0]!.qty) };
}
