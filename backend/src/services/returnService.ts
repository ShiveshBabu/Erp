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

export async function recordSalesReturn(params: { invoiceItemId: string; qty: string | number; reason?: string; createdById: string }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string; invoiceid: string; productid: string; batchid: string; warehouseid: string;
      qty: string; rate: string; discountpct: string; gstrate: string;
    }>(
      `SELECT id, "invoiceId" AS invoiceid, "productId" AS productid, "batchId" AS batchid, "warehouseId" AS warehouseid,
              qty::text, rate::text, "discountPct"::text AS discountpct, "gstRate"::text AS gstrate
       FROM invoice_items WHERE id = $1 FOR UPDATE`,
      [params.invoiceItemId]
    );
    const item = rows[0];
    if (!item) throw new AppError('NOT_FOUND', 'Invoice line item not found.', 404);

    const qty = new Decimal(params.qty);
    const remaining = new Decimal(item.qty);
    if (!qty.gt(0) || qty.gt(remaining)) {
      throw new AppError('VALIDATION_ERROR', `Enter a quantity between 1 and ${remaining.toString()}.`, 400);
    }

    const net = remaining.mul(item.rate).mul(new Decimal(1).minus(new Decimal(item.discountpct).div(100)));
    const tax = net.mul(item.gstrate).div(100);
    const lineTotal = net.plus(tax);
    const creditValue = lineTotal.div(remaining).mul(qty).toDecimalPlaces(0);

    const { rows: invRows } = await client.query<{ id: string; number: string; grandtotal: string; balance: string; paid: string }>(
      `SELECT id, number, "grandTotal"::text AS grandtotal, balance::text, paid::text FROM invoices WHERE id = $1 FOR UPDATE`,
      [item.invoiceid]
    );
    const inv = invRows[0]!;
    const newGrandTotal = Decimal.max(0, new Decimal(inv.grandtotal).minus(creditValue));
    // Do NOT clamp balance to zero: a return against an already-paid invoice
    // is a real credit owed back to the customer (CREDIT_DUE), per the
    // frozen rule (this was a real bug found and fixed in the demo build).
    const newBalance = new Decimal(inv.balance).minus(creditValue);
    const status = deriveStatus(newBalance, new Decimal(inv.paid));

    await client.query(`UPDATE invoice_items SET qty = qty - $2 WHERE id = $1`, [params.invoiceItemId, qty.toString()]);
    await client.query(`UPDATE invoices SET "grandTotal" = $2, balance = $3, status = $4 WHERE id = $1`,
      [item.invoiceid, newGrandTotal.toFixed(2), newBalance.toFixed(2), status]);

    const returnId = newId('sr');
    await client.query(`INSERT INTO sales_returns (id, "invoiceId", reason, "creditValue") VALUES ($1,$2,$3,$4)`,
      [returnId, item.invoiceid, params.reason ?? null, creditValue.toFixed(2)]);
    await client.query(`INSERT INTO sales_return_items (id, "salesReturnId", "invoiceItemId", qty) VALUES ($1,$2,$3,$4)`,
      [newId('sri'), returnId, params.invoiceItemId, qty.toString()]);

    await client.query(`UPDATE batches SET qty = qty + $2 WHERE id = $1`, [item.batchid, qty.toString()]);
    await client.query(
      `INSERT INTO stock_movements (id, "productId", "batchId", "warehouseId", type, qty, "referenceId", note)
       VALUES ($1,$2,$3,$4,'SALES_RETURN',$5,$6,$7)`,
      [newId('mv'), item.productid, item.batchid, item.warehouseid, qty.toString(), inv.number, params.reason ?? '']
    );
    await client.query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'Sales return','invoice',$3,$4)`,
      [newId('au'), params.createdById, item.invoiceid, JSON.stringify({ qty: qty.toString(), creditValue: creditValue.toFixed(2), invoiceNumber: inv.number })]);

    return { invoiceId: item.invoiceid, creditValue, newBalance, status };
  });
}
