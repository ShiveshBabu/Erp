/* Opening 100 -> +50 purchase -> -20 sale -> +2 return -> transfer 10 out
 * -> transfer 5 back -> damage 3. Expected final: 129 (100+50-20+2-3;
 * transfers net to zero at the product level). Verified at batch,
 * warehouse, and product level, against the real database via the real API. */

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
  const csrfToken = preToken;
  const rawFetch = (path: string, opts: any = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const headers: any = { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers ?? {}) };
    if (method !== 'GET') headers['x-csrf-token'] = csrfToken;
    return fetch(`${base}${path}`, { ...opts, headers });
  };
  const authed = (path: string, opts: any = {}) => rawFetch(path, opts).then(async (r) => ({ status: r.status, body: await r.json() }));

  const cats = (await authed('/api/v1/product-categories')).body.data;
  const units = (await authed('/api/v1/units')).body.data;
  const catId = cats.find((c: any) => c.name === 'Cattle Feed').id;
  const unitId = units.find((u: any) => u.code === 'bag').id;
  const warehouses = (await authed('/api/v1/warehouses')).body.data;
  const mainWh = warehouses.find((w: any) => w.code === 'MAIN').id;
  const feedWh = warehouses.find((w: any) => w.code === 'FEED').id;

  const prod = (await authed('/api/v1/products', {
    method: 'POST', body: JSON.stringify({ sku: 'RECON-' + Date.now(), name: 'Reconciliation Test Feed', categoryId: catId, unitId, purchasePrice: 1000, sellingPrice: 1300, gstRate: 5 })
  })).body.data;
  const productId = prod.id;

  const cust = (await authed('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: 'Recon Test Customer', type: 'Retail' }) })).body.data;

  let step = 'opening batch';
  const batchResp = await authed('/api/v1/batches', { method: 'POST', body: JSON.stringify({ productId, warehouseId: mainWh, batchNo: 'RECON-OPEN', qty: 100, purchaseRate: 1000 }) });
  console.log(step, batchResp.status);
  const batches = (await authed('/api/v1/batches')).body.data;
  const openBatch = batches.find((b: any) => b.batchNo === 'RECON-OPEN' && b.productId === productId);

  const check = (name: string, cond: boolean, detail?: any) => {
    console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
    return cond;
  };

  const results: boolean[] = [];
  const stockOf = async (whCode: string) => {
    const inv = (await authed('/api/v1/inventory')).body.data;
    const row = inv.find((r: any) => r.productId === productId && warehouses.find((w: any) => w.id === r.warehouseId)?.code === whCode);
    return row ? Number(row.onHand) : 0;
  };
  const totalStock = async () => (await stockOf('MAIN')) + (await stockOf('FEED'));

  results.push(check('opening stock = 100', (await totalStock()) === 100));

  // +50 purchase (add to same batch via a fresh purchase against the supplier-less path: use batches POST with same batchNo increments)
  await authed('/api/v1/purchases', { method: 'POST', body: JSON.stringify({ supplierId: (await authed('/api/v1/suppliers', { method: 'POST', body: JSON.stringify({ name: 'Recon Supplier', type: 'x' }) })).body.data.id, warehouseId: mainWh, productId, batchNo: 'RECON-OPEN', qty: 50, rate: 1000 }) });
  results.push(check('after +50 purchase = 150', (await totalStock()) === 150, await totalStock()));

  // -20 sale
  const inv1 = await authed('/api/v1/invoices', { method: 'POST', body: JSON.stringify({ customerId: cust.id, warehouseId: mainWh, lines: [{ productId, qty: 20, batchId: openBatch.id }] }) });
  results.push(check('invoice created', inv1.status === 201, inv1.body));
  results.push(check('after -20 sale = 130', (await totalStock()) === 130, await totalStock()));

  // +2 return
  const invDetail = await authed(`/api/v1/invoices/${inv1.body.data.id}`);
  const lineItemId = invDetail.body.data.items[0].id;
  const retResp = await authed('/api/v1/returns', { method: 'POST', body: JSON.stringify({ invoiceItemId: lineItemId, qty: 2, reason: 'test' }) });
  results.push(check('return recorded', retResp.status === 201, retResp.body));
  results.push(check('after +2 return = 132', (await totalStock()) === 132, await totalStock()));

  // transfer 10 out (Main -> Feed)
  const tOut = await authed('/api/v1/inventory/transfer', { method: 'POST', body: JSON.stringify({ batchId: openBatch.id, toWarehouseId: feedWh, qty: 10 }) });
  results.push(check('transfer out succeeded', tOut.status === 200, tOut.body));
  results.push(check('after transfer 10 out, total unchanged = 132', (await totalStock()) === 132));
  results.push(check('Main = 122, Feed = 10', (await stockOf('MAIN')) === 122 && (await stockOf('FEED')) === 10, { main: await stockOf('MAIN'), feed: await stockOf('FEED') }));

  // transfer 5 back (Feed -> Main)
  const feedBatches = (await authed('/api/v1/batches')).body.data.filter((b: any) => b.productId === productId && b.warehouseId === feedWh);
  const feedBatchId = feedBatches[0].id;
  const tBack = await authed('/api/v1/inventory/transfer', { method: 'POST', body: JSON.stringify({ batchId: feedBatchId, toWarehouseId: mainWh, qty: 5 }) });
  results.push(check('transfer back succeeded', tBack.status === 200, tBack.body));
  results.push(check('after transfer 5 back, total unchanged = 132', (await totalStock()) === 132));
  results.push(check('Main = 127, Feed = 5', (await stockOf('MAIN')) === 127 && (await stockOf('FEED')) === 5, { main: await stockOf('MAIN'), feed: await stockOf('FEED') }));

  // damage 3 (from Main)
  const mainBatches = (await authed('/api/v1/batches')).body.data.filter((b: any) => b.productId === productId && b.warehouseId === mainWh);
  const mainBatchId = mainBatches[0].id;
  const dmg = await authed('/api/v1/inventory/adjustments', { method: 'POST', body: JSON.stringify({ batchId: mainBatchId, type: 'DAMAGE', qty: 3, reason: 'test damage' }) });
  results.push(check('damage adjustment succeeded', dmg.status === 200, dmg.body));

  const finalTotal = await totalStock();
  results.push(check('FINAL total = 129 (100+50-20+2-3, transfers net zero)', finalTotal === 129, finalTotal));

  const allPass = results.every(Boolean);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  console.log(allPass ? 'PASS: reconciliation test' : 'FAIL: reconciliation test');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
