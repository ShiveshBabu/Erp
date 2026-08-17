import Decimal from 'decimal.js';
import { query } from '../lib/db';

/** All money math goes through Decimal — never native JS floats — for
 * persisted financial amounts, per instruction. */

export interface LineInput {
  qty: Decimal.Value;
  rate: Decimal.Value;
  discountPct: Decimal.Value;
  gstRate: Decimal.Value;
}

export interface LineCalc {
  net: Decimal;
  tax: Decimal;
  total: Decimal;
}

export function calcLine(line: LineInput): LineCalc {
  const qty = new Decimal(line.qty);
  const rate = new Decimal(line.rate);
  const discountPct = new Decimal(line.discountPct);
  const gstRate = new Decimal(line.gstRate);

  const gross = qty.mul(rate);
  const net = gross.mul(new Decimal(1).minus(discountPct.div(100)));
  const tax = net.mul(gstRate).div(100);
  return { net, tax, total: net.plus(tax) };
}

export function calcInvoiceTotals(lines: LineInput[]): { subtotal: Decimal; tax: Decimal; grandTotal: Decimal } {
  let subtotal = new Decimal(0);
  let tax = new Decimal(0);
  for (const line of lines) {
    const c = calcLine(line);
    subtotal = subtotal.plus(c.net);
    tax = tax.plus(c.tax);
  }
  return { subtotal, tax, grandTotal: subtotal.plus(tax).toDecimalPlaces(0) };
}

export async function customerOutstanding(customerId: string): Promise<Decimal> {
  const { rows } = await query<{ sum: string | null }>(
    `SELECT SUM(balance)::text AS sum FROM invoices WHERE "customerId" = $1 AND status != 'CANCELLED'`,
    [customerId]
  );
  return new Decimal(rows[0]?.sum ?? 0);
}

export async function supplierPayable(supplierId: string): Promise<Decimal> {
  const { rows } = await query<{ sum: string | null }>(
    `SELECT SUM(balance)::text AS sum FROM purchase_bills WHERE "supplierId" = $1 AND status != 'CANCELLED'`,
    [supplierId]
  );
  return new Decimal(rows[0]?.sum ?? 0);
}

export interface GstSummary {
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  total: Decimal;
  byRate: { rate: string; taxable: Decimal; tax: Decimal }[];
}

/** Recomputed line-by-line from stored invoice_items for the period — never
 * a cached/stored total, per the frozen rule. */
export async function gstSummary(from: Date, to: Date): Promise<GstSummary> {
  const { rows } = await query<{ qty: string; rate: string; discountpct: string; gstrate: string }>(
    `SELECT ii.qty, ii.rate, ii."discountPct" AS discountpct, ii."gstRate" AS gstrate
     FROM invoice_items ii JOIN invoices i ON i.id = ii."invoiceId"
     WHERE i.status != 'CANCELLED' AND i.date >= $1 AND i.date <= $2`,
    [from, to]
  );
  let taxable = new Decimal(0);
  let cgst = new Decimal(0);
  let sgst = new Decimal(0);
  const byRateMap = new Map<string, { taxable: Decimal; tax: Decimal }>();

  for (const r of rows) {
    const { net, tax } = calcLine({ qty: r.qty, rate: r.rate, discountPct: r.discountpct, gstRate: r.gstrate });
    taxable = taxable.plus(net);
    cgst = cgst.plus(tax.div(2));
    sgst = sgst.plus(tax.div(2));
    const key = `${r.gstrate}%`;
    const bucket = byRateMap.get(key) ?? { taxable: new Decimal(0), tax: new Decimal(0) };
    bucket.taxable = bucket.taxable.plus(net);
    bucket.tax = bucket.tax.plus(tax);
    byRateMap.set(key, bucket);
  }

  return {
    taxable, cgst, sgst, total: cgst.plus(sgst),
    byRate: [...byRateMap.entries()].map(([rate, v]) => ({ rate, ...v }))
  };
}

export interface ProfitSummary {
  revenue: Decimal;
  cogs: Decimal;
  gross: Decimal;
  expenses: Decimal;
  net: Decimal;
}

export async function profitSummary(from: Date, to: Date): Promise<ProfitSummary> {
  const { rows: invRows } = await query<{ grandtotal: string }>(
    `SELECT "grandTotal" AS grandtotal FROM invoices WHERE status != 'CANCELLED' AND date >= $1 AND date <= $2`,
    [from, to]
  );
  const revenue = invRows.reduce((a, r) => a.plus(r.grandtotal), new Decimal(0));

  const { rows: cogsRows } = await query<{ qty: string; purchaseprice: string }>(
    `SELECT ii.qty, p."purchasePrice" AS purchaseprice
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii."invoiceId"
     JOIN products p ON p.id = ii."productId"
     WHERE i.status != 'CANCELLED' AND i.date >= $1 AND i.date <= $2`,
    [from, to]
  );
  const cogs = cogsRows.reduce((a, r) => a.plus(new Decimal(r.qty).mul(r.purchaseprice)), new Decimal(0));

  const { rows: expRows } = await query<{ amount: string }>(
    `SELECT amount FROM expenses WHERE date >= $1 AND date <= $2`,
    [from, to]
  );
  const expenses = expRows.reduce((a, r) => a.plus(r.amount), new Decimal(0));

  const gross = revenue.minus(cogs);
  return { revenue, cogs, gross, expenses, net: gross.minus(expenses) };
}
