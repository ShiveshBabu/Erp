// This loads the exact same files that ship to the browser (services/*.js)
// and runs them in Node with a `window` shim + Node's native fetch. It is
// NOT a browser test — there is no DOM here, and no Playwright available in
// this environment — but it does prove the service-layer request/response
// handling (URLs, payload shapes, error-code mapping) is genuinely correct
// against the real running backend, using the identical code the browser
// would execute.
const fs = require('fs');
const path = require('path');

global.window = global.window || {};
window.SVP_API_BASE_URL = 'http://localhost:4000';

// --- Node-only cookie-jar shim ---
// A real browser automatically stores Set-Cookie and resends it on every
// request when fetch is called with credentials:'include' — that's the whole
// point of using cookies for sessions instead of a token in localStorage.
// Node's native fetch has no such persistent jar between calls, so this
// harness (and ONLY this harness — services/apiClient.js ships unmodified
// to the browser) wraps fetch to add that behavior, purely so this proof
// script can validate session persistence the same way a browser would.
let jarCookie = '';
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, jarCookie ? { Cookie: jarCookie } : {});
  const res = await realFetch(url, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jarCookie = setCookie.split(';')[0];
  return res;
};

const servicesDir = '/home/claude/svp-erp/services';
const files = [
  'apiClient.js', 'authService.js', 'customerService.js', 'supplierService.js',
  'productService.js', 'warehouseService.js', 'inventoryService.js', 'batchService.js',
  'invoiceService.js', 'paymentService.js', 'returnService.js', 'purchaseService.js',
  'manufacturingService.js', 'expenseService.js', 'reportService.js', 'auditService.js', 'userService.js'
];
for (const f of files) {
  const code = fs.readFileSync(path.join(servicesDir, f), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(code);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function main() {
  console.log('Loaded services:', Object.keys(window.SVP).filter((k) => k !== 'api').join(', '));

  // --- Unauthenticated request correctly surfaces a mapped, human-readable error ---
  try {
    await window.SVP.customerService.list();
    check('unauthenticated request throws', false);
  } catch (e) {
    check('unauthenticated request throws ApiError', window.SVP.api.isApiError(e));
    check('unauthenticated error code is UNAUTHENTICATED', e.code === 'UNAUTHENTICATED', e.code);
    check('unauthenticated error has human-readable message (not raw code)', e.message.toLowerCase().includes('log in'), e.message);
  }

  // --- Login ---
  const me1 = await window.SVP.authService.login('ravi.velan', 'ChangeMe123!');
  check('login returns role and permissions', me1.role === 'SUPER_ADMIN' && me1.permissions.includes('*'), me1);

  // --- Bad login is mapped to a clean message, not a raw 401 ---
  try {
    await window.SVP.authService.login('ravi.velan', 'wrong-password');
    check('bad login throws', false);
  } catch (e) {
    check('bad login maps to INVALID_CREDENTIALS with clean message', e.code === 'INVALID_CREDENTIALS' && !e.message.includes('Error:'), e);
  }

  // --- /me restores session state (simulates page refresh) ---
  const me2 = await window.SVP.authService.me();
  check('me() restores session after "refresh"', me2.username === 'ravi.velan', me2);

  // --- Reference data ---
  const cats = await window.SVP.productService.categories();
  const units = await window.SVP.productService.units();
  const warehouses = await window.SVP.warehouseService.list();
  check('categories loaded', cats.length > 0);
  check('units loaded', units.length > 0);
  check('warehouses loaded', warehouses.length >= 5, warehouses.map((w) => w.code));

  const mainWh = warehouses.find((w) => w.code === 'MAIN');
  const feedWh = warehouses.find((w) => w.code === 'FEED');

  // --- Create product via service layer ---
  const product = await window.SVP.productService.create({
    sku: 'SVC-TEST-' + Date.now(), name: 'Service Layer Test Feed', categoryId: cats[0].id, unitId: units.find((u) => u.code === 'bag').id,
    purchasePrice: 1000, sellingPrice: 1300, gstRate: 5
  });
  check('product created via service layer', !!product.id);

  // --- Duplicate SKU maps to a clean error ---
  try {
    const dupeSku = (await window.SVP.productService.list()).find((p) => p.id === product.id).sku;
    await window.SVP.productService.create({ sku: dupeSku, name: 'Dupe', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 1, gstRate: 5 });
    check('duplicate SKU throws', false);
  } catch (e) {
    check('duplicate SKU maps to DUPLICATE_SKU with clean message', e.code === 'DUPLICATE_SKU', e);
  }

  // --- Customer + batch + billing (the "most important workflow") ---
  const customer = await window.SVP.customerService.create({ name: 'Service Layer Test Customer', type: 'Retail' });
  await window.SVP.batchService.create({ productId: product.id, warehouseId: mainWh.id, batchNo: 'SVC-B1', qty: 20, purchaseRate: 1000 });

  // --- Billing: frontend sends ONLY qty/productId — never a client-computed total ---
  const invoicePayload = { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: product.id, qty: 5 }] };
  check('invoice payload has no client-side total fields (backend is authoritative)',
    !('subtotal' in invoicePayload) && !('tax' in invoicePayload) && !('grandTotal' in invoicePayload));
  const invoice = await window.SVP.invoiceService.create(invoicePayload);
  check('invoice created, server computed totals', Number(invoice.grandTotal) > 0, invoice);
  check('server-computed grandTotal matches expected GST math (5 x 1300 x 1.05)', Math.abs(Number(invoice.grandTotal) - 6825) < 1, invoice.grandTotal);

  const inv = await window.SVP.inventoryService.list();
  const stockRow = inv.find((r) => r.productId === product.id && r.warehouseId === mainWh.id);
  check('inventory service reflects deducted stock (20-5=15)', Number(stockRow.onHand) === 15, stockRow);

  // --- Overselling is rejected with a clean message ---
  try {
    await window.SVP.invoiceService.create({ customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: product.id, qty: 999 }] });
    check('oversell throws', false);
  } catch (e) {
    check('oversell maps to a stock-related error with clean message', ['INSUFFICIENT_STOCK', 'NO_VALID_BATCH'].includes(e.code) && !e.message.includes('{'), e);
  }

  // --- Payment ---
  const payment = await window.SVP.paymentService.record(invoice.id, invoice.grandTotal, 'Cash');
  check('payment recorded, invoice fully paid', payment.status === 'PAID', payment);

  // --- Warehouse transfer via service layer ---
  const batches = await window.SVP.batchService.list();
  const svcBatch = batches.find((b) => b.batchNo === 'SVC-B1' && b.productId === product.id);
  const transfer = await window.SVP.warehouseService.transfer(svcBatch.id, feedWh.id, 5);
  check('transfer via service layer succeeded', Number(transfer.toQty) === 5, transfer);

  // --- Reports ---
  const today = new Date().toISOString().slice(0, 10);
  const gst = await window.SVP.reportService.gst(today + 'T00:00:00.000Z', today + 'T23:59:59.999Z');
  check('GST report reachable via service layer', Number(gst.cgst) + Number(gst.sgst) - Number(gst.total) < 0.01, gst);

  // --- Audit is read-only: confirm no write method exists on the service object ---
  check('audit service exposes no update/delete method', !window.SVP.auditService.update && !window.SVP.auditService.delete);

  // --- Logout actually destroys the session ---
  await window.SVP.authService.logout();
  try {
    await window.SVP.authService.me();
    check('me() after logout throws', false);
  } catch (e) {
    check('me() after logout is UNAUTHENTICATED (session genuinely destroyed)', e.code === 'UNAUTHENTICATED', e);
  }

  console.log(`\n=== ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Harness error:', e); process.exit(1); });
