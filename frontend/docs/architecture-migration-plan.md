# Sri Velan Pasumai ERP — Architecture Migration Plan

*Prepared against the LOCAL/DEMO build that passed 76/76 business-logic assertions. This document freezes that build's behavior as the reference spec and proposes the production architecture around it. The existing UI is unchanged by everything in this document — this is planning only, nothing here has been implemented in the artifact.*

---

## 0. Project inspection (what actually exists today)

I inspected the project directly rather than assuming:

| Question | Finding |
|---|---|
| Existing framework | None. `Sri Velan Pasumai ERP.dc.html` is a single file rendered by a proprietary runtime (`support.js`, the "dc-runtime") that expects `window.React`/`window.ReactDOM` to already be on the page and interprets custom `sc-if`/`sc-for` template directives plus a JS `Component` class. |
| Existing backend | None. Zero server code, zero API calls anywhere in the file. |
| Package manager | None. No `package.json`, no `node_modules`, no lockfile in this project. |
| TypeScript | Not available *in this project*. (`support.js`'s header comment says it was generated from a separate `dc-runtime` TypeScript source elsewhere, but that source isn't part of this deliverable and isn't something this project can build or extend.) |
| Existing dependencies | None beyond the implicit `React`/`ReactDOM` globals the host page provides. |
| Persistence | `window.localStorage`, key `svp-erp-db-v3`, one JSON blob containing every table. |

**Conclusion:** there is nothing to "migrate away from" in terms of a framework decision — this is a genuine greenfield backend build sitting behind an existing, approved frontend. That materially simplifies the recommendation: I'm not fighting an existing Rails/Django/whatever convention, so I can pick the stack that best matches where the frontend code already lives (JavaScript/TypeScript) and the scale of the problem (single-tenant SMB ERP, not a multi-tenant SaaS with millions of rows).

---

## 1. Frozen business rules (reference behavior — do not change without a filed defect)

This is the contract the backend must reproduce exactly. Each rule below is traceable to a specific function in the current build.

**Billing** — `commitInvoice()`: resolve customer by exact name match (must pre-exist); for each line, resolve product → FEFO batch in the selected warehouse (`fefoBatches`); reject if no valid (non-expired, qty>0) batch; reject if requested qty exceeds warehouse-scoped stock; recompute subtotal/tax/grand total from line items server-side, never trust a submitted total; generate invoice number from a single incrementing sequence (`SVP/25-26/####`); optional immediate payment on save.

**Inventory / Warehouses** — stock is **not** a field on `product`; it is `SUM(batches.qty)` filtered by `productId` (+ `warehouseId` when warehouse-scoped). There is no separate "stock" table in the current model — it's a derived aggregate, by design (`productTotalStock`, `warehouseProductStock`).

**Batches / FEFO / Expiry** — `batchStatus(batch)`: `DEPLETED` if qty≤0; else `EXPIRED` if `expiryDate < today`; else `NEAR_EXPIRY` if within `EXPIRY_WARNING_DAYS` (30, configurable); else `ACTIVE`. `fefoBatches(productId, warehouseId)` returns valid (non-expired, qty>0) batches sorted by soonest expiry first, batches with no expiry sort last. Expired batches are never returned by `fefoBatches` — this is the single enforcement point that makes "cannot sell expired stock" true everywhere (billing, transfers, production all call it).

**Payments** — partial payments allowed; payment > outstanding balance is rejected; invoice status derives from balance (`Unpaid` → `Partially Paid` → `Paid`), never stored independently of the payment history.

**Returns** — return quantity capped at the line's remaining qty; credit value computed pro-rata from the line's net+tax; **balance is not clamped to zero** — a return against an already-fully-paid invoice produces a negative balance (`Credit Due`), which is the actual liability owed back to the customer. (This was a real bug found and fixed during testing — clamping to zero silently hid money owed to customers.)

**Purchases** — increases/creates a batch in the chosen warehouse; if a matching supplier name is found, auto-creates a `purchaseBill` (unpaid) linking to that supplier, which is what feeds the supplier ledger.

**Manufacturing / BOM** — `computeProductionRequirements(bom, plannedQty)` scales every BOM line by `plannedQty / bom.batchSize`. `completeProduction()` validates **every** material's total stock *before mutating anything*; only if all materials are sufficient does it consume FEFO across batches (any warehouse) and create the finished-goods batch + stock movement. Insufficient stock throws before any mutation — no partial consumption.

**Customer ledger** — running balance built from every non-cancelled invoice (+ grandTotal) and every payment (− amount) in date order; this must equal `customerOutstanding()` (sum of `.balance` across a customer's active invoices) exactly — that equality is a regression-tested invariant.

**Supplier ledger** — mirror of the above: `+purchaseBill.amount`, `−payment.amount`, balance = `supplierPayable()`.

**GST** — `gstSummary(from, to)` recomputes CGST/SGST per line from `qty × rate × (1−disc%) × gst%` for every invoice in the period — never a stored/cached number. Currently always treated as intra-state (CGST+SGST split); IGST for inter-state is **not yet implemented** (known limitation, not a hidden assumption).

**Profit** — `profitSummary(from, to)`: `revenue = Σ grandTotal`, `cogs = Σ (qty × product.purchasePrice)` per sold line, `gross = revenue − cogs`, `net = gross − Σ expenses in period`. COGS uses purchase price (or production cost for manufactured batches), never selling price.

**Expenses** — flat ledger of `{category, amount, date, warehouse, method}`, summed into `profitSummary`'s expense deduction.

**Audit** — `DB.audit(user, action, record, detail)` resolves the user's role at write time and prepends to `auditLog`; called from every mutating action (invoice create/cancel, payment record/reverse, stock adjust/transfer, batch create, BOM create/edit, production complete, user create/edit, supplier/expense create). Audit entries are appended only — nothing in the UI can edit or delete one.

**RBAC** — a flat `PERMS` map (`role → [actions]`), checked inside the mutating function itself (`requirePerm`/`can`), not just used to hide buttons. `SUPER_ADMIN` has unconditional access; `ADMIN` has the same operational actions as `MANAGER` (deliberately *not* blanket-unconditional, per the last revision); a hard rule outside the permission map protects the last active `SUPER_ADMIN` from being demoted or deactivated.

---

## 2–4. Database entities, relationships, integrity

Proposed schema (PostgreSQL). I've mapped every current in-memory JS array to a table, and explicitly noted where I'm *not* creating a table because the current design already treats something as derived data (per "do not duplicate business data" in your instructions).

```
users               (id, name, email UNIQUE, username UNIQUE, phone, password_hash,
                      role_id FK→roles, status, created_at, created_by FK→users, last_login_at)
roles               (id, code UNIQUE, label)
permissions         (id, code UNIQUE, label)               -- e.g. 'createInvoice', 'editPrice'
role_permissions    (role_id FK, permission_id FK, PRIMARY KEY(role_id, permission_id))

customers           (id, name, sub_area, owner, type, gstin, phone, email,
                      credit_limit, since, created_at)
customer_addresses  (id, customer_id FK, label, address_text)   -- billing/shipping split, not in current model but trivial to add
-- customer_ledger: NOT a stored table. It is a VIEW/query over invoices+payments,
--   exactly as today (`custVals()` builds it from invoices/payments at read time).
--   Storing a redundant ledger table risks it drifting from the source transactions.

suppliers           (id, name, contact, phone, email, gstin, address, payment_terms, created_at)
-- supplier_ledger: same reasoning — a view over purchase_bills + supplier_payments.

product_categories  (id, name UNIQUE)
units               (id, code UNIQUE)                        -- 'bag','pack','btl','pc','kg'
products            (id, sku UNIQUE, name, category_id FK, hsn, unit_id FK,
                      purchase_price NUMERIC CHECK (purchase_price >= 0),
                      selling_price NUMERIC CHECK (selling_price >= 0) NULL,
                      gst_rate NUMERIC CHECK (gst_rate >= 0 AND gst_rate <= 100),
                      reorder_level NUMERIC CHECK (reorder_level >= 0),
                      expiry_tracking BOOLEAN, type TEXT, created_at)

warehouses          (id, name, code UNIQUE, address, manager_id FK→users NULL, status, created_at)
warehouse_users     (warehouse_id FK, user_id FK, PRIMARY KEY(warehouse_id, user_id))  -- access scoping, new capability

batches             (id, product_id FK, batch_no, warehouse_id FK,
                      qty NUMERIC CHECK (qty >= 0),
                      mfg_date DATE, expiry_date DATE NULL,
                      purchase_rate NUMERIC CHECK (purchase_rate >= 0),
                      supplier_id FK NULL,
                      UNIQUE (product_id, warehouse_id, batch_no))
-- "stock" as its own table: NOT created. batches.qty *is* the stock, grouped by
--   (product_id, warehouse_id). A separate `stock` table would just be
--   SUM(batches.qty) cached — I expose it as a VIEW, not a table, to avoid two
--   sources of truth that can drift apart.
stock_movements     (id, product_id FK, batch_id FK NULL, warehouse_id FK,
                      type TEXT CHECK (type IN ('Opening Stock','Purchase','Sale',
                        'Sales Return','Purchase Return','Production','Production Consumption',
                        'Stock Adjustment','Damage','Expired','TRANSFER_IN','TRANSFER_OUT',
                        'Invoice Cancellation Reversal')),
                      qty NUMERIC, date TIMESTAMPTZ, reference_id TEXT, note TEXT)

invoices            (id, number UNIQUE, customer_id FK, date DATE, due_date DATE,
                      subtotal NUMERIC, tax NUMERIC, grand_total NUMERIC,
                      paid NUMERIC DEFAULT 0, balance NUMERIC,        -- balance MAY be negative (Credit Due)
                      status TEXT CHECK (status IN ('Unpaid','Partially Paid','Paid',
                        'Overdue','Cancelled','Credit Due')),
                      cancelled_at TIMESTAMPTZ NULL, cancel_reason TEXT NULL)
invoice_items       (id, invoice_id FK, product_id FK, batch_id FK, warehouse_id FK,
                      qty NUMERIC CHECK (qty >= 0), unit_id FK, rate NUMERIC CHECK (rate >= 0),
                      discount_pct NUMERIC CHECK (discount_pct >= 0 AND discount_pct <= 100),
                      gst_rate NUMERIC, hsn TEXT)
payments            (id, invoice_id FK, date DATE, amount NUMERIC CHECK (amount > 0),
                      method TEXT, reference TEXT, reversed BOOLEAN DEFAULT false, reversed_at TIMESTAMPTZ NULL)

sales_returns       (id, invoice_id FK, date DATE, reason TEXT, credit_value NUMERIC)
sales_return_items  (id, sales_return_id FK, invoice_item_id FK, qty NUMERIC CHECK (qty > 0))

purchase_orders     (id, number UNIQUE, supplier_id FK, status, date)         -- currently collapsed into purchase_bills in the demo; kept separate here as the enterprise model calls for PO≠bill
purchase_bills      (id, number UNIQUE, supplier_id FK, po_id FK NULL, date,
                      amount NUMERIC, paid NUMERIC DEFAULT 0, balance NUMERIC,
                      status TEXT CHECK (status IN ('Unpaid','Partially Paid','Paid','Cancelled')))
purchase_bill_items (id, purchase_bill_id FK, product_id FK, qty NUMERIC CHECK (qty > 0),
                      rate NUMERIC CHECK (rate >= 0), amount NUMERIC)
supplier_payments   (id, purchase_bill_id FK, date, amount NUMERIC CHECK (amount > 0), method, reference)

boms                (id, code UNIQUE, output_product_id FK, batch_size NUMERIC CHECK (batch_size > 0), status)
bom_items           (id, bom_id FK, material_product_id FK, qty NUMERIC CHECK (qty > 0), unit_id FK,
                      UNIQUE (bom_id, material_product_id))     -- enforces "no duplicate material in one BOM" at the DB level, not just in the UI
production_orders   (id, number UNIQUE, bom_id FK, product_id FK, planned_qty NUMERIC CHECK (planned_qty > 0),
                      warehouse_id FK, batch_no TEXT, status TEXT CHECK (status IN
                        ('DRAFT','PLANNED','IN_PRODUCTION','COMPLETED','CANCELLED')),
                      date DATE, completed_at TIMESTAMPTZ NULL, actual_cost NUMERIC NULL, output_batch_id FK NULL)
production_materials(id, production_order_id FK, material_product_id FK, required_qty NUMERIC, consumed_qty NUMERIC)
production_outputs  (id, production_order_id FK, batch_id FK, qty NUMERIC)

expenses            (id, number UNIQUE, date, category, description, amount NUMERIC CHECK (amount > 0),
                      method, warehouse_id FK NULL, employee_id FK NULL, notes)

assets              (id, name, category, serial_no, purchase_date, purchase_cost, current_value,
                      warehouse_id FK NULL, employee_id FK NULL, status)          -- scaffolded, not yet in the demo build
employees           (id, name, department, role_id FK NULL, phone, joined_at, status)

audit_logs          (id, user_id FK NULL, role_label TEXT, action TEXT, module TEXT,
                      entity TEXT, entity_id TEXT NULL, old_value JSONB NULL, new_value JSONB NULL,
                      reason TEXT NULL, ip_or_session TEXT NULL, created_at TIMESTAMPTZ)
                      -- append-only: REVOKE UPDATE, DELETE from every application role at the DB grant level

company_settings    (id, key UNIQUE, value JSONB)
gst_settings        (id, hsn, description, rate, effective_from DATE)
sequences           (name TEXT PRIMARY KEY, next_value BIGINT)   -- invoice/expense/purchase-bill numbering, one row per series, incremented via `UPDATE ... RETURNING` so it's race-safe
notifications       (id, user_id FK, kind, title, body, read BOOLEAN DEFAULT false, created_at)
```

**Integrity rules enforced at the database, not just the frontend:** `UNIQUE(sku)`, `UNIQUE(invoice.number)`, `UNIQUE(batches.product_id, warehouse_id, batch_no)`, `UNIQUE(bom_id, material_product_id)` (duplicate-material-in-BOM becomes structurally impossible, not just UI-validated), `CHECK` constraints on every quantity/price/percentage column, `FOREIGN KEY` everywhere a current JS `find()` lookup exists today (each one is a potential dangling reference in the localStorage version — the DB removes that risk entirely).

---

## 5. Transaction boundaries

Every one of these must run inside a single DB transaction with rollback on any failed step — mirroring exactly what `commitInvoice()`/`completeProduction()`/`performTransfer()` already do in-memory today (validate everything first, mutate nothing until every check has passed):

| Operation | Steps (abbreviated) | Rollback trigger |
|---|---|---|
| **Invoice creation** | validate customer → validate each product+warehouse+FEFO batch → validate stock per line → compute totals server-side → insert invoice+items → decrement each batch (guarded UPDATE, see §6) → insert stock_movements → insert initial payment if any | any batch's guarded UPDATE affects 0 rows (stock insufficient) |
| **Purchase** | validate supplier/product/warehouse → insert/increment batch → insert stock_movement → insert purchase_bill(+items) | any FK resolution fails |
| **Sales return** | validate invoice+line item → qty ≤ remaining → compute credit → update invoice.balance/grandTotal (unclamped) → increment batch → insert stock_movement | qty out of range |
| **Payment / reversal** | validate amount ≤ balance (payment) or payment not already reversed (reversal) → update invoice paid/balance/status → insert payment/mark reversed | amount exceeds balance |
| **Warehouse transfer** | validate source batch has qty → decrement source → increment/create destination batch → insert TRANSFER_OUT + TRANSFER_IN movements | insufficient source qty |
| **Manufacturing completion** | validate every material's total stock **before any write** → consume FEFO across batches → insert finished batch → insert stock_movement → update production_order status/cost | any material's required qty > available |
| **Invoice cancellation** | reject if `paid > 0` → reverse each line's stock (increment batch) → insert reversal movements → set status Cancelled, balance 0 | invoice has unreversed payments |

---

## 6. Concurrency strategy

The scenario you specified — two staff selling the last 5 units simultaneously — is exactly the case the in-memory version *cannot* protect against (JS is single-threaded per tab, but two browser tabs/devices sharing one `localStorage` origin, or truly two different users on a real deployment, absolutely can race). The fix does **not** require heavy row locking; an atomic conditional update is simpler and sufficient at this scale:

```sql
UPDATE batches
SET qty = qty - :requested_qty
WHERE id = :batch_id AND qty >= :requested_qty
RETURNING qty;
```

If this returns 0 rows, the transaction aborts with `INSUFFICIENT_STOCK` — the database itself is the arbiter, not application-level logic re-reading a stale number. Wrap the whole invoice-creation transaction at `REPEATABLE READ` (or `SERIALIZABLE` if the ORM makes that painless) so the FEFO batch *selection* and the *decrement* can't be split apart by another transaction in between. This pattern generalizes to transfers, production consumption, and payment-vs-balance checks (`UPDATE invoices SET balance = balance - :amt WHERE id = :id AND balance >= :amt`).

---

## 7–8. Authentication & RBAC (server-side)

- **Passwords:** bcrypt (cost 12) or argon2id server-side only. The current `simpleHash` client function is retired entirely in production mode — it was always documented as demo-only obfuscation, never real security.
- **Sessions:** server-side session store (Postgres table or Redis) keyed by an opaque session ID in an `httpOnly`, `Secure`, `SameSite=Lax` cookie. Sliding expiry (e.g. 8h of inactivity) plus an absolute cap (e.g. 7 days) forces re-login periodically.
- **Login throttling:** track failed attempts per (username, IP) pair; exponential backoff after 5 failures, hard lockout after 10 with an audit entry, matching the existing `Failed login` audit action already implemented in the demo build's design intent.
- **Password reset:** emailed single-use token, short TTL (15–30 min), invalidated after first use or expiry.
- **RBAC:** the `PERMS` map moves to `role_permissions` (data, not code) but ships seeded with *exactly* today's mapping so behavior doesn't silently change. Every mutating route runs a permission-check middleware **before** touching the database — this is non-negotiable per your instruction; the frontend's button-hiding remains purely cosmetic.
- **Last-Super-Admin protection** stays as an explicit business rule in the user-update service, independent of the generic permission check (exactly as coded today).

---

## 9. API design (representative, not exhaustive)

```
POST   /api/v1/auth/login              POST /api/v1/auth/logout
POST   /api/v1/auth/password-reset/request
POST   /api/v1/auth/password-reset/confirm

GET|POST        /api/v1/users            PATCH /api/v1/users/:id      (requires manageUsers)
GET|POST        /api/v1/customers        PATCH /api/v1/customers/:id
GET|POST        /api/v1/suppliers        PATCH /api/v1/suppliers/:id
GET|POST        /api/v1/products         PATCH /api/v1/products/:id   (price edit requires editPrice)
GET|POST        /api/v1/warehouses
GET             /api/v1/inventory                                     (derived view, warehouse-scoped)
GET|POST        /api/v1/batches
POST            /api/v1/stock/transfer                                (requires transferStock)
POST            /api/v1/stock/adjust                                  (requires adjustStock)

POST            /api/v1/invoices                                      (requires createInvoice)
POST            /api/v1/invoices/:id/cancel                           (requires cancelInvoice)
POST            /api/v1/invoices/:id/payments                         (requires recordPayment)
POST            /api/v1/payments/:id/reverse                          (requires reversePayment)
POST            /api/v1/invoices/:id/returns                          (requires recordReturn)

POST            /api/v1/purchases                                     (requires addStock)
POST            /api/v1/purchase-bills/:id/payments                   (requires manageSupplier)

GET|POST        /api/v1/boms                                          (requires manufacture)
POST            /api/v1/production-orders                             (requires manufacture)
POST            /api/v1/production-orders/:id/complete                (requires manufacture)

GET|POST        /api/v1/expenses                                      (requires manageExpense)

GET             /api/v1/reports/gst?from=&to=
GET             /api/v1/reports/profit-loss?from=&to=
GET             /api/v1/reports/sales-register?from=&to=
GET             /api/v1/audit-logs                                     (read-only, no PATCH/DELETE route exists at all)

GET             /api/v1/backup/export                                  (requires backup)
POST            /api/v1/backup/import                                  (requires backup, destructive-confirm required)
```

---

## 10. Frontend service-layer abstraction

Today every UI action calls `DB.products.push(...)`, `DB.save()`, etc. directly. The prep step — safe to do **without** a backend existing yet — is wrapping each of these behind a named function so the eventual swap touches one file, not every screen:

```js
// services/invoiceService.js (demo mode shown; production mode swaps body to fetch())
export const invoiceService = {
  create: (payload) => DB_MODE === 'local'
    ? localCommitInvoice(payload)
    : fetch('/api/v1/invoices', { method: 'POST', body: JSON.stringify(payload) }).then(r => r.json()),
  cancel: (id, reason) => DB_MODE === 'local' ? localCancelInvoice(id, reason) : fetch(`/api/v1/invoices/${id}/cancel`, {...}),
  // ...
};
```
Proposed services: `authService`, `userService`, `customerService`, `supplierService`, `productService`, `warehouseService`, `inventoryService`, `batchService`, `invoiceService`, `paymentService`, `purchaseService`, `manufacturingService`, `expenseService`, `reportService`, `auditService`, `backupService`. The UI calls only these — never `DB.*` directly once this lands.

---

## 11. Local demo mode vs production mode

A single `DB_MODE` flag (`'local' | 'api'`) gates every service function's branch, as shown above. The two must never mix silently: if `DB_MODE === 'api'` and a network call fails, the UI shows an error — it must **not** silently fall back to localStorage, or the two data stores would appear to merge and corrupt each other's apparent state.

---

## 12. Migration mapping (localStorage → database)

| localStorage array | → | Database table(s) |
|---|---|---|
| `products` | → | `products` (+ `product_categories`, `units` normalized out) |
| `customers` | → | `customers` |
| `suppliers` | → | `suppliers` |
| `warehouses` | → | `warehouses` |
| `batches` | → | `batches` |
| *(derived: warehouseProductStock)* | → | `stock` VIEW over `batches` — no table |
| `stockMovements` | → | `stock_movements` |
| `invoices` (incl. nested `items[]`, `payments[]`) | → | `invoices` + `invoice_items` + `payments` (unnested into proper child tables) |
| *(returns, currently mutate the invoice in place)* | → | `sales_returns` + `sales_return_items` (now a real auditable record, not just a mutation) |
| `purchaseBills` | → | `purchase_bills` + `purchase_bill_items` + `supplier_payments` |
| `boms` (incl. nested `items[]`) | → | `boms` + `bom_items` |
| `productionOrders` | → | `production_orders` + `production_materials` + `production_outputs` |
| `expenses` | → | `expenses` |
| `users` | → | `users` + `roles` + `role_permissions` (role string → FK + seeded permission rows) |
| `auditLog` | → | `audit_logs` (role captured at write time, exactly as today) |
| `invoiceSeq` / `expenseSeq` / `purchaseBillSeq` | → | `sequences` (one row per series) |

**No historical data is lost:** the existing "Export database (JSON)" feature already produces exactly this source data; the migration script is a one-time ETL job that reads that JSON and performs the unnesting above, run once per real customer's dataset before cutover.

---

## 13. API error contract

```json
{ "code": "INSUFFICIENT_STOCK", "message": "Only 4 units are available in Feed Warehouse.", "details": { "productId": "p1", "warehouseId": "w2", "requested": 6, "available": 4 } }
```
Stable codes (non-exhaustive): `INSUFFICIENT_STOCK`, `BATCH_EXPIRED`, `DUPLICATE_SKU`, `DUPLICATE_INVOICE_NUMBER`, `DUPLICATE_BATCH`, `PAYMENT_EXCEEDS_BALANCE`, `INVOICE_HAS_PAYMENTS` (blocks cancellation), `PERMISSION_DENIED`, `LAST_SUPER_ADMIN_PROTECTED`, `VALIDATION_ERROR`. The frontend maps codes to the same human-readable strings the demo build already shows (e.g. *"This batch has expired and cannot be sold."*) rather than displaying raw codes.

---

## 14. Audit (server-side)

Same shape as today (`who/what/when/entity/old/new/reason`), plus `ip_or_session` where a backend actually has that information. Enforced at the database grant level: the application's normal DB role gets `INSERT` on `audit_logs` only — no `UPDATE`, no `DELETE` — so even a bug or a compromised app credential cannot rewrite history.

---

## 15. Backup strategy (production)

The browser JSON export is explicitly **demo-only** and must not be presented as a production backup strategy. Production needs: automated nightly `pg_dump` (or managed-provider snapshot) + continuous WAL archiving for point-in-time recovery; a retention policy (e.g. 30 daily, 12 monthly); periodic restore drills into a scratch environment to *prove* backups are valid, not just taken; and a documented disaster-recovery runbook (RTO/RPO targets, who executes it).

---

## 16. Report implementation status (honest accounting)

| Report | Status today |
|---|---|
| Sales Register, GST (GSTR-1/3B-style), Profit & Loss, Stock Summary | **Real**, computed live from actual invoice/batch data |
| Purchase Register, Stock Movement, Customer Ledger, Supplier Ledger, Receivables, Payables | Data exists and is correct (proven by the ledger/reconciliation tests) but **not yet wired to a Reports-page button** — currently only reachable via the Customer/Supplier detail screens |
| Product Sales, Customer Sales, Warehouse Stock breakdown, Batch/Expiry, Manufacturing summary, Production Cost, Expense report | **Placeholders** — clicking shows an honest "not yet implemented" message rather than fabricated numbers |

---

## 17. Test strategy

- **Unit** (already exists, 76 assertions): pure business-calculation functions (`profitSummary`, `gstSummary`, `batchStatus`, `fefoBatches`, `computeProductionRequirements`) — keep these, port them to run against the real backend's equivalent functions so the *same* 76 assertions become the acceptance test for the migration.
- **Integration**: spin up a real Postgres (test containers) + the API, exercise every endpoint above.
- **Transaction/concurrency**: fire two concurrent requests at the same batch with combined qty > available; assert exactly one succeeds and stock never goes negative or duplicates.
- **Authorization**: for every route × every role, assert 200/201 for allowed actions and 403 for everything else — this turns the current `PERMS` map into an exhaustive test matrix automatically.
- **End-to-end** (Playwright/Cypress against a staging deploy): the full scenario in your §18, driven through the actual UI, not just the API.

---

## 18. End-to-end scenario (acceptance test for the whole migration)

Login → create customer → create product → purchase stock (creates batch + purchase bill) → create invoice (deducts stock, resolves FEFO batch) → partial payment → remaining payment (status → Paid) → sales return (credit applied, stock restored) → warehouse transfer → create production order → complete it (raw materials consumed FEFO, finished batch created) → view customer ledger (balance reconciles) → view supplier ledger (payable reconciles) → view GST report (matches per-line recomputation) → view P&L (gross/net match COGS-based formula) → logout. Every step must be visible in the database afterward (not just "the UI looked right") — verified by direct SQL queries in the integration test, not by re-trusting the same API that wrote the data.

---

## 19–20. What can be done now vs what needs real infrastructure

**Can be done inside the current project, no server required:**
- Everything in this document (freezing rules, schema design, API contract) — done.
- The frontend service-layer abstraction (§10) — pure refactor, no behavior change, makes the eventual swap mechanical.
- Expanding the Node-based business-logic test suite to cover every rule in §1 exhaustively.
- Seeding `role_permissions`-shaped data even while still enforcing it client-side, so the eventual server-side seed script is a copy-paste, not a redesign.

**Cannot be done without a real server + database:**
- Actual password hashing/session security (bcrypt/argon2, httpOnly cookies, server-side session store).
- Real RBAC enforcement (a backend that a browser cannot bypass by editing the page).
- Real concurrency control (the atomic-UPDATE / row-lock pattern in §6 requires a real transactional database).
- True multi-user consistency (two people on two devices seeing the same data in real time).
- Automated backups, point-in-time recovery, disaster recovery.
- TLS termination, rate limiting, and any of the "production security" items flagged honestly in the previous phase's Settings → Data & Security tab.

**Recommended stack, restated plainly:** Node.js + TypeScript + Express (or Fastify) API, PostgreSQL via Prisma, bcrypt + server-side sessions (Postgres or Redis-backed), REST over JSON, Playwright for e2e. Nothing exotic — this is deliberately the smallest stack that satisfies every constraint above, chosen because it shares a language with the existing frontend code and because an SMB cattle-feed ERP does not need microservices, a message queue, or a NoSQL store.
