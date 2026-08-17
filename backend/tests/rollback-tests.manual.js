const BASE = 'http://localhost:4000';
const PASS = process.env.DEV_SEED_PASSWORD || 'ChangeMe123!';
const csrfByCookie = new Map();

async function fetchCsrf(cookie) {
  const res = await fetch(BASE + '/api/v1/auth/csrf-token', { headers: cookie ? { Cookie: cookie } : {} });
  const setCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const body = await res.json();
  const finalCookie = cookie || setCookie;
  csrfByCookie.set(finalCookie, body.data.csrfToken);
  return { cookie: finalCookie, token: body.data.csrfToken };
}

async function login(usernameOrEmail) {
  const pre = await fetchCsrf(null);
  const res = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pre.cookie, 'x-csrf-token': pre.token }, body: JSON.stringify({ usernameOrEmail, password: PASS }) });
  const setCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const cookie = setCookie || pre.cookie;
  csrfByCookie.set(cookie, pre.token);
  return cookie;
}
async function call(cookie, method, path, payload) {
  const body = payload !== undefined ? payload : (method === 'POST' ? {} : undefined);
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  if (method !== 'GET') {
    if (!csrfByCookie.has(cookie)) await fetchCsrf(cookie);
    headers['x-csrf-token'] = csrfByCookie.get(cookie);
  }
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const respBody = await res.json().catch(() => ({}));
  return { status: res.status, body: respBody };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''); }
}

async function main() {
  const admin = await login('ravi.velan');

  const cats = (await call(admin, 'GET', '/api/v1/product-categories')).body.data;
  const units = (await call(admin, 'GET', '/api/v1/units')).body.data;
  const warehouses = (await call(admin, 'GET', '/api/v1/warehouses')).body.data;
  const mainWh = warehouses.find(w => w.code === 'MAIN');
  const feedWh = warehouses.find(w => w.code === 'FEED');
  const customers = (await call(admin, 'GET', '/api/v1/customers')).body.data;
  const customer = customers[0];

  async function stockOf(productId, warehouseId) {
    const inv = (await call(admin, 'GET', '/api/v1/inventory')).body.data;
    const row = inv.find(r => r.productId === productId && r.warehouseId === warehouseId);
    return row ? Number(row.onHand) : 0;
  }
  async function invoiceCount() {
    return (await call(admin, 'GET', '/api/v1/invoices')).body.data.length;
  }

  const p1 = (await call(admin, 'POST', '/api/v1/products', { sku: 'ROLLBACK-1-' + Date.now(), name: 'Rollback Test 1', categoryId: cats[0].id, unitId: units.find(u => u.code === 'bag').id, purchasePrice: 100, sellingPrice: 150, gstRate: 5 })).body.data;
  await call(admin, 'POST', '/api/v1/batches', { productId: p1.id, warehouseId: mainWh.id, batchNo: 'RB1', qty: 5, purchaseRate: 100 });
  const before1 = await stockOf(p1.id, mainWh.id);
  const invBefore1 = await invoiceCount();
  const fail1 = await call(admin, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: p1.id, qty: 999 }] });
  check('T1: Oversell rejected with 409', fail1.status === 409, fail1.body);
  check('T1: Stock unchanged after failed invoice', (await stockOf(p1.id, mainWh.id)) === before1);
  check('T1: No invoice created after failure', (await invoiceCount()) === invBefore1);

  const p2a = (await call(admin, 'POST', '/api/v1/products', { sku: 'ROLLBACK-2A-' + Date.now(), name: 'Rollback 2A', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 100, sellingPrice: 150, gstRate: 5 })).body.data;
  const p2b = (await call(admin, 'POST', '/api/v1/products', { sku: 'ROLLBACK-2B-' + Date.now(), name: 'Rollback 2B', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 100, sellingPrice: 150, gstRate: 5 })).body.data;
  await call(admin, 'POST', '/api/v1/batches', { productId: p2a.id, warehouseId: mainWh.id, batchNo: 'RB2A', qty: 100, purchaseRate: 100 });
  const before2a = await stockOf(p2a.id, mainWh.id);
  const invBefore2 = await invoiceCount();
  const fail2 = await call(admin, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: p2a.id, qty: 10 }, { productId: p2b.id, qty: 10 }] });
  check('T2: Multi-line invoice with one bad line rejected', fail2.status >= 400, fail2.body);
  check('T2: First (valid) line stock NOT deducted — full rollback, no partial deduction', (await stockOf(p2a.id, mainWh.id)) === before2a, { before: before2a, after: await stockOf(p2a.id, mainWh.id) });
  check('T2: No invoice created despite valid first line', (await invoiceCount()) === invBefore2);

  await call(admin, 'POST', '/api/v1/batches', { productId: p2a.id, warehouseId: mainWh.id, batchNo: 'RB2A-2', qty: 10, purchaseRate: 100 });
  const inv3 = (await call(admin, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: p2a.id, qty: 5 }] })).body.data;
  const overpay = await call(admin, 'POST', '/api/v1/payments', { invoiceId: inv3.id, amount: Number(inv3.grandTotal) + 1000, method: 'Cash' });
  check('T3: Overpayment rejected', overpay.status === 409 && overpay.body.error.code === 'PAYMENT_EXCEEDS_BALANCE', overpay.body);
  const inv3After = (await call(admin, 'GET', `/api/v1/invoices/${inv3.id}`)).body.data;
  check('T3: Invoice balance unchanged after rejected overpayment', Number(inv3After.balance) === Number(inv3.balance));

  await call(admin, 'POST', '/api/v1/payments', { invoiceId: inv3.id, amount: Number(inv3.grandTotal), method: 'Cash' });
  const inv3Detail = (await call(admin, 'GET', `/api/v1/invoices/${inv3.id}`)).body.data;
  const paymentId = inv3Detail.payments[inv3Detail.payments.length - 1].id;
  const rev1 = await call(admin, 'POST', `/api/v1/payments/${paymentId}/reverse`);
  check('T4: First reversal succeeds', rev1.status === 200, rev1.body);
  const rev2 = await call(admin, 'POST', `/api/v1/payments/${paymentId}/reverse`);
  check('T4: Second reversal of same payment rejected', rev2.status === 409 && rev2.body.error.code === 'PAYMENT_ALREADY_REVERSED', rev2.body);

  const invDetail5 = (await call(admin, 'GET', `/api/v1/invoices/${inv3.id}`)).body.data;
  const lineId5 = invDetail5.items[0].id;
  const badReturn = await call(admin, 'POST', '/api/v1/returns', { invoiceItemId: lineId5, qty: 999 });
  check('T5: Return quantity exceeding line qty rejected', badReturn.status >= 400, badReturn.body);

  const batches6 = (await call(admin, 'GET', '/api/v1/batches')).body.data;
  const b6 = batches6.find(b => b.batchNo === 'RB2A-2');
  const beforeTransferSrc = await stockOf(p2a.id, mainWh.id);
  const badTransfer = await call(admin, 'POST', '/api/v1/inventory/transfer', { batchId: b6.id, toWarehouseId: feedWh.id, qty: 99999 });
  check('T6: Transfer exceeding available qty rejected', badTransfer.status >= 400, badTransfer.body);
  check('T6: Source stock unchanged after failed transfer', (await stockOf(p2a.id, mainWh.id)) === beforeTransferSrc);

  const boms = (await call(admin, 'GET', '/api/v1/boms')).body.data;
  const bom = boms.find(b => b.code === 'BOM-F50-v4');
  const poFail = await call(admin, 'POST', '/api/v1/production-orders', { bomId: bom.id, plannedQty: 999999999, warehouseId: feedWh.id });
  check('T7: Production order with impossible qty rejected at creation (insufficient material)', poFail.status >= 400, poFail.body);

  const medProd = (await call(admin, 'GET', '/api/v1/products')).body.data.find(p => p.sku === 'SVP-MED-CG5');
  const medWh = warehouses.find(w => w.code === 'MED');
  const expBatch = await call(admin, 'POST', '/api/v1/batches', { productId: medProd.id, warehouseId: medWh.id, batchNo: 'EXPIRED-TEST-' + Date.now(), qty: 20, expiryDate: '2020-01-01', purchaseRate: 300 });
  check('T8-setup: Expired batch created for testing', expBatch.status === 201, expBatch.body);
  const expiredBatchId = expBatch.body.data.id;
  const sellExpired = await call(admin, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: medWh.id, lines: [{ productId: medProd.id, qty: 1, batchId: expiredBatchId }] });
  check('T8: Selling an expired batch is rejected (BATCH_EXPIRED)', sellExpired.status === 409 && sellExpired.body.error.code === 'BATCH_EXPIRED', sellExpired.body);
  const transferExpired = await call(admin, 'POST', '/api/v1/inventory/transfer', { batchId: expiredBatchId, toWarehouseId: mainWh.id, qty: 1 });
  check('T9: Transfer of an expired batch is rejected (BATCH_EXPIRED)', transferExpired.status === 409 && transferExpired.body.error.code === 'BATCH_EXPIRED', transferExpired.body);

  const dupSku = 'DUP-SKU-TEST-' + Date.now();
  await call(admin, 'POST', '/api/v1/products', { sku: dupSku, name: 'First', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 1, gstRate: 5 });
  const dup1 = await call(admin, 'POST', '/api/v1/products', { sku: dupSku, name: 'Duplicate', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 1, gstRate: 5 });
  check('T11: Duplicate SKU rejected', dup1.status === 409 && dup1.body.error.code === 'DUPLICATE_SKU', dup1.body);

  const dupBatchNo = 'DUP-BATCH-' + Date.now();
  await call(admin, 'POST', '/api/v1/batches', { productId: p1.id, warehouseId: mainWh.id, batchNo: dupBatchNo, qty: 5, purchaseRate: 100 });
  const dup2 = await call(admin, 'POST', '/api/v1/batches', { productId: p1.id, warehouseId: mainWh.id, batchNo: dupBatchNo, qty: 5, purchaseRate: 100 });
  check('T12: Duplicate batch (product+warehouse+batchNo) rejected', dup2.status === 409 && dup2.body.error.code === 'DUPLICATE_BATCH', dup2.body);

  const dupBomRes = await call(admin, 'POST', '/api/v1/boms', {
    code: 'DUP-MATERIAL-BOM-' + Date.now(), outputProductId: p1.id, batchSize: 10,
    items: [{ materialProductId: p2a.id, qty: 1, unitId: units[0].id }, { materialProductId: p2a.id, qty: 2, unitId: units[0].id }]
  });
  check('T13: Duplicate material in same BOM rejected', dupBomRes.status === 409 && dupBomRes.body.error.code === 'DUPLICATE_MATERIAL_IN_BOM', dupBomRes.body);

  await call(admin, 'POST', '/api/v1/batches', { productId: p1.id, warehouseId: mainWh.id, batchNo: 'RB14-' + Date.now(), qty: 10, purchaseRate: 100 });
  const inv14 = (await call(admin, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: p1.id, qty: 2 }] })).body.data;
  await call(admin, 'POST', '/api/v1/payments', { invoiceId: inv14.id, amount: 50, method: 'Cash' });
  const cancelWithPayment = await call(admin, 'POST', `/api/v1/invoices/${inv14.id}/cancel`, { reason: 'test' });
  check('T14: Cannot cancel invoice with active payment', cancelWithPayment.status === 409 && cancelWithPayment.body.error.code === 'INVOICE_HAS_PAYMENTS', cancelWithPayment.body);

  const badFk = await call(admin, 'POST', '/api/v1/invoices', { customerId: 'does-not-exist', warehouseId: mainWh.id, lines: [{ productId: p1.id, qty: 1 }] });
  check('T15: Invalid customer FK rejected with NOT_FOUND', badFk.status === 404 && badFk.body.error.code === 'NOT_FOUND', badFk.body);

  const badRole = await call(admin, 'POST', '/api/v1/users', { name: 'x', email: 'badrole@test.com', username: 'badrole', role: 'NOT_A_REAL_ROLE', password: 'testpass123' });
  check('T16: Invalid role value rejected (zod validation)', badRole.status === 400, badRole.body);

  console.log(`\n=== TRANSACTION/ROLLBACK TESTS: ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
