import Decimal from 'decimal.js';
import { PoolClient } from 'pg';
import { withTransaction } from '../lib/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/id';
import { calcInvoiceTotals } from './calcService';
import { fefoBatches, decrementBatchAtomic, insertStockMovement, computeBatchStatus } from './stockService';

export interface InvoiceLineRequest {
  productId: string;
  qty: string | number;
  rate: string | number; // server will still recompute totals, but rate is the agreed unit price
  discountPct?: string | number;
  batchId?: string; // optional explicit batch; otherwise FEFO-resolved
}

export interface CreateInvoiceRequest {
  customerId: string;
  warehouseId: string;
  dueDate?: string;
  lines: InvoiceLineRequest[];
  initialPayment?: { amount: string | number; method: string; reference?: string };
  createdById: string;
}

async function nextSequence(client: PoolClient, name: string, prefix: string, pad = 4): Promise<string> {
  const { rows } = await client.query<{ nextvalue: string }>(
    `INSERT INTO sequences (name, "nextValue") VALUES ($1, 2)
     ON CONFLICT (name) DO UPDATE SET "nextValue" = sequences."nextValue" + 1
     RETURNING "nextValue" - 1 AS nextvalue`,
    [name]
  );
  const n = rows[0]!.nextvalue;
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

/**
 * Invoice creation as ONE database transaction, exactly per Step 12:
 * validate customer → validate warehouse → validate each product+batch(FEFO)
 * → validate stock → recalculate totals server-side (never trust the
 * client) → insert invoice+items → atomically decrement stock → insert
 * stock movements → optional initial payment → audit log → commit.
 * Any failure anywhere rolls back everything.
 */
export async function createInvoice(req: CreateInvoiceRequest) {
  if (req.lines.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Invoice must have at least one line item.', 400);
  }

  return withTransaction(async (client) => {
    // 1. Validate customer
    const { rows: custRows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM customers WHERE id = $1`,
      [req.customerId]
    );
    if (!custRows[0]) throw new AppError('NOT_FOUND', 'Customer not found.', 404);

    // 2. Validate warehouse
    const { rows: whRows } = await client.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM warehouses WHERE id = $1`,
      [req.warehouseId]
    );
    const warehouse = whRows[0];
    if (!warehouse) throw new AppError('NOT_FOUND', 'Warehouse not found.', 404);
    if (warehouse.status !== 'ACTIVE') throw new AppError('VALIDATION_ERROR', `Warehouse "${warehouse.name}" is inactive.`, 400);

    // 3-5. Validate each product, resolve FEFO batch, reject expired, validate quantity
    const resolvedLines: {
      productId: string; batchId: string; qty: Decimal; rate: Decimal; discountPct: Decimal; gstRate: Decimal;
      unitId: string; hsn: string | null; productName: string;
    }[] = [];

    for (const line of req.lines) {
      const qty = new Decimal(line.qty);
      if (!qty.gt(0)) throw new AppError('VALIDATION_ERROR', 'Line quantity must be greater than 0.', 400);

      const { rows: prodRows } = await client.query<{ id: string; name: string; sellingprice: string | null; gstrate: string; hsn: string | null; unitid: string }>(
        `SELECT id, name, "sellingPrice"::text AS sellingprice, "gstRate"::text AS gstrate, hsn, "unitId" AS unitid FROM products WHERE id = $1`,
        [line.productId]
      );
      const product = prodRows[0];
      if (!product) throw new AppError('NOT_FOUND', `Product ${line.productId} not found.`, 404);

      let batchId = line.batchId;
      if (!batchId) {
        const candidates = await fefoBatches(client, product.id, req.warehouseId);
        if (candidates.length === 0) {
          throw new AppError('NO_VALID_BATCH', `No available (non-expired) stock of ${product.name} in ${warehouse.name}.`, 409);
        }
        batchId = candidates[0]!.id;
      } else {
        const { rows: batchRows } = await client.query<{ id: string; qty: string; expirydate: string | null; warehouseid: string }>(
          `SELECT id, qty::text, "expiryDate" AS expirydate, "warehouseId" AS warehouseid FROM batches WHERE id = $1`,
          [batchId]
        );
        const batch = batchRows[0];
        if (!batch) throw new AppError('NOT_FOUND', 'Batch not found.', 404);
        if (batch.warehouseid !== req.warehouseId) throw new AppError('VALIDATION_ERROR', 'Batch does not belong to the selected warehouse.', 400);
        const status = computeBatchStatus(batch.qty, batch.expirydate ? new Date(batch.expirydate) : null);
        if (status === 'EXPIRED') throw new AppError('BATCH_EXPIRED', 'This batch has expired and cannot be sold.', 409);
      }

      const rate = new Decimal(line.rate ?? product.sellingprice ?? 0);
      const discountPct = new Decimal(line.discountPct ?? 0);
      if (discountPct.lt(0) || discountPct.gt(100)) throw new AppError('VALIDATION_ERROR', 'Discount must be between 0 and 100.', 400);

      resolvedLines.push({
        productId: product.id, batchId, qty, rate, discountPct,
        gstRate: new Decimal(product.gstrate), unitId: product.unitid, hsn: product.hsn, productName: product.name
      });
    }

    // 6-7. Recalculate subtotal/GST/grand total server-side — never trust client totals.
    const totals = calcInvoiceTotals(resolvedLines);

    // 8. Insert invoice
    const number = await nextSequence(client, 'invoice', 'SVP/25-26/', 4);
    const invoiceId = newId('inv');
    const dueDate = req.dueDate ? new Date(req.dueDate) : new Date(Date.now() + 15 * 86_400_000);
    await client.query(
      `INSERT INTO invoices (id, number, "customerId", "dueDate", subtotal, tax, "grandTotal", paid, balance, status, "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, 'UNPAID', $8)`,
      [invoiceId, number, req.customerId, dueDate, totals.subtotal.toFixed(2), totals.tax.toFixed(2), totals.grandTotal.toFixed(2), req.createdById]
    );

    // 9. Insert invoice items + 10. atomically decrement stock (guarded — throws INSUFFICIENT_STOCK on race)
    for (const line of resolvedLines) {
      await client.query(
        `INSERT INTO invoice_items (id, "invoiceId", "productId", "batchId", "warehouseId", qty, "unitId", rate, "discountPct", "gstRate", hsn)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [newId('ii'), invoiceId, line.productId, line.batchId, req.warehouseId, line.qty.toString(), line.unitId, line.rate.toFixed(2), line.discountPct.toFixed(2), line.gstRate.toFixed(2), line.hsn]
      );
      // Guarded atomic decrement — this is what makes two-simultaneous-sales-of-the-last-unit safe.
      await decrementBatchAtomic(client, line.batchId, line.qty);
      // 11. stock movement
      await insertStockMovement(client, { productId: line.productId, batchId: line.batchId, warehouseId: req.warehouseId, type: 'SALE', qty: line.qty, referenceId: number });
    }

    // Optional initial payment
    let paid = new Decimal(0);
    if (req.initialPayment && new Decimal(req.initialPayment.amount).gt(0)) {
      const amt = Decimal.min(new Decimal(req.initialPayment.amount), totals.grandTotal);
      paid = amt;
      await client.query(
        `INSERT INTO payments (id, "invoiceId", amount, method, reference, "createdById") VALUES ($1, $2, $3, $4, $5, $6)`,
        [newId('pay'), invoiceId, amt.toFixed(2), req.initialPayment.method, req.initialPayment.reference ?? null, req.createdById]
      );
      const balance = totals.grandTotal.minus(amt);
      const status = balance.lte(0.5) ? 'PAID' : 'PARTIALLY_PAID';
      await client.query(`UPDATE invoices SET paid = $1, balance = $2, status = $3 WHERE id = $4`, [amt.toFixed(2), balance.toFixed(2), status, invoiceId]);
    }

    // Audit log (customer ledger is a derived view over invoices+payments — no separate write needed)
    await client.query(
      `INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue")
       VALUES ($1, $2, 'Invoice created', 'invoice', $3, $4)`,
      [newId('au'), req.createdById, invoiceId, JSON.stringify({ number, grandTotal: totals.grandTotal.toFixed(2), warehouse: warehouse.name })]
    );

    return { id: invoiceId, number, subtotal: totals.subtotal, tax: totals.tax, grandTotal: totals.grandTotal, paid, balance: totals.grandTotal.minus(paid) };
  });
}
