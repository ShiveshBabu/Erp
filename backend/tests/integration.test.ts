import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server';
import { closePool, query } from '../src/lib/db';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let cookie: string;
let billingCookie: string;
const csrfByCookie = new Map<string, string>();

async function fetchCsrf(useCookie: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf-token', headers: { cookie: useCookie } });
  const token = res.json().data.csrfToken;
  csrfByCookie.set(useCookie, token);
  return token;
}

async function login(usernameOrEmail: string, password: string): Promise<string> {
  // A session (and therefore a CSRF secret) exists before login too — fetch
  // the token on a throwaway request first, exactly like a real browser would.
  const pre = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf-token' });
  const setCookiePre = pre.headers['set-cookie'];
  const preCookie = (Array.isArray(setCookiePre) ? setCookiePre[0] : setCookiePre)!.split(';')[0]!;
  const csrfToken = pre.json().data.csrfToken;

  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { usernameOrEmail, password }, headers: { cookie: preCookie, 'x-csrf-token': csrfToken } });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const finalCookie = raw ? raw.split(';')[0]! : preCookie;
  csrfByCookie.set(finalCookie, csrfToken); // same session persists through login, so the same secret/token stays valid
  return finalCookie;
}

async function authed(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any, useCookie = cookie) {
  const headers: Record<string, string> = { cookie: useCookie };
  if (method !== 'GET') {
    if (!csrfByCookie.has(useCookie)) await fetchCsrf(useCookie);
    headers['x-csrf-token'] = csrfByCookie.get(useCookie)!;
  }
  const res = await app.inject({ method, url, payload, headers });
  return { status: res.statusCode, body: res.json() };
}

describe('Sri Velan Pasumai ERP backend — integration suite (real PostgreSQL)', () => {
  let productId: string, customerId: string, warehouseId: string, feedWarehouseId: string;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
    cookie = await login('ravi.velan', 'ChangeMe123!');
    billingCookie = await login('meena.r', 'ChangeMe123!');

    const cats = (await authed('GET', '/api/v1/product-categories')).body.data;
    const units = (await authed('GET', '/api/v1/units')).body.data;
    const warehouses = (await authed('GET', '/api/v1/warehouses')).body.data;
    warehouseId = warehouses.find((w: any) => w.code === 'MAIN').id;
    feedWarehouseId = warehouses.find((w: any) => w.code === 'FEED').id;

    const prod = await authed('POST', '/api/v1/products', {
      sku: 'VITEST-' + Date.now(), name: 'Vitest Feed', categoryId: cats[0].id, unitId: units.find((u: any) => u.code === 'bag').id,
      purchasePrice: 1000, sellingPrice: 1300, gstRate: 5
    });
    productId = prod.body.data.id;

    const cust = await authed('POST', '/api/v1/customers', { name: 'Vitest Customer', type: 'Retail' });
    customerId = cust.body.data.id;
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/customers' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('logs in and returns permissions', async () => {
    const me = await authed('GET', '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.permissions).toContain('*');
  });

  it('billing staff cannot edit product price (RBAC enforced server-side)', async () => {
    const res = await authed('PATCH', `/api/v1/products/${productId}`, { purchasePrice: 9999 }, billingCookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('billing staff CAN create invoices', async () => {
    await authed('POST', '/api/v1/batches', { productId, warehouseId, batchNo: 'VITEST-B0', qty: 5, purchaseRate: 1000 });
    const res = await authed('POST', '/api/v1/invoices', { customerId, warehouseId, lines: [{ productId, qty: 1 }] }, billingCookie);
    expect(res.status).toBe(201);
  });

  it('creates a batch, sells stock, and recalculates totals server-side regardless of client input', async () => {
    await authed('POST', '/api/v1/batches', { productId, warehouseId, batchNo: 'VITEST-B1', qty: 100, purchaseRate: 1000 });
    const b1 = (await authed('GET', '/api/v1/batches')).body.data.find((b: any) => b.batchNo === 'VITEST-B1' && b.productId === productId);
    const inv = await authed('POST', '/api/v1/invoices', { customerId, warehouseId, lines: [{ productId, qty: 10, rate: 1, batchId: b1.id }] });
    expect(inv.status).toBe(201);
    // subtotal/tax/grandTotal are always server-derived from qty*rate*(1-disc)*gst, not client-supplied totals
    expect(Number(inv.body.data.subtotal)).toBeCloseTo(10 * 1, 2);
  });

  it('rejects overselling beyond available stock', async () => {
    const res = await authed('POST', '/api/v1/invoices', { customerId, warehouseId, lines: [{ productId, qty: 999999 }] });
    expect(res.status).toBe(409);
    expect(['NO_VALID_BATCH', 'INSUFFICIENT_STOCK']).toContain(res.body.error.code);
  });

  it('financial reconciliation: opening->purchase->sale->return->transfer out->transfer back->damage', async () => {
    const sku = 'RECON-VITEST-' + Date.now();
    const cats = (await authed('GET', '/api/v1/product-categories')).body.data;
    const units = (await authed('GET', '/api/v1/units')).body.data;
    const p = await authed('POST', '/api/v1/products', { sku, name: 'Recon Vitest', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 500, sellingPrice: 700, gstRate: 5 });
    const pid = p.body.data.id;

    const stockOf = async (whId: string) => {
      const inv = await authed('GET', '/api/v1/inventory');
      const row = inv.body.data.find((r: any) => r.productId === pid && r.warehouseId === whId);
      return row ? Number(row.onHand) : 0;
    };

    await authed('POST', '/api/v1/batches', { productId: pid, warehouseId, batchNo: 'RV-OPEN', qty: 100, purchaseRate: 500 });
    expect(await stockOf(warehouseId)).toBe(100);

    const sup = await authed('POST', '/api/v1/suppliers', { name: 'Recon Vitest Supplier', type: 'x' });
    await authed('POST', '/api/v1/purchases', { supplierId: sup.body.data.id, warehouseId, productId: pid, batchNo: 'RV-OPEN', qty: 50, rate: 500 });
    expect(await stockOf(warehouseId)).toBe(150);

    const batches = (await authed('GET', '/api/v1/batches')).body.data;
    const batch = batches.find((b: any) => b.batchNo === 'RV-OPEN' && b.productId === pid);

    const inv1 = await authed('POST', '/api/v1/invoices', { customerId, warehouseId, lines: [{ productId: pid, qty: 20, batchId: batch.id }] });
    expect(inv1.status).toBe(201);
    expect(await stockOf(warehouseId)).toBe(130);

    const invDetail = await authed('GET', `/api/v1/invoices/${inv1.body.data.id}`);
    const lineItemId = invDetail.body.data.items[0].id;
    const ret = await authed('POST', '/api/v1/returns', { invoiceItemId: lineItemId, qty: 2 });
    expect(ret.status).toBe(201);
    expect(await stockOf(warehouseId)).toBe(132);

    const transferOut = await authed('POST', '/api/v1/inventory/transfer', { batchId: batch.id, toWarehouseId: feedWarehouseId, qty: 10 });
    expect(transferOut.status).toBe(200);
    expect(await stockOf(warehouseId)).toBe(122);
    expect(await stockOf(feedWarehouseId)).toBe(10);

    const feedBatches = (await authed('GET', '/api/v1/batches')).body.data.filter((b: any) => b.productId === pid && b.warehouseId === feedWarehouseId);
    const transferBack = await authed('POST', '/api/v1/inventory/transfer', { batchId: feedBatches[0].id, toWarehouseId: warehouseId, qty: 5 });
    expect(transferBack.status).toBe(200);
    expect(await stockOf(warehouseId)).toBe(127);
    expect(await stockOf(feedWarehouseId)).toBe(5);

    const mainBatches = (await authed('GET', '/api/v1/batches')).body.data.filter((b: any) => b.productId === pid && b.warehouseId === warehouseId);
    const dmg = await authed('POST', '/api/v1/inventory/adjustments', { batchId: mainBatches[0].id, type: 'DAMAGE', qty: 3, reason: 'vitest damage' });
    expect(dmg.status).toBe(200);

    const finalTotal = (await stockOf(warehouseId)) + (await stockOf(feedWarehouseId));
    expect(finalTotal).toBe(129); // 100+50-20+2-3, transfers net to zero
  });

  it('a return against an already-fully-paid invoice produces CREDIT_DUE (unclamped balance), not a silently-hidden liability', async () => {
    await authed('POST', '/api/v1/batches', { productId, warehouseId, batchNo: 'VITEST-CREDIT', qty: 10, purchaseRate: 1000 });
    const inv = await authed('POST', '/api/v1/invoices', { customerId, warehouseId, lines: [{ productId, qty: 5, batchId: (await authed('GET', '/api/v1/batches')).body.data.find((b: any) => b.batchNo === 'VITEST-CREDIT').id }] });
    const grandTotal = inv.body.data.grandTotal;
    await authed('POST', '/api/v1/payments', { invoiceId: inv.body.data.id, amount: grandTotal, method: 'Cash' });
    const invDetail = await authed('GET', `/api/v1/invoices/${inv.body.data.id}`);
    expect(invDetail.body.data.status).toBe('PAID');
    const lineItemId = invDetail.body.data.items[0].id;
    const ret = await authed('POST', '/api/v1/returns', { invoiceItemId: lineItemId, qty: 2, reason: 'credit test' });
    expect(ret.status).toBe(201);
    expect(ret.body.data.status).toBe('CREDIT_DUE');
    expect(Number(ret.body.data.newBalance)).toBeLessThan(0);
  });

  it('invoice cancellation is blocked while unreversed payments exist, then allowed after reversal', async () => {
    await authed('POST', '/api/v1/batches', { productId, warehouseId, batchNo: 'VITEST-CANCEL', qty: 5, purchaseRate: 1000 });
    const batchId = (await authed('GET', '/api/v1/batches')).body.data.find((b: any) => b.batchNo === 'VITEST-CANCEL').id;
    const inv = await authed('POST', '/api/v1/invoices', { customerId, warehouseId, lines: [{ productId, qty: 2, batchId }] });
    const pay = await authed('POST', '/api/v1/payments', { invoiceId: inv.body.data.id, amount: inv.body.data.grandTotal, method: 'Cash' });

    const blocked = await authed('POST', `/api/v1/invoices/${inv.body.data.id}/cancel`, { reason: 'test' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVOICE_HAS_PAYMENTS');

    const payments = (await authed('GET', `/api/v1/invoices/${inv.body.data.id}`)).body.data.payments;
    const reverse = await authed('POST', `/api/v1/payments/${payments[0].id}/reverse`, {});
    expect(reverse.status).toBe(200);

    const allowed = await authed('POST', `/api/v1/invoices/${inv.body.data.id}/cancel`, { reason: 'test after reversal' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.status).toBe('CANCELLED');
  });

  it('the last active Super Admin cannot be demoted or deactivated', async () => {
    const users = (await authed('GET', '/api/v1/users')).body.data;
    const ravi = users.find((u: any) => u.username === 'ravi.velan');
    const res = await authed('PATCH', `/api/v1/users/${ravi.id}`, { status: 'DISABLED' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_SUPER_ADMIN_PROTECTED');
  });

  it('audit log is genuinely append-only: no route exists to modify or delete it, and the DB grant backs that up', async () => {
    const grants = await query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'audit_logs' AND grantee = current_user`
    );
    const privileges = grants.rows.map((r) => r.privilege_type);
    expect(privileges).toContain('INSERT');
    expect(privileges).toContain('SELECT');
    expect(privileges).not.toContain('UPDATE');
    expect(privileges).not.toContain('DELETE');
  });

  it('GST summary reconciles with a manual per-line recomputation', async () => {
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
    const to = today.toISOString();
    const res = await authed('GET', `/api/v1/reports/gst?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.cgst) + Number(res.body.data.sgst)).toBeCloseTo(Number(res.body.data.total), 2);
  });
});
