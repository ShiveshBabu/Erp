/* Fires two simultaneous invoice-creation requests against a batch with
 * exactly 5 units, where each request wants all 5. Expected: exactly one
 * succeeds, the other gets INSUFFICIENT_STOCK, and final stock is exactly 0
 * — never -5, never 5, never duplicated. */

async function main() {
  const base = 'http://localhost:4000';

  const pre = await fetch(`${base}/api/v1/auth/csrf-token`);
  const preCookie = (pre.headers.get('set-cookie') || '').split(';')[0];
  const preToken = (await pre.json()).data.csrfToken;

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: preCookie, 'x-csrf-token': preToken },
    body: JSON.stringify({ usernameOrEmail: 'ravi.velan', password: 'ChangeMe123!' })
  });
  const setCookie = login.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0]! : preCookie;
  const csrfToken = preToken; // same session persists through login, so the same CSRF secret/token stays valid

  const authed = (path: string, opts: any = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const headers: any = { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers ?? {}) };
    if (method !== 'GET') headers['x-csrf-token'] = csrfToken;
    return fetch(`${base}${path}`, { ...opts, headers });
  };

  const catRes = await (await authed('/api/v1/product-categories')).json();
  const unitRes = await (await authed('/api/v1/units')).json();
  const catId = catRes.data.find((c: any) => c.name === 'Cattle Feed').id;
  const unitId = unitRes.data.find((u: any) => u.code === 'bag').id;

  const prodRes = await (await authed('/api/v1/products', {
    method: 'POST', body: JSON.stringify({ sku: 'CONC-TEST-' + Date.now(), name: 'Concurrency Test Feed', categoryId: catId, unitId, purchasePrice: 100, sellingPrice: 150, gstRate: 5 })
  })).json();
  const productId = prodRes.data.id;

  const whRes = await (await authed('/api/v1/warehouses')).json();
  const warehouseId = whRes.data.find((w: any) => w.code === 'MAIN').id;

  await authed('/api/v1/batches', { method: 'POST', body: JSON.stringify({ productId, warehouseId, batchNo: 'CONC-B1', qty: 5, purchaseRate: 100 }) });
  const batchesRes = await (await authed('/api/v1/batches')).json();
  const batch = batchesRes.data.find((b: any) => b.batchNo === 'CONC-B1' && b.productId === productId);
  const batchId = batch.id;

  const custRes = await (await authed('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: 'Concurrency Test Customer', type: 'Retail' }) })).json();
  const customerId = custRes.data.id;

  console.log('Batch', batchId, 'created with qty=5. Firing two simultaneous requests for qty=5 each, BOTH targeting this exact batch (forces the race at the atomic decrement, not FEFO resolution)...');

  const fireInvoice = () => authed('/api/v1/invoices', {
    method: 'POST',
    body: JSON.stringify({ customerId, warehouseId, lines: [{ productId, qty: 5, batchId }] })
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const [resA, resB] = await Promise.all([fireInvoice(), fireInvoice()]);

  console.log('Request A:', resA.status, JSON.stringify(resA.body));
  console.log('Request B:', resB.status, JSON.stringify(resB.body));

  const successes = [resA, resB].filter((r) => r.status === 201);
  const failures = [resA, resB].filter((r) => r.status !== 201);

  const finalStockRes = await authed(`/api/v1/inventory`);
  const finalStock = await finalStockRes.json();
  const row = finalStock.data.find((r: any) => r.productId === productId);
  const finalQty = row ? Number(row.onHand) : 0;

  console.log('\n=== RESULTS ===');
  console.log('Successes:', successes.length, '(expected: 1)');
  console.log('Failures:', failures.length, '(expected: 1)');
  console.log('Failure code:', failures[0]?.body?.error?.code, '(expected: INSUFFICIENT_STOCK)');
  console.log('Final stock:', finalQty, '(expected: 0)');

  const pass = successes.length === 1 && failures.length === 1 &&
    failures[0]?.body?.error?.code === 'INSUFFICIENT_STOCK' && finalQty === 0;

  console.log('\n' + (pass ? 'PASS: concurrency test' : 'FAIL: concurrency test'));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
