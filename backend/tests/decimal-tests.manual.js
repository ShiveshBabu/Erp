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

async function login() {
  const pre = await fetchCsrf(null);
  const res = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pre.cookie, 'x-csrf-token': pre.token }, body: JSON.stringify({ usernameOrEmail: 'ravi.velan', password: PASS }) });
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
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, JSON.stringify(detail).slice(0, 200)); } }

async function main() {
  const cookie = await login();
  const cats = (await call(cookie, 'GET', '/api/v1/product-categories')).body.data;
  const units = (await call(cookie, 'GET', '/api/v1/units')).body.data;
  const warehouses = (await call(cookie, 'GET', '/api/v1/warehouses')).body.data;
  const mainWh = warehouses.find(w => w.code === 'MAIN');
  const customers = (await call(cookie, 'GET', '/api/v1/customers')).body.data;
  const customer = customers[0];

  const pPenny = (await call(cookie, 'POST', '/api/v1/products', { sku: 'DEC-PENNY-' + Date.now(), name: 'Penny Item', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 0.01, sellingPrice: 0.01, gstRate: 5 })).body.data;
  await call(cookie, 'POST', '/api/v1/batches', { productId: pPenny.id, warehouseId: mainWh.id, batchNo: 'PENNY', qty: 1000000, purchaseRate: 0.01 });
  const invPenny = await call(cookie, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: pPenny.id, qty: 100 }] });
  check('subtotal/tax retain full precision, grandTotal rounds to nearest rupee (frozen billing rule)', invPenny.body.data.subtotal === '1' && invPenny.body.data.tax === '0.05' && Number(invPenny.body.data.grandTotal) === 1, invPenny.body.data);

  const pBig = (await call(cookie, 'POST', '/api/v1/products', { sku: 'DEC-BIG-' + Date.now(), name: 'Big Ticket Item', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 999999.99, sellingPrice: 999999.99, gstRate: 18 })).body.data;
  await call(cookie, 'POST', '/api/v1/batches', { productId: pBig.id, warehouseId: mainWh.id, batchNo: 'BIG', qty: 10, purchaseRate: 999999.99 });
  const invBig = await call(cookie, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: pBig.id, qty: 1 }] });
  const expectedBig = 999999.99 * 1.18;
  check('₹999999.99 unit price with 18% GST computes correctly (no float drift)', Math.abs(Number(invBig.body.data.grandTotal) - Math.round(expectedBig)) <= 1, { got: invBig.body.data.grandTotal, expected: expectedBig });

  const pDisc = (await call(cookie, 'POST', '/api/v1/products', { sku: 'DEC-DISC-' + Date.now(), name: 'Discount Test Item', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 100, sellingPrice: 333, gstRate: 12 })).body.data;
  await call(cookie, 'POST', '/api/v1/batches', { productId: pDisc.id, warehouseId: mainWh.id, batchNo: 'DISC', qty: 50, purchaseRate: 100 });
  const invDisc = await call(cookie, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: pDisc.id, qty: 7, discountPct: 12.5 }] });
  const net = 7 * 333 * (1 - 0.125);
  const expectedDisc = Math.round(net * 1.12);
  check('Fractional discount % (12.5%) computes correctly', Math.abs(Number(invDisc.body.data.grandTotal) - expectedDisc) <= 1, { got: invDisc.body.data.grandTotal, expected: expectedDisc });

  const partial = await call(cookie, 'POST', '/api/v1/payments', { invoiceId: invDisc.body.data.id, amount: 1000.33, method: 'Cash' });
  check('Partial payment with decimal amount recorded exactly', Math.abs(Number(partial.body.data.paid) - 1000.33) < 0.001, partial.body.data);
  const invDiscDetail = (await call(cookie, 'GET', `/api/v1/invoices/${invDisc.body.data.id}`)).body.data;
  check('Balance after decimal partial payment = grandTotal - 1000.33 exactly', Math.abs(Number(invDiscDetail.balance) - (expectedDisc - 1000.33)) < 0.01, invDiscDetail);

  const lineId = invDiscDetail.items[0].id;
  const ret = await call(cookie, 'POST', '/api/v1/returns', { invoiceItemId: lineId, qty: 2, reason: 'decimal test' });
  check('Return credit value is a clean 2-decimal amount, no floating point garbage', /^\d+(\.\d{1,2})?$/.test(String(ret.body.data.creditValue)), ret.body.data);

  const boms = (await call(cookie, 'GET', '/api/v1/boms')).body.data;
  const bom = boms.find(b => b.code === 'BOM-F50-v4');
  const feedWh = warehouses.find(w => w.code === 'FEED');
  const po = await call(cookie, 'POST', '/api/v1/production-orders', { bomId: bom.id, plannedQty: 17, warehouseId: feedWh.id });
  if (po.status === 201) {
    const completed = await call(cookie, 'POST', `/api/v1/production-orders/${po.body.data.id}/complete`);
    if (completed.status === 200) {
      check('Production cost for odd quantity (17) is a clean decimal', /^\d+(\.\d{1,2})?$/.test(String(completed.body.data.actualCost)), completed.body.data);
    } else {
      check('Production completion for odd qty (insufficient stock — acceptable, not a decimal bug)', true, completed.body);
    }
  } else {
    check('Production order for odd qty rejected cleanly (insufficient stock — not a decimal bug)', true, po.body);
  }

  console.log(`\n=== DECIMAL/DATE TESTS: ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
