import 'dotenv/config';
import { query, closePool } from '../src/lib/db';
import { hashPassword } from '../src/services/authService';
import { newId } from '../src/lib/id';

// =============================================================================
// DEVELOPMENT / DEMO SEED — NOT FOR PRODUCTION USE AS-IS.
// This script is idempotent: every insert is guarded by an existence check or
// ON CONFLICT DO NOTHING keyed on a stable natural identifier (code/sku/name),
// so running it twice against the same database never duplicates records,
// never creates a second invoice/payment/financial transaction, and is safe
// to re-run after a partial failure. It seeds infrastructure (roles/
// permissions/users) AND enough realistic operational data (catalog, BOM,
// customers, suppliers, opening stock) to exercise the complete ERP.
//
// If you are seeding a database that might contain real production data,
// STOP — do not run this script. It is intended for a fresh, empty database
// only. The demo user passwords are controlled by DEV_SEED_PASSWORD and must
// never be treated as production credentials.
// =============================================================================

const PERMISSIONS = [
  'view', 'product.create', 'product.edit_price', 'customer.create', 'customer.edit',
  'warehouse.manage', 'batch.create', 'inventory.add_stock', 'inventory.adjust', 'inventory.transfer',
  'invoice.create', 'invoice.cancel', 'payment.create', 'payment.reverse', 'return.create',
  'manufacturing.manage', 'supplier.manage', 'expense.manage', 'users.manage', 'audit.view', 'backup.manage'
] as const;

const ROLE_PERMS: Record<string, string[]> = {
  SUPER_ADMIN: ['*'],
  ADMIN: PERMISSIONS.filter((p) => p !== 'view').concat('view'),
  MANAGER: ['view', 'product.create', 'product.edit_price', 'customer.create', 'customer.edit',
    'warehouse.manage', 'batch.create', 'inventory.add_stock', 'inventory.adjust', 'inventory.transfer',
    'invoice.create', 'invoice.cancel', 'payment.create', 'payment.reverse', 'return.create',
    'manufacturing.manage', 'supplier.manage', 'expense.manage'],
  BILLING_STAFF: ['view', 'invoice.create', 'payment.create', 'return.create'],
  INVENTORY_STAFF: ['view', 'inventory.add_stock', 'inventory.adjust', 'inventory.transfer', 'batch.create', 'warehouse.manage', 'supplier.manage'],
  SALES_STAFF: ['view', 'invoice.create']
};

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager',
  BILLING_STAFF: 'Billing Staff', INVENTORY_STAFF: 'Inventory Staff', SALES_STAFF: 'Sales Staff'
};

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

async function seedRolesAndPermissions() {
  console.log('[1/7] Roles & permissions (from the frozen PERMS map)...');
  const roleIds: Record<string, string> = {};
  for (const code of Object.keys(ROLE_LABELS)) {
    await query(`INSERT INTO roles (id, code, label) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`, [newId('role'), code, ROLE_LABELS[code]]);
    const { rows } = await query<{ id: string }>(`SELECT id FROM roles WHERE code = $1`, [code]);
    roleIds[code] = rows[0]!.id;
  }
  const permIds: Record<string, string> = {};
  for (const code of [...PERMISSIONS, '*']) {
    await query(`INSERT INTO permissions (id, code, label) VALUES ($1,$2,$2) ON CONFLICT (code) DO NOTHING`, [newId('perm'), code]);
    const { rows } = await query<{ id: string }>(`SELECT id FROM permissions WHERE code = $1`, [code]);
    permIds[code] = rows[0]!.id;
  }
  for (const [roleCode, perms] of Object.entries(ROLE_PERMS)) {
    for (const permCode of perms) {
      await query(`INSERT INTO role_permissions ("roleId", "permissionId") VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleIds[roleCode], permIds[permCode]]);
    }
  }
  return roleIds;
}

async function seedUsers(roleIds: Record<string, string>) {
  console.log('[2/7] Demo users (DEVELOPMENT ONLY — never production credentials)...');
  const devPassword = process.env.DEV_SEED_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await hashPassword(devPassword);
  const demoUsers = [
    { name: 'Ravi Velan', email: 'ravi@srivelanpasumai.in', username: 'ravi.velan', role: 'SUPER_ADMIN' },
    { name: 'Lakshmi P.', email: 'lakshmi@srivelanpasumai.in', username: 'lakshmi.p', role: 'MANAGER' },
    { name: 'Meena R.', email: 'meena@srivelanpasumai.in', username: 'meena.r', role: 'BILLING_STAFF' },
    { name: 'Suresh K.', email: 'suresh@srivelanpasumai.in', username: 'suresh.k', role: 'INVENTORY_STAFF' },
    { name: 'Karthik S.', email: 'karthik@srivelanpasumai.in', username: 'karthik.s', role: 'SALES_STAFF' }
  ];
  for (const u of demoUsers) {
    await query(
      `INSERT INTO users (id, name, email, username, "passwordHash", "roleId", status) VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE') ON CONFLICT (email) DO NOTHING`,
      [newId('user'), u.name, u.email, u.username, passwordHash, roleIds[u.role]]
    );
  }
}

async function seedWarehousesCategoriesUnits() {
  console.log('[3/7] Warehouses, categories, units...');
  const warehouses = [
    { name: 'Main Warehouse', code: 'MAIN' }, { name: 'Feed Warehouse', code: 'FEED' },
    { name: 'Medicine Store', code: 'MED' }, { name: 'Fertilizer Store', code: 'FERT' }, { name: 'Retail Store', code: 'RETAIL' }
  ];
  for (const w of warehouses) await query(`INSERT INTO warehouses (id, name, code) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`, [newId('wh'), w.name, w.code]);

  const categories = ['Cattle Feed', 'Mineral Mixture', 'Fertilizer', 'Veterinary Medicine', 'Animal Tonic', 'Equipment', 'Raw Material'];
  for (const c of categories) await query(`INSERT INTO product_categories (id, name) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`, [newId('cat'), c]);

  const units = ['bag', 'pack', 'btl', 'pc', 'kg', 'ltr'];
  for (const u of units) await query(`INSERT INTO units (id, code) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [newId('unit'), u]);
}

async function seedCatalog() {
  console.log('[4/7] Product catalog (cattle feed, fertilizer, medicine, tonic, raw materials)...');
  const { rows: catRows } = await query<{ id: string; name: string }>(`SELECT id, name FROM product_categories`);
  const { rows: unitRows } = await query<{ id: string; code: string }>(`SELECT id, code FROM units`);
  const catId = (name: string) => { const r = catRows.find((c) => c.name === name); if (!r) throw new Error('Missing category: ' + name); return r.id; };
  const unitId = (code: string) => { const r = unitRows.find((u) => u.code === code); if (!r) throw new Error('Missing unit: ' + code); return r.id; };

  const products = [
    { sku: 'SVP-FEED-50', name: '50kg Organic Cow Feed', category: 'Cattle Feed', hsn: '2309', unit: 'bag', purchasePrice: 1462, sellingPrice: 1850, gstRate: 5, reorderLevel: 150, type: 'MANUFACTURED', expiryTracking: true },
    { sku: 'SVP-FEED-10', name: '10kg Organic Cow Feed', category: 'Cattle Feed', hsn: '2309', unit: 'bag', purchasePrice: 300, sellingPrice: 380, gstRate: 5, reorderLevel: 400, type: 'MANUFACTURED', expiryTracking: true },
    { sku: 'SVP-FEED-CALF', name: 'Calf Starter Feed 25kg', category: 'Cattle Feed', hsn: '2309', unit: 'bag', purchasePrice: 820, sellingPrice: 1050, gstRate: 5, reorderLevel: 100, type: 'MANUFACTURED', expiryTracking: true },
    { sku: 'SVP-MIN-05', name: 'Mineral Mixture 5KG', category: 'Mineral Mixture', hsn: '2309', unit: 'pack', purchasePrice: 640, sellingPrice: 800, gstRate: 12, reorderLevel: 150, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-MIN-01', name: 'Cattle Feed Supplement 1KG', category: 'Mineral Mixture', hsn: '2309', unit: 'pack', purchasePrice: 152, sellingPrice: 190, gstRate: 12, reorderLevel: 200, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-FERT-VC25', name: 'Vermicompost 25kg', category: 'Fertilizer', hsn: '3101', unit: 'bag', purchasePrice: 210, sellingPrice: 280, gstRate: 5, reorderLevel: 100, type: 'TRADED', expiryTracking: false },
    { sku: 'SVP-FERT-NPK', name: 'NPK Bio Fertilizer 10kg', category: 'Fertilizer', hsn: '3105', unit: 'bag', purchasePrice: 340, sellingPrice: 440, gstRate: 5, reorderLevel: 80, type: 'TRADED', expiryTracking: false },
    { sku: 'SVP-MED-CG5', name: 'Calcium Gel 500ml', category: 'Veterinary Medicine', hsn: '3004', unit: 'btl', purchasePrice: 300, sellingPrice: 400, gstRate: 18, reorderLevel: 60, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-MED-HC2', name: 'Hoof Care Spray 250ml', category: 'Veterinary Medicine', hsn: '3004', unit: 'btl', purchasePrice: 244, sellingPrice: 320, gstRate: 18, reorderLevel: 40, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-MED-DEWORM', name: 'Broad Spectrum Dewormer 100ml', category: 'Veterinary Medicine', hsn: '3004', unit: 'btl', purchasePrice: 180, sellingPrice: 240, gstRate: 18, reorderLevel: 50, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-TONIC-LV1', name: 'Liver Tonic for Cattle 1L', category: 'Animal Tonic', hsn: '2309', unit: 'ltr', purchasePrice: 260, sellingPrice: 340, gstRate: 12, reorderLevel: 60, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-TONIC-GRW', name: 'Growth Promoter Tonic 500ml', category: 'Animal Tonic', hsn: '2309', unit: 'btl', purchasePrice: 175, sellingPrice: 230, gstRate: 12, reorderLevel: 70, type: 'TRADED', expiryTracking: true },
    { sku: 'SVP-EQP-MF1', name: 'Milking Machine Filter', category: 'Equipment', hsn: '8434', unit: 'pc', purchasePrice: 350, sellingPrice: 500, gstRate: 18, reorderLevel: 50, type: 'TRADED', expiryTracking: false },
    { sku: 'RM-MAIZE', name: 'Maize (raw)', category: 'Raw Material', hsn: '1005', unit: 'kg', purchasePrice: 26, sellingPrice: null, gstRate: 0, reorderLevel: 10000, type: 'RAW', expiryTracking: false },
    { sku: 'RM-BRAN', name: 'Rice Bran (raw)', category: 'Raw Material', hsn: '2302', unit: 'kg', purchasePrice: 18, sellingPrice: null, gstRate: 0, reorderLevel: 3000, type: 'RAW', expiryTracking: false },
    { sku: 'RM-WHEATBRAN', name: 'Wheat Bran (raw)', category: 'Raw Material', hsn: '2302', unit: 'kg', purchasePrice: 20, sellingPrice: null, gstRate: 0, reorderLevel: 2000, type: 'RAW', expiryTracking: false },
    { sku: 'RM-SOYA', name: 'Soybean Meal (raw)', category: 'Raw Material', hsn: '2304', unit: 'kg', purchasePrice: 34, sellingPrice: null, gstRate: 0, reorderLevel: 2500, type: 'RAW', expiryTracking: false },
    { sku: 'RM-SALT', name: 'Salt (raw)', category: 'Raw Material', hsn: '2501', unit: 'kg', purchasePrice: 8, sellingPrice: null, gstRate: 0, reorderLevel: 500, type: 'RAW', expiryTracking: false },
    { sku: 'RM-ADD', name: 'Additives (raw)', category: 'Raw Material', hsn: '2309', unit: 'kg', purchasePrice: 120, sellingPrice: null, gstRate: 0, reorderLevel: 200, type: 'RAW', expiryTracking: false },
    { sku: 'RM-MINPRE', name: 'Mineral Premix (raw)', category: 'Raw Material', hsn: '2309', unit: 'kg', purchasePrice: 55, sellingPrice: null, gstRate: 0, reorderLevel: 500, type: 'RAW', expiryTracking: false }
  ];

  const productIds: Record<string, string> = {};
  for (const p of products) {
    await query(
      `INSERT INTO products (id, sku, name, "categoryId", hsn, "unitId", "purchasePrice", "sellingPrice", "gstRate", "reorderLevel", type, "expiryTracking")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (sku) DO NOTHING`,
      [newId('prod'), p.sku, p.name, catId(p.category), p.hsn, unitId(p.unit), p.purchasePrice, p.sellingPrice, p.gstRate, p.reorderLevel, p.type, p.expiryTracking]
    );
    const { rows } = await query<{ id: string }>(`SELECT id FROM products WHERE sku = $1`, [p.sku]);
    productIds[p.sku] = rows[0]!.id;
  }
  return productIds;
}

async function seedOpeningStock(productIds: Record<string, string>) {
  console.log('[5/7] Opening stock batches (realistic dates relative to today)...');
  const { rows: whRows } = await query<{ id: string; code: string }>(`SELECT id, code FROM warehouses`);
  const whId = (code: string) => { const r = whRows.find((w) => w.code === code); if (!r) throw new Error('Missing warehouse: ' + code); return r.id; };
  const today = todayISO();

  const batches: [string, string, number, number, number, number | null][] = [
    ['SVP-FEED-50', 'FEED', 412, 1462, -30, 150], ['SVP-FEED-10', 'FEED', 980, 300, -45, 165],
    ['SVP-FEED-CALF', 'FEED', 150, 820, -20, 200],
    ['SVP-MIN-05', 'FEED', 42, 640, -60, 30],
    ['SVP-MIN-01', 'FEED', 118, 152, -90, 120],
    ['SVP-FERT-VC25', 'FERT', 240, 210, -10, null], ['SVP-FERT-NPK', 'FERT', 90, 340, -10, null],
    ['SVP-MED-CG5', 'MED', 36, 300, -90, 200], ['SVP-MED-HC2', 'MED', 28, 244, -90, 250], ['SVP-MED-DEWORM', 'MED', 40, 180, -30, 300],
    ['SVP-TONIC-LV1', 'MED', 50, 260, -30, 270], ['SVP-TONIC-GRW', 'MED', 60, 175, -30, 270],
    ['SVP-EQP-MF1', 'MAIN', 164, 350, -60, null],
    ['RM-MAIZE', 'MAIN', 18400, 26, -15, null], ['RM-BRAN', 'MAIN', 5000, 18, -15, null], ['RM-WHEATBRAN', 'MAIN', 3000, 20, -15, null],
    ['RM-SOYA', 'MAIN', 4000, 34, -15, null], ['RM-SALT', 'MAIN', 2000, 8, -15, null], ['RM-ADD', 'MAIN', 500, 120, -15, null], ['RM-MINPRE', 'MAIN', 1500, 55, -15, null]
  ];

  for (const [sku, whCode, qty, rate, mfgOffset, expOffset] of batches) {
    const productId = productIds[sku];
    const warehouseId = whId(whCode);
    const { rows: exists } = await query(`SELECT id FROM batches WHERE "productId" = $1 AND "warehouseId" = $2 AND "batchNo" = 'OPEN'`, [productId, warehouseId]);
    if (exists.length) continue;
    const batchId = newId('batch');
    const mfgDate = addDays(today, mfgOffset);
    const expiryDate = expOffset != null ? addDays(today, expOffset) : null;
    await query(`INSERT INTO batches (id, "productId", "warehouseId", "batchNo", qty, "mfgDate", "expiryDate", "purchaseRate") VALUES ($1,$2,$3,'OPEN',$4,$5,$6,$7)`,
      [batchId, productId, warehouseId, qty, mfgDate, expiryDate, rate]);
    await query(`INSERT INTO stock_movements (id, "productId", "batchId", "warehouseId", type, qty, "referenceId", note) VALUES ($1,$2,$3,$4,'OPENING_STOCK',$5,'Opening balance','Seeded demo opening stock')`,
      [newId('mv'), productId, batchId, warehouseId, qty]);
  }
}

async function seedCustomersAndSuppliers() {
  console.log('[6/7] Demo customers and suppliers...');
  const customers = [
    { name: 'Anbu Dairy Farm', type: 'Dairy farm', gstin: '33AAECS4521P1ZK', phone: '+91 98430 21145' },
    { name: 'Sakthi Cattle Traders', type: 'Trader', gstin: '33AAHCS7754M1ZY', phone: '+91 94437 88210' },
    { name: 'Kongu Milk Society', type: 'Co-operative', gstin: '29AABCK3341N1Z8', phone: '+91 80 4128 6600' },
    { name: 'Bhavani Agro Centre', type: 'Retail', gstin: '33AAFCB2290L1ZQ', phone: '+91 90031 45520' }
  ];
  for (const c of customers) {
    const { rows: exists } = await query(`SELECT id FROM customers WHERE name = $1`, [c.name]);
    if (exists.length) continue;
    await query(`INSERT INTO customers (id, name, type, gstin, phone, "creditLimit") VALUES ($1,$2,$3,$4,$5,150000)`, [newId('cust'), c.name, c.type, c.gstin, c.phone]);
  }
  const suppliers = [
    { name: 'Erode Maize Traders', contact: 'Palani S.', phone: '+91 98430 55210', gstin: '33AABCS1122M1Z1' },
    { name: 'Kongu Soya Products', contact: 'Murugan K.', phone: '+91 94422 11087', gstin: '33AACCK4432L1Z9' },
    { name: 'Salem Mineral Works', contact: 'Devi R.', phone: '+91 90474 33210', gstin: '33AADCS7743P1Z2' },
    { name: 'Namakkal Vet Supplies', contact: 'Arun V.', phone: '+91 98942 10087', gstin: '33AAECN9982K1Z4' }
  ];
  for (const s of suppliers) {
    const { rows: exists } = await query(`SELECT id FROM suppliers WHERE name = $1`, [s.name]);
    if (exists.length) continue;
    await query(`INSERT INTO suppliers (id, name, contact, phone, gstin, "paymentTerms") VALUES ($1,$2,$3,$4,$5,'Net 30')`, [newId('sup'), s.name, s.contact, s.phone, s.gstin]);
  }
}

async function seedBom(productIds: Record<string, string>) {
  console.log('[7/7] BOM — itemized materials, not comma-separated strings...');
  const { rows: unitRows } = await query<{ id: string; code: string }>(`SELECT id, code FROM units`);
  const kgUnitId = unitRows.find((u) => u.code === 'kg')!.id;

  const { rows: bomExists } = await query(`SELECT id FROM boms WHERE code = 'BOM-F50-v4'`);
  if (bomExists.length === 0) {
    const bomId = newId('bom');
    await query(`INSERT INTO boms (id, code, "outputProductId", "batchSize", status) VALUES ($1,'BOM-F50-v4',$2,100,'ACTIVE')`, [bomId, productIds['SVP-FEED-50']]);
    const items: [string, number][] = [['RM-MAIZE', 2200], ['RM-BRAN', 1100], ['RM-SOYA', 1200], ['RM-MINPRE', 400], ['RM-SALT', 100], ['RM-ADD', 50]];
    for (const [sku, qty] of items) {
      await query(`INSERT INTO bom_items (id, "bomId", "materialProductId", qty, "unitId") VALUES ($1,$2,$3,$4,$5)`, [newId('bi'), bomId, productIds[sku], qty, kgUnitId]);
    }
  }
  const { rows: calfBomExists } = await query(`SELECT id FROM boms WHERE code = 'BOM-CALF25-v1'`);
  if (calfBomExists.length === 0) {
    const bomId = newId('bom');
    await query(`INSERT INTO boms (id, code, "outputProductId", "batchSize", status) VALUES ($1,'BOM-CALF25-v1',$2,50,'ACTIVE')`, [bomId, productIds['SVP-FEED-CALF']]);
    const items: [string, number][] = [['RM-MAIZE', 600], ['RM-WHEATBRAN', 400], ['RM-SOYA', 350], ['RM-MINPRE', 100], ['RM-SALT', 25]];
    for (const [sku, qty] of items) {
      await query(`INSERT INTO bom_items (id, "bomId", "materialProductId", qty, "unitId") VALUES ($1,$2,$3,$4,$5)`, [newId('bi'), bomId, productIds[sku], qty, kgUnitId]);
    }
  }
}

async function main() {
  const roleIds = await seedRolesAndPermissions();
  await seedUsers(roleIds);
  await seedWarehousesCategoriesUnits();
  const productIds = await seedCatalog();
  await seedOpeningStock(productIds);
  await seedCustomersAndSuppliers();
  await seedBom(productIds);
  console.log('Seed complete (idempotent — safe to re-run).');
}

main()
  .catch((err) => { console.error('SEED FAILED:', err); process.exitCode = 1; })
  .finally(() => closePool());
