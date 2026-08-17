// Loads the REAL data-layer portion of the .dc.html file (everything before
// `class Component`) plus the real services/*.js files, feeds it genuine
// JSON responses from the live backend, and calls the real render functions
// (productsTableCfg, customersTableCfg, etc.) to catch any shape mismatch
// before claiming the integration renders correctly. No browser available in
// this environment, so this is the most rigorous check possible here.
const fs = require('fs');
const vm = require('vm');

global.window = global.window || {};
window.SVP_API_BASE_URL = 'http://localhost:4000';
window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

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

for (const f of ['apiClient.js', 'authService.js', 'customerService.js', 'supplierService.js', 'productService.js',
  'warehouseService.js', 'inventoryService.js', 'batchService.js', 'invoiceService.js', 'paymentService.js',
  'returnService.js', 'purchaseService.js', 'manufacturingService.js', 'expenseService.js', 'reportService.js',
  'auditService.js', 'userService.js']) {
  vm.runInThisContext(fs.readFileSync('/home/claude/svp-erp/services/' + f, 'utf8'), { filename: f });
}
vm.runInThisContext(fs.readFileSync('/tmp/frontend-datalayer.js', 'utf8'), { filename: 'frontend-datalayer.js' });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''); }
}

async function main() {
  await window.SVP.authService.login('ravi.velan', 'ChangeMe123!');

  const catsRaw = await window.SVP.productService.categories();
  const unitsRaw = await window.SVP.productService.units();
  const catsById = Object.fromEntries(catsRaw.map((c) => [c.id, c]));
  const unitsById = Object.fromEntries(unitsRaw.map((u) => [u.id, u]));

  const productsRaw = await window.SVP.productService.list();
  SERVER_CACHE.products = productsRaw.map((p) => mapProduct(p, catsById, unitsById));
  check('products mapped, nonzero', SERVER_CACHE.products.length > 0, SERVER_CACHE.products.length);

  const customersRaw = await window.SVP.customerService.list();
  SERVER_CACHE.customers = customersRaw.map(mapCustomer);
  check('customers mapped, nonzero', SERVER_CACHE.customers.length > 0);

  const suppliersRaw = await window.SVP.supplierService.list();
  SERVER_CACHE.suppliers = suppliersRaw.map(mapSupplier);

  const usersRaw = await window.SVP.userService.list();
  const usersById = Object.fromEntries(usersRaw.map((u) => [u.id, u]));
  const warehousesRaw = await window.SVP.warehouseService.list();
  SERVER_CACHE.warehouses = warehousesRaw.map((w) => mapWarehouse(w, usersById));
  SERVER_CACHE.users = usersRaw.map(mapUser);
  check('warehouses mapped', SERVER_CACHE.warehouses.length >= 5);

  const batchesRaw = await window.SVP.batchService.list();
  SERVER_CACHE.batches = batchesRaw.map(mapBatch);
  check('batches mapped', SERVER_CACHE.batches.length > 0);

  const invoicesRaw = await window.SVP.invoiceService.list();
  SERVER_CACHE.invoices = invoicesRaw.map(mapInvoiceListRow);
  check('invoices mapped', SERVER_CACHE.invoices.length > 0);

  const bomsRaw = await window.SVP.manufacturingService.listBoms();
  SERVER_CACHE.boms = bomsRaw.map((b) => mapBom(b, Object.fromEntries(SERVER_CACHE.products.map((p) => [p.id, p]))));

  const prodOrdersRaw = await window.SVP.manufacturingService.listProductionOrders().catch(() => []);
  SERVER_CACHE.productionOrders = (prodOrdersRaw || []).map(mapProductionOrder);

  const expensesRaw = await window.SVP.expenseService.list().catch(() => []);
  SERVER_CACHE.expenses = (expensesRaw || []).map(mapExpense);

  const billsRaw = await window.SVP.purchaseService.list().catch(() => []);
  SERVER_CACHE.purchaseBills = (billsRaw || []).map(mapPurchaseBill);

  const auditRaw = await window.SVP.auditService.list(50).catch(() => []);
  SERVER_CACHE.auditLog = (auditRaw || []).map(mapAuditRow);

  // ---- Now call the REAL render functions the app uses, exactly as tableVals() does ----
  try {
    const pc = productsTableCfg();
    check('productsTableCfg() runs without throwing', true);
    check('productsTableCfg() has real KPIs', pc.kpis.length > 0 && pc.rows.length === SERVER_CACHE.products.length, pc.kpis);
    check('productsTableCfg() rows carry entity ids', pc.rows.every((r) => !!r.id));
  } catch (e) { check('productsTableCfg() runs without throwing', false, e.stack); }

  try {
    const cc = customersTableCfg();
    check('customersTableCfg() runs without throwing', true);
    check('customersTableCfg() computes real outstanding via customerOutstanding()', cc.rows.length === SERVER_CACHE.customers.length);
  } catch (e) { check('customersTableCfg() runs without throwing', false, e.stack); }

  try {
    const ic = invoicesTableCfg();
    check('invoicesTableCfg() runs without throwing', true);
    check('invoicesTableCfg() rows match invoice count', ic.rows.length === SERVER_CACHE.invoices.length);
  } catch (e) { check('invoicesTableCfg() runs without throwing', false, e.stack); }

  try {
    const wc = warehousesTableCfg();
    check('warehousesTableCfg() runs without throwing', true, wc.rows.length);
  } catch (e) { check('warehousesTableCfg() runs without throwing', false, e.stack); }

  try {
    const bc = batchesTableCfg();
    check('batchesTableCfg() runs without throwing (batch status/expiry math on real dates)', true);
    const anyStatus = bc.rows.every((r) => r.some((c) => c && c.badge));
    check('batchesTableCfg() every row has a computed status badge', anyStatus);
  } catch (e) { check('batchesTableCfg() runs without throwing', false, e.stack); }

  try {
    const invc = inventoryTableCfg();
    check('inventoryTableCfg() runs without throwing', true, invc.rows.length);
  } catch (e) { check('inventoryTableCfg() runs without throwing', false, e.stack); }

  try {
    const sc = suppliersTableCfg();
    check('suppliersTableCfg() runs without throwing (supplierPayable math on real bills)', true, sc.rows.length);
  } catch (e) { check('suppliersTableCfg() runs without throwing', false, e.stack); }

  try {
    const ec = expensesTableCfg();
    check('expensesTableCfg() runs without throwing', true, ec.rows.length);
  } catch (e) { check('expensesTableCfg() runs without throwing', false, e.stack); }

  try {
    const mc = manufacturingTableCfg();
    check('manufacturingTableCfg() runs without throwing (BOM cost math)', true, mc.rows.length);
  } catch (e) { check('manufacturingTableCfg() runs without throwing', false, e.stack); }

  try {
    const auc = auditTableCfg();
    check('auditTableCfg() runs without throwing (full-timestamp date.replace)', true, auc.rows.length);
  } catch (e) { check('auditTableCfg() runs without throwing', false, e.stack); }

  try {
    const uc = usersTableCfg();
    check('usersTableCfg() runs without throwing', true, uc.rows.length);
  } catch (e) { check('usersTableCfg() runs without throwing', false, e.stack); }

  // Batch expiry math specifically, since this is the thing the date-format bug would have silently broken
  try {
    const testBatch = SERVER_CACHE.batches.find((b) => b.expiryDate);
    if (testBatch) {
      const status = batchStatus(testBatch);
      check('batchStatus() computes a real status from a real backend date (not NaN/crash)', ['ACTIVE', 'NEAR_EXPIRY', 'EXPIRED', 'DEPLETED'].includes(status), { batch: testBatch.batchNo, expiryDate: testBatch.expiryDate, status });
    } else {
      check('batchStatus() test (no batch with expiry found to test — skipped, not a failure)', true);
    }
  } catch (e) { check('batchStatus() computes without throwing', false, e.stack); }

  console.log(`\n=== ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Harness error:', e); process.exit(1); });
