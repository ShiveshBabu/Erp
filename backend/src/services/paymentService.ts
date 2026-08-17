import Decimal from 'decimal.js';
import { withTransaction } from '../lib/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/id';

function deriveStatus(balance: Decimal, paid: Decimal): 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CREDIT_DUE' {
  if (balance.lt(-0.5)) return 'CREDIT_DUE';
  if (balance.lte(0.5) && paid.gt(0)) return 'PAID';
  if (paid.gt(0)) return 'PARTIALLY_PAID';
  return 'UNPAID';
}

export async function recordPayment(params: { invoiceId: string; amount: string | number; method: string; reference?: string; createdById: string }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; number: string; balance: string; paid: string; status: string }>(
      `SELECT id, number, balance::text, paid::text, status FROM invoices WHERE id = $1 FOR UPDATE`,
      [params.invoiceId]
    );
    const inv = rows[0];
    if (!inv) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
    if (inv.status === 'CANCELLED') throw new AppError('INVOICE_CANCELLED', 'Cannot record a payment against a cancelled invoice.', 409);

    const amount = new Decimal(params.amount);
    if (!amount.gt(0)) throw new AppError('INVALID_PAYMENT_AMOUNT', 'Payment amount must be greater than 0.', 400);
    const balance = new Decimal(inv.balance);
    if (amount.gt(balance.plus(0.5))) {
      throw new AppError('PAYMENT_EXCEEDS_BALANCE', `Amount exceeds the outstanding balance of ${balance.toFixed(2)}.`, 409, { balance: balance.toFixed(2) });
    }

    const newBalance = balance.minus(amount);
    const newPaid = new Decimal(inv.paid).plus(amount);
    const status = deriveStatus(newBalance, newPaid);

    await client.query(`INSERT INTO payments (id, "invoiceId", amount, method, reference, "createdById") VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId('pay'), params.invoiceId, amount.toFixed(2), params.method, params.reference ?? null, params.createdById]);
    await client.query(`UPDATE invoices SET paid = $1, balance = $2, status = $3 WHERE id = $4`,
      [newPaid.toFixed(2), newBalance.toFixed(2), status, params.invoiceId]);
    await client.query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Payment recorded','invoice',$3,$4)`,
      [newId('au'), params.createdById, params.invoiceId, JSON.stringify({ amount: amount.toFixed(2), method: params.method, invoiceNumber: inv.number })]);

    return { invoiceId: params.invoiceId, balance: newBalance, paid: newPaid, status };
  });
}

export async function reversePayment(params: { paymentId: string; reversedById: string }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; invoiceid: string; amount: string; reversed: boolean }>(
      `SELECT id, "invoiceId" AS invoiceid, amount::text, reversed FROM payments WHERE id = $1 FOR UPDATE`,
      [params.paymentId]
    );
    const payment = rows[0];
    if (!payment) throw new AppError('NOT_FOUND', 'Payment not found.', 404);
    if (payment.reversed) throw new AppError('PAYMENT_ALREADY_REVERSED', 'This payment has already been reversed.', 409);

    const { rows: invRows } = await client.query<{ id: string; balance: string; paid: string; number: string }>(
      `SELECT id, balance::text, paid::text, number FROM invoices WHERE id = $1 FOR UPDATE`,
      [payment.invoiceid]
    );
    const inv = invRows[0]!;
    const amount = new Decimal(payment.amount);
    const newBalance = new Decimal(inv.balance).plus(amount);
    const newPaid = Decimal.max(0, new Decimal(inv.paid).minus(amount));
    const status = deriveStatus(newBalance, newPaid);

    await client.query(`UPDATE payments SET reversed = true, "reversedAt" = now() WHERE id = $1`, [params.paymentId]);
    await client.query(`UPDATE invoices SET paid = $1, balance = $2, status = $3 WHERE id = $4`,
      [newPaid.toFixed(2), newBalance.toFixed(2), status, inv.id]);
    await client.query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Payment reversed','invoice',$3,$4)`,
      [newId('au'), params.reversedById, inv.id, JSON.stringify({ amount: amount.toFixed(2), invoiceNumber: inv.number })]);

    return { invoiceId: inv.id, balance: newBalance, paid: newPaid, status };
  });
}

/** Invoice cancellation: rejected outright if any unreversed payment exists
 * (must reverse those first) — reverses stock effects, keeps the record
 * (status → CANCELLED), never deletes. */
export async function cancelInvoice(params: { invoiceId: string; reason: string; cancelledById: string }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; number: string; status: string; paid: string }>(
      `SELECT id, number, status, paid::text FROM invoices WHERE id = $1 FOR UPDATE`,
      [params.invoiceId]
    );
    const inv = rows[0];
    if (!inv) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
    if (inv.status === 'CANCELLED') throw new AppError('VALIDATION_ERROR', 'Invoice is already cancelled.', 400);

    const { rows: activePayments } = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM payments WHERE "invoiceId" = $1 AND reversed = false`,
      [params.invoiceId]
    );
    if (Number(activePayments[0]!.count) > 0) {
      throw new AppError('INVOICE_HAS_PAYMENTS', 'Cannot cancel — this invoice has active payments. Reverse them first.', 409);
    }

    const { rows: items } = await client.query<{ id: string; productid: string; batchid: string; warehouseid: string; qty: string }>(
      `SELECT id, "productId" AS productid, "batchId" AS batchid, "warehouseId" AS warehouseid, qty::text FROM invoice_items WHERE "invoiceId" = $1`,
      [params.invoiceId]
    );
    for (const item of items) {
      await client.query(`UPDATE batches SET qty = qty + $2 WHERE id = $1`, [item.batchid, item.qty]);
      await client.query(
        `INSERT INTO stock_movements (id, "productId", "batchId", "warehouseId", type, qty, "referenceId", note)
         VALUES ($1,$2,$3,$4,'INVOICE_CANCELLATION_REVERSAL',$5,$6,$7)`,
        [newId('mv'), item.productid, item.batchid, item.warehouseid, item.qty, inv.number, params.reason]
      );
    }

    await client.query(`UPDATE invoices SET status = 'CANCELLED', balance = 0, "cancelledAt" = now(), "cancelledById" = $2, "cancelReason" = $3 WHERE id = $1`,
      [params.invoiceId, params.cancelledById, params.reason]);
    await client.query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Invoice cancelled','invoice',$3,$4)`,
      [newId('au'), params.cancelledById, params.invoiceId, JSON.stringify({ reason: params.reason, invoiceNumber: inv.number })]);

    return { invoiceId: params.invoiceId, status: 'CANCELLED' as const };
  });
}
