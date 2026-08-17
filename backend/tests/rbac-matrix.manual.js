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
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pre.cookie, 'x-csrf-token': pre.token },
    body: JSON.stringify({ usernameOrEmail, password: PASS })
  });
  const setCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const cookie = setCookie || pre.cookie;
  csrfByCookie.set(cookie, pre.token);
  const body = await res.json();
  return { cookie, role: body.data && body.data.role };
}

async function call(cookie, method, path, payload) {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  if (method !== 'GET') {
    if (!csrfByCookie.has(cookie)) await fetchCsrf(cookie);
    headers['x-csrf-token'] = csrfByCookie.get(cookie);
  }
  const res = await fetch(BASE + path, {
    method, headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 200) : ''); }
}

async function main() {
  const users = {
    SUPER_ADMIN: await login('ravi.velan'),
    MANAGER: await login('lakshmi.p'),
    BILLING_STAFF: await login('meena.r'),
    INVENTORY_STAFF: await login('suresh.k'),
    SALES_STAFF: await login('karthik.s')
  };
  for (const [role, u] of Object.entries(users)) check('Login succeeds for seeded role ' + role, u.role === role, u);

  // fetch shared reference IDs using the super admin session
  const admin = users.SUPER_ADMIN.cookie;
  const cats = (await call(admin, 'GET', '/api/v1/product-categories')).body.data;
  const units = (await call(admin, 'GET', '/api/v1/units')).body.data;
  const warehouses = (await call(admin, 'GET', '/api/v1/warehouses')).body.data;
  const mainWh = warehouses.find(w => w.code === 'MAIN');
  const products = (await call(admin, 'GET', '/api/v1/products')).body.data;
  const feedProduct = products.find(p => p.sku === 'SVP-FEED-50');
  const customers = (await call(admin, 'GET', '/api/v1/customers')).body.data;
  const customer = customers[0];
  const suppliers = (await call(admin, 'GET', '/api/v1/suppliers')).body.data;
  const supplier = suppliers[0];
  const boms = (await call(admin, 'GET', '/api/v1/boms')).body.data;
  const bom = boms.find(b => b.code === 'BOM-F50-v4');

  // Create a throwaway batch + invoice as admin to have something to act on for payment/return/cancel tests
  const batchRes = await call(admin, 'POST', '/api/v1/batches', { productId: feedProduct.id, warehouseId: mainWh.id, batchNo: 'RBAC-' + Date.now(), qty: 50, purchaseRate: 1000 });
  const batches = (await call(admin, 'GET', '/api/v1/batches')).body.data;
  const rbacBatch = batches.find(b => b.id === batchRes.body.data.id);
  const invRes = await call(admin, 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: feedProduct.id, qty: 2, batchId: rbacBatch.id }] });
  const invoice = invRes.body.data;

  // ---------------- Matrix definitions: [role, method, path, payload, expectAllowed] ----------------
  const matrix = [
    // Product price change — only SUPER_ADMIN/ADMIN/MANAGER
    ['SUPER_ADMIN', 'PATCH', `/api/v1/products/${feedProduct.id}`, { purchasePrice: Number(feedProduct.purchasePrice) }, true],
    ['MANAGER', 'PATCH', `/api/v1/products/${feedProduct.id}`, { purchasePrice: Number(feedProduct.purchasePrice) + 1 }, true],
    ['BILLING_STAFF', 'PATCH', `/api/v1/products/${feedProduct.id}`, { purchasePrice: 99999 }, false],
    ['INVENTORY_STAFF', 'PATCH', `/api/v1/products/${feedProduct.id}`, { purchasePrice: 99999 }, false],
    ['SALES_STAFF', 'PATCH', `/api/v1/products/${feedProduct.id}`, { purchasePrice: 99999 }, false],

    // Product creation
    ['BILLING_STAFF', 'POST', '/api/v1/products', { sku: 'RBAC-DENY-' + Date.now(), name: 'x', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 1, gstRate: 5 }, false],
    ['MANAGER', 'POST', '/api/v1/products', { sku: 'RBAC-ALLOW-' + Date.now(), name: 'x', categoryId: cats[0].id, unitId: units[0].id, purchasePrice: 1, gstRate: 5 }, true],

    // Invoice creation — billing/sales/manager/admin allowed, inventory denied
    ['BILLING_STAFF', 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: feedProduct.id, qty: 1, batchId: rbacBatch.id }] }, true],
    ['SALES_STAFF', 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: feedProduct.id, qty: 1, batchId: rbacBatch.id }] }, true],
    ['INVENTORY_STAFF', 'POST', '/api/v1/invoices', { customerId: customer.id, warehouseId: mainWh.id, lines: [{ productId: feedProduct.id, qty: 1, batchId: rbacBatch.id }] }, false],

    // Invoice cancellation — super admin/admin/manager only
    ['BILLING_STAFF', 'POST', `/api/v1/invoices/${invoice.id}/cancel`, { reason: 'rbac test' }, false],

    // Payment — billing/manager/admin allowed, inventory denied
    ['INVENTORY_STAFF', 'POST', '/api/v1/payments', { invoiceId: invoice.id, amount: 100, method: 'Cash' }, false],
    ['BILLING_STAFF', 'POST', '/api/v1/payments', { invoiceId: invoice.id, amount: 100, method: 'Cash' }, true],

    // Payment reversal — manager/admin only, not billing
    ['BILLING_STAFF', 'POST', '/api/v1/payments/nonexistent/reverse', {}, false], // still 403 before even reaching NOT_FOUND

    // Returns — billing allowed, inventory denied
    ['INVENTORY_STAFF', 'POST', '/api/v1/returns', { invoiceItemId: 'nonexistent', qty: 1 }, false],

    // Stock adjustment — inventory/manager/admin allowed, billing/sales denied
    ['BILLING_STAFF', 'POST', '/api/v1/inventory/adjustments', { batchId: rbacBatch.id, type: 'ADD', qty: 1, reason: 'rbac test' }, false],
    ['INVENTORY_STAFF', 'POST', '/api/v1/inventory/adjustments', { batchId: rbacBatch.id, type: 'ADD', qty: 1, reason: 'rbac test' }, true],

    // Warehouse transfer — inventory/manager/admin allowed, sales denied
    ['SALES_STAFF', 'POST', '/api/v1/inventory/transfer', { batchId: rbacBatch.id, toWarehouseId: warehouses.find(w => w.code === 'FEED').id, qty: 1 }, false],
    ['INVENTORY_STAFF', 'POST', '/api/v1/inventory/transfer', { batchId: rbacBatch.id, toWarehouseId: warehouses.find(w => w.code === 'FEED').id, qty: 1 }, true],

    // Purchases — inventory/manager/admin allowed, billing/sales denied
    ['BILLING_STAFF', 'POST', '/api/v1/purchases', { supplierId: supplier.id, warehouseId: mainWh.id, productId: feedProduct.id, qty: 1, rate: 1000 }, false],
    ['INVENTORY_STAFF', 'POST', '/api/v1/purchases', { supplierId: supplier.id, warehouseId: mainWh.id, productId: feedProduct.id, qty: 1, rate: 1000 }, true],

    // Supplier modification — inventory/manager/admin allowed, billing/sales denied
    ['SALES_STAFF', 'POST', '/api/v1/suppliers', { name: 'RBAC Deny Supplier', type: 'x' }, false],
    ['INVENTORY_STAFF', 'POST', '/api/v1/suppliers', { name: 'RBAC Allow Supplier ' + Date.now(), type: 'x' }, true],

    // Expense creation — manager/admin allowed, billing/inventory/sales denied
    ['INVENTORY_STAFF', 'POST', '/api/v1/expenses', { category: 'Other', description: 'rbac test', amount: 100, method: 'Cash' }, false],
    ['MANAGER', 'POST', '/api/v1/expenses', { category: 'Other', description: 'rbac test', amount: 100, method: 'Cash' }, true],

    // BOM modification — manufacture permission (manager/admin/superadmin only per PERMS)
    ['BILLING_STAFF', 'POST', '/api/v1/boms', { code: 'RBAC-DENY-BOM', outputProductId: feedProduct.id, batchSize: 10, items: [{ materialProductId: feedProduct.id, qty: 1, unitId: units[0].id }] }, false],

    // Manufacturing completion — manager/admin only
    ['BILLING_STAFF', 'POST', `/api/v1/production-orders/nonexistent/complete`, {}, false],

    // User creation/role change — SUPER_ADMIN/ADMIN only (users.manage)
    ['MANAGER', 'POST', '/api/v1/users', { name: 'x', email: 'rbac-deny@test.com', username: 'rbacdeny', role: 'SALES_STAFF', password: 'testpass123' }, false],
    ['BILLING_STAFF', 'POST', '/api/v1/users', { name: 'x', email: 'rbac-deny2@test.com', username: 'rbacdeny2', role: 'SALES_STAFF', password: 'testpass123' }, false],

    // Audit access — audit.view is SUPER_ADMIN/ADMIN only per PERMS (not MANAGER)
    ['MANAGER', 'GET', '/api/v1/audit', undefined, false],
    ['SUPER_ADMIN', 'GET', '/api/v1/audit', undefined, true]
  ];

  for (const [role, method, path, payload, expectAllowed] of matrix) {
    const cookie = users[role].cookie;
    const res = await call(cookie, method, path, payload);
    const allowed = res.status < 400 || (res.status >= 400 && res.status !== 403 && res.status !== 401);
    // Treat 403 as the only "forbidden" signal; any other status (200/201/404/409/etc) counts as "reached the business logic", i.e. was authorized.
    const wasForbidden = res.status === 403;
    const ok = expectAllowed ? !wasForbidden : wasForbidden;
    check(`${role} ${method} ${path} -> expect ${expectAllowed ? 'ALLOWED' : 'FORBIDDEN'} (got ${res.status})`, ok, res.body);
  }

  // ---- LAST_SUPER_ADMIN_PROTECTED ----
  const usersList = (await call(admin, 'GET', '/api/v1/users')).body.data;
  const raviUser = usersList.find(u => u.username === 'ravi.velan');
  const deactivate = await call(admin, 'PATCH', `/api/v1/users/${raviUser.id}`, { status: 'DISABLED' });
  check('Deactivating the last active Super Admin is blocked', deactivate.status === 409 && deactivate.body.error.code === 'LAST_SUPER_ADMIN_PROTECTED', deactivate.body);
  const demote = await call(admin, 'PATCH', `/api/v1/users/${raviUser.id}`, { role: 'ADMIN' });
  check('Demoting the last active Super Admin is blocked', demote.status === 409 && demote.body.error.code === 'LAST_SUPER_ADMIN_PROTECTED', demote.body);

  console.log(`\n=== RBAC MATRIX: ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
