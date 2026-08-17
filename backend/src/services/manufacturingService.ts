import Decimal from 'decimal.js';
import { PoolClient } from 'pg';
import { withTransaction } from '../lib/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/id';
import { productTotalStock, insertStockMovement } from './stockService';

export interface MaterialRequirement {
  materialProductId: string;
  materialName: string;
  requiredQty: Decimal;
  unitId: string;
}

export async function computeRequirements(client: PoolClient, bomId: string, plannedQty: Decimal.Value): Promise<MaterialRequirement[]> {
  const { rows: bomRows } = await client.query<{ batchsize: string }>(`SELECT "batchSize"::text AS batchsize FROM boms WHERE id = $1`, [bomId]);
  const bom = bomRows[0];
  if (!bom) throw new AppError('NOT_FOUND', 'BOM not found.', 404);
  const scale = new Decimal(plannedQty).div(bom.batchsize);

  const { rows } = await client.query<{ materialproductid: string; name: string; qty: string; unitid: string }>(
    `SELECT bi."materialProductId" AS materialproductid, p.name, bi.qty::text, bi."unitId" AS unitid
     FROM bom_items bi JOIN products p ON p.id = bi."materialProductId" WHERE bi."bomId" = $1`,
    [bomId]
  );
  return rows.map((r) => ({ materialProductId: r.materialproductid, materialName: r.name, requiredQty: new Decimal(r.qty).mul(scale), unitId: r.unitid }));
}

/** Material availability summary shown to the operator BEFORE completion is
 * attempted — the "Complete" action is disabled client-side when any
 * shortage exists, and independently re-validated server-side regardless. */
export async function materialAvailabilitySummary(bomId: string, plannedQty: Decimal.Value) {
  return withTransaction(async (client) => {
    const requirements = await computeRequirements(client, bomId, plannedQty);
    const rows = [];
    for (const req of requirements) {
      const available = await productTotalStock(req.materialProductId);
      rows.push({
        materialProductId: req.materialProductId, name: req.materialName,
        required: req.requiredQty, available, shortage: Decimal.max(0, req.requiredQty.minus(available))
      });
    }
    return { rows, blocked: rows.some((r) => r.shortage.gt(0)) };
  });
}

export async function createProductionOrder(params: { bomId: string; plannedQty: string | number; warehouseId: string; batchNo?: string; createdById: string }) {
  return withTransaction(async (client) => {
    const { rows: bomRows } = await client.query<{ outputproductid: string }>(`SELECT "outputProductId" AS outputproductid FROM boms WHERE id = $1`, [params.bomId]);
    const bom = bomRows[0];
    if (!bom) throw new AppError('NOT_FOUND', 'BOM not found.', 404);
    const plannedQty = new Decimal(params.plannedQty);
    if (!plannedQty.gt(0)) throw new AppError('VALIDATION_ERROR', 'Planned quantity must be greater than 0.', 400);

    // Matches the frozen local-mode rule: a production order cannot be
    // created at all if required materials are not currently available
    // (this was previously only checked at completion — a real gap, since a
    // PLANNED order for e.g. 999,999,999 units was silently accepted).
    const requirements = await computeRequirements(client, params.bomId, plannedQty);
    for (const req of requirements) {
      const available = await productTotalStock(req.materialProductId);
      if (available.lt(req.requiredQty)) {
        throw new AppError('INSUFFICIENT_PRODUCTION_MATERIAL',
          `Insufficient ${req.materialName} stock. Required: ${req.requiredQty.toString()}. Available: ${available.toString()}.`,
          409, { materialProductId: req.materialProductId, required: req.requiredQty.toString(), available: available.toString() });
      }
    }

    const { rows: seqRows } = await client.query<{ nextvalue: string }>(
      `INSERT INTO sequences (name, "nextValue") VALUES ('production', 2)
       ON CONFLICT (name) DO UPDATE SET "nextValue" = sequences."nextValue" + 1 RETURNING "nextValue" - 1 AS nextvalue`
    );
    const number = `PRD-${String(seqRows[0]!.nextvalue).padStart(4, '0')}`;
    const id = newId('po');
    await client.query(
      `INSERT INTO production_orders (id, number, "bomId", "productId", "plannedQty", "warehouseId", "batchNo", status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PLANNED')`,
      [id, number, params.bomId, bom.outputproductid, plannedQty.toString(), params.warehouseId, params.batchNo ?? null]
    );

    for (const req of requirements) {
      await client.query(`INSERT INTO production_materials (id, "productionOrderId", "materialProductId", "requiredQty") VALUES ($1,$2,$3,$4)`,
        [newId('pm'), id, req.materialProductId, req.requiredQty.toString()]);
    }
    return { id, number, status: 'PLANNED' as const };
  });
}

/**
 * Production completion — validates EVERY required material's total stock
 * before mutating anything; only if all are sufficient does it consume
 * FEFO across batches (any warehouse) and create the finished-goods batch.
 * Insufficient stock throws before any write — no partial consumption.
 */
export async function completeProduction(params: { productionOrderId: string; completedById: string }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; number: string; bomid: string; productid: string; plannedqty: string; warehouseid: string; batchno: string | null; status: string }>(
      `SELECT id, number, "bomId" AS bomid, "productId" AS productid, "plannedQty"::text AS plannedqty,
              "warehouseId" AS warehouseid, "batchNo" AS batchno, status
       FROM production_orders WHERE id = $1 FOR UPDATE`,
      [params.productionOrderId]
    );
    const order = rows[0];
    if (!order) throw new AppError('NOT_FOUND', 'Production order not found.', 404);
    if (order.status === 'COMPLETED') throw new AppError('VALIDATION_ERROR', 'Production order is already completed.', 400);
    if (order.status === 'CANCELLED') throw new AppError('VALIDATION_ERROR', 'Production order was cancelled.', 400);

    const requirements = await computeRequirements(client, order.bomid, order.plannedqty);

    // Validate EVERY material before mutating ANYTHING.
    for (const req of requirements) {
      const available = await productTotalStock(req.materialProductId);
      if (available.lt(req.requiredQty)) {
        throw new AppError('INSUFFICIENT_PRODUCTION_MATERIAL',
          `Insufficient ${req.materialName} stock. Required: ${req.requiredQty.toString()}. Available: ${available.toString()}.`,
          409, { materialProductId: req.materialProductId, required: req.requiredQty.toString(), available: available.toString() });
      }
    }

    // Consume FEFO across all batches of each material (any warehouse), now that every material has passed validation.
    let totalCost = new Decimal(0);
    for (const req of requirements) {
      let remaining = req.requiredQty;
      const { rows: batches } = await client.query<{ id: string; warehouseid: string; qty: string; purchaserate: string }>(
        `SELECT id, "warehouseId" AS warehouseid, qty::text, "purchaseRate"::text AS purchaserate
         FROM batches WHERE "productId" = $1 AND qty > 0 AND ("expiryDate" IS NULL OR "expiryDate" >= now())
         ORDER BY ("expiryDate" IS NULL), "expiryDate" ASC FOR UPDATE`,
        [req.materialProductId]
      );
      for (const batch of batches) {
        if (remaining.lte(0)) break;
        const take = Decimal.min(new Decimal(batch.qty), remaining);
        await client.query(`UPDATE batches SET qty = qty - $2 WHERE id = $1`, [batch.id, take.toString()]);
        remaining = remaining.minus(take);
        totalCost = totalCost.plus(take.mul(batch.purchaserate));
        await insertStockMovement(client, { productId: req.materialProductId, batchId: batch.id, warehouseId: batch.warehouseid, type: 'PRODUCTION_CONSUMPTION', qty: take, referenceId: order.number });
        await client.query(`UPDATE production_materials SET "consumedQty" = "consumedQty" + $2 WHERE "productionOrderId" = $1 AND "materialProductId" = $3`,
          [order.id, take.toString(), req.materialProductId]);
      }
    }

    // Create finished-goods batch + movement.
    const plannedQty = new Decimal(order.plannedqty);
    const purchaseRate = totalCost.div(plannedQty).toDecimalPlaces(2);
    const batchNo = order.batchno || `PB-${order.number}`;
    const outputBatchId = newId('batch');
    await client.query(
      `INSERT INTO batches (id, "productId", "warehouseId", "batchNo", qty, "mfgDate", "purchaseRate")
       VALUES ($1,$2,$3,$4,$5,now(),$6)`,
      [outputBatchId, order.productid, order.warehouseid, batchNo, plannedQty.toString(), purchaseRate.toString()]
    );
    await insertStockMovement(client, { productId: order.productid, batchId: outputBatchId, warehouseId: order.warehouseid, type: 'PRODUCTION', qty: plannedQty, referenceId: order.number });
    await client.query(`INSERT INTO production_outputs (id, "productionOrderId", "batchId", qty) VALUES ($1,$2,$3,$4)`,
      [newId('pout'), order.id, outputBatchId, plannedQty.toString()]);

    await client.query(`UPDATE production_orders SET status = 'COMPLETED', "completedAt" = now(), "actualCost" = $2 WHERE id = $1`,
      [order.id, totalCost.toFixed(2)]);
    await client.query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Production completed','production_order',$3,$4)`,
      [newId('au'), params.completedById, order.id, JSON.stringify({ number: order.number, cost: totalCost.toFixed(2), outputBatchId })]);

    return { productionOrderId: order.id, actualCost: totalCost, outputBatchId };
  });
}
