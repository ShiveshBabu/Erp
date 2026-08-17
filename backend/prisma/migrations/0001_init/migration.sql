-- Sri Velan Pasumai ERP — initial schema migration
-- Hand-authored to exactly match prisma/schema.prisma.
--
-- WHY THIS FILE EXISTS INSTEAD OF A `prisma migrate dev` OUTPUT:
-- `prisma generate` / `prisma migrate dev` both require downloading a native
-- query-engine binary from https://binaries.prisma.sh at runtime. That host
-- is not reachable under this environment's network egress policy (only
-- npm/pypi/github/ubuntu-archive domains are allowlisted), so the Prisma CLI
-- cannot execute here — confirmed via repeated 403 Forbidden responses.
-- schema.prisma remains the source of truth; in any environment with normal
-- internet access, `npx prisma migrate dev` would generate this exact SQL
-- (modulo Prisma's own naming conventions for constraint names) directly
-- from that file, and this hand-written file can be deleted at that point.

-- ============================== Enums ==============================
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "ProductType" AS ENUM ('MANUFACTURED', 'TRADED', 'RAW');
CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "StockMovementType" AS ENUM ('OPENING_STOCK','PURCHASE','SALE','SALES_RETURN',
  'PURCHASE_RETURN','PRODUCTION','PRODUCTION_CONSUMPTION','STOCK_ADJUSTMENT','DAMAGE',
  'EXPIRED','TRANSFER_IN','TRANSFER_OUT','INVOICE_CANCELLATION_REVERSAL');
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','CREDIT_DUE');
CREATE TYPE "PurchaseBillStatus" AS ENUM ('UNPAID','PARTIALLY_PAID','PAID','CANCELLED');
CREATE TYPE "BomStatus" AS ENUM ('ACTIVE','DRAFT');
CREATE TYPE "ProductionStatus" AS ENUM ('DRAFT','PLANNED','IN_PRODUCTION','COMPLETED','CANCELLED');

-- ============================== RBAC ==============================
CREATE TABLE "roles" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "label" TEXT NOT NULL
);

CREATE TABLE "permissions" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "label" TEXT NOT NULL
);

CREATE TABLE "role_permissions" (
  "roleId" TEXT NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permissionId" TEXT NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
  PRIMARY KEY ("roleId", "permissionId")
);

CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "username" TEXT NOT NULL UNIQUE,
  "phone" TEXT,
  "passwordHash" TEXT NOT NULL,
  "roleId" TEXT NOT NULL REFERENCES "roles"("id"),
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdById" TEXT REFERENCES "users"("id"),
  "lastLoginAt" TIMESTAMPTZ,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ
);

-- ============================== Customers / Suppliers ==============================
CREATE TABLE "customers" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "subArea" TEXT,
  "owner" TEXT,
  "type" TEXT NOT NULL,
  "gstin" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "creditLimit" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "since" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "suppliers" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "contact" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "gstin" TEXT,
  "address" TEXT,
  "paymentTerms" TEXT DEFAULT 'Net 30',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================== Catalog ==============================
CREATE TABLE "product_categories" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE
);

CREATE TABLE "units" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE
);

CREATE TABLE "products" (
  "id" TEXT PRIMARY KEY,
  "sku" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL REFERENCES "product_categories"("id"),
  "hsn" TEXT,
  "unitId" TEXT NOT NULL REFERENCES "units"("id"),
  "purchasePrice" NUMERIC(14,2) NOT NULL CHECK ("purchasePrice" >= 0),
  "sellingPrice" NUMERIC(14,2) CHECK ("sellingPrice" IS NULL OR "sellingPrice" >= 0),
  "gstRate" NUMERIC(5,2) NOT NULL CHECK ("gstRate" >= 0 AND "gstRate" <= 100),
  "reorderLevel" NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK ("reorderLevel" >= 0),
  "expiryTracking" BOOLEAN NOT NULL DEFAULT false,
  "type" "ProductType" NOT NULL DEFAULT 'TRADED',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================== Warehouses / stock ==============================
CREATE TABLE "warehouses" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL UNIQUE,
  "address" TEXT,
  "managerId" TEXT REFERENCES "users"("id"),
  "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "batches" (
  "id" TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "batchNo" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL REFERENCES "warehouses"("id"),
  "qty" NUMERIC(14,3) NOT NULL CHECK ("qty" >= 0),
  "mfgDate" TIMESTAMPTZ,
  "expiryDate" TIMESTAMPTZ,
  "purchaseRate" NUMERIC(14,2) NOT NULL CHECK ("purchaseRate" >= 0),
  "supplierId" TEXT REFERENCES "suppliers"("id"),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_batch_per_warehouse" UNIQUE ("productId", "warehouseId", "batchNo")
);
CREATE INDEX "batches_productId_warehouseId_idx" ON "batches" ("productId", "warehouseId");

CREATE TABLE "stock_movements" (
  "id" TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "batchId" TEXT REFERENCES "batches"("id"),
  "warehouseId" TEXT NOT NULL REFERENCES "warehouses"("id"),
  "type" "StockMovementType" NOT NULL,
  "qty" NUMERIC(14,3) NOT NULL,
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "referenceId" TEXT,
  "note" TEXT
);
CREATE INDEX "stock_movements_product_wh_date_idx" ON "stock_movements" ("productId", "warehouseId", "date");

-- ============================== Invoices / payments / returns ==============================
CREATE TABLE "invoices" (
  "id" TEXT PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "customerId" TEXT NOT NULL REFERENCES "customers"("id"),
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "dueDate" TIMESTAMPTZ NOT NULL,
  "subtotal" NUMERIC(14,2) NOT NULL,
  "tax" NUMERIC(14,2) NOT NULL,
  "grandTotal" NUMERIC(14,2) NOT NULL CHECK ("grandTotal" >= 0),
  "paid" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "balance" NUMERIC(14,2) NOT NULL, -- may be negative: CREDIT_DUE
  "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
  "createdById" TEXT REFERENCES "users"("id"),
  "cancelledAt" TIMESTAMPTZ,
  "cancelledById" TEXT REFERENCES "users"("id"),
  "cancelReason" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "invoices_customerId_idx" ON "invoices" ("customerId");
CREATE INDEX "invoices_status_idx" ON "invoices" ("status");

CREATE TABLE "invoice_items" (
  "id" TEXT PRIMARY KEY,
  "invoiceId" TEXT NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "batchId" TEXT NOT NULL REFERENCES "batches"("id"),
  "warehouseId" TEXT NOT NULL REFERENCES "warehouses"("id"),
  "qty" NUMERIC(14,3) NOT NULL CHECK ("qty" >= 0),
  "unitId" TEXT NOT NULL REFERENCES "units"("id"),
  "rate" NUMERIC(14,2) NOT NULL CHECK ("rate" >= 0),
  "discountPct" NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK ("discountPct" >= 0 AND "discountPct" <= 100),
  "gstRate" NUMERIC(5,2) NOT NULL,
  "hsn" TEXT
);

CREATE TABLE "payments" (
  "id" TEXT PRIMARY KEY,
  "invoiceId" TEXT NOT NULL REFERENCES "invoices"("id"),
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "amount" NUMERIC(14,2) NOT NULL CHECK ("amount" > 0),
  "method" TEXT NOT NULL,
  "reference" TEXT,
  "reversed" BOOLEAN NOT NULL DEFAULT false,
  "reversedAt" TIMESTAMPTZ,
  "createdById" TEXT REFERENCES "users"("id")
);
CREATE INDEX "payments_invoiceId_idx" ON "payments" ("invoiceId");

CREATE TABLE "sales_returns" (
  "id" TEXT PRIMARY KEY,
  "invoiceId" TEXT NOT NULL REFERENCES "invoices"("id"),
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reason" TEXT,
  "creditValue" NUMERIC(14,2) NOT NULL
);

CREATE TABLE "sales_return_items" (
  "id" TEXT PRIMARY KEY,
  "salesReturnId" TEXT NOT NULL REFERENCES "sales_returns"("id") ON DELETE CASCADE,
  "invoiceItemId" TEXT NOT NULL REFERENCES "invoice_items"("id"),
  "qty" NUMERIC(14,3) NOT NULL CHECK ("qty" > 0)
);

-- ============================== Purchases ==============================
CREATE TABLE "purchase_bills" (
  "id" TEXT PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "supplierId" TEXT NOT NULL REFERENCES "suppliers"("id"),
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "amount" NUMERIC(14,2) NOT NULL CHECK ("amount" >= 0),
  "paid" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "balance" NUMERIC(14,2) NOT NULL,
  "status" "PurchaseBillStatus" NOT NULL DEFAULT 'UNPAID',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "purchase_bills_supplierId_idx" ON "purchase_bills" ("supplierId");

CREATE TABLE "purchase_bill_items" (
  "id" TEXT PRIMARY KEY,
  "purchaseBillId" TEXT NOT NULL REFERENCES "purchase_bills"("id") ON DELETE CASCADE,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "qty" NUMERIC(14,3) NOT NULL CHECK ("qty" > 0),
  "rate" NUMERIC(14,2) NOT NULL CHECK ("rate" >= 0),
  "amount" NUMERIC(14,2) NOT NULL
);

CREATE TABLE "supplier_payments" (
  "id" TEXT PRIMARY KEY,
  "purchaseBillId" TEXT NOT NULL REFERENCES "purchase_bills"("id"),
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "amount" NUMERIC(14,2) NOT NULL CHECK ("amount" > 0),
  "method" TEXT NOT NULL,
  "reference" TEXT
);

-- ============================== Manufacturing ==============================
CREATE TABLE "boms" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "outputProductId" TEXT NOT NULL REFERENCES "products"("id"),
  "batchSize" NUMERIC(14,3) NOT NULL CHECK ("batchSize" > 0),
  "status" "BomStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "bom_items" (
  "id" TEXT PRIMARY KEY,
  "bomId" TEXT NOT NULL REFERENCES "boms"("id") ON DELETE CASCADE,
  "materialProductId" TEXT NOT NULL REFERENCES "products"("id"),
  "qty" NUMERIC(14,3) NOT NULL CHECK ("qty" > 0),
  "unitId" TEXT NOT NULL REFERENCES "units"("id"),
  CONSTRAINT "uniq_material_per_bom" UNIQUE ("bomId", "materialProductId")
);

CREATE TABLE "production_orders" (
  "id" TEXT PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "bomId" TEXT NOT NULL REFERENCES "boms"("id"),
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "plannedQty" NUMERIC(14,3) NOT NULL CHECK ("plannedQty" > 0),
  "warehouseId" TEXT NOT NULL REFERENCES "warehouses"("id"),
  "batchNo" TEXT,
  "status" "ProductionStatus" NOT NULL DEFAULT 'PLANNED',
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt" TIMESTAMPTZ,
  "actualCost" NUMERIC(14,2),
  "cancelledAt" TIMESTAMPTZ,
  "cancelReason" TEXT
);

CREATE TABLE "production_materials" (
  "id" TEXT PRIMARY KEY,
  "productionOrderId" TEXT NOT NULL REFERENCES "production_orders"("id") ON DELETE CASCADE,
  "materialProductId" TEXT NOT NULL REFERENCES "products"("id"),
  "requiredQty" NUMERIC(14,3) NOT NULL,
  "consumedQty" NUMERIC(14,3) NOT NULL DEFAULT 0
);

CREATE TABLE "production_outputs" (
  "id" TEXT PRIMARY KEY,
  "productionOrderId" TEXT NOT NULL REFERENCES "production_orders"("id") ON DELETE CASCADE,
  "batchId" TEXT NOT NULL REFERENCES "batches"("id"),
  "qty" NUMERIC(14,3) NOT NULL
);

-- ============================== Expenses / Audit / Settings ==============================
CREATE TABLE "expenses" (
  "id" TEXT PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "date" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" NUMERIC(14,2) NOT NULL CHECK ("amount" > 0),
  "method" TEXT NOT NULL,
  "warehouseId" TEXT REFERENCES "warehouses"("id"),
  "employee" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT REFERENCES "users"("id"),
  "roleLabel" TEXT,
  "action" TEXT NOT NULL,
  "module" TEXT,
  "entity" TEXT,
  "entityId" TEXT,
  "oldValue" JSONB,
  "newValue" JSONB,
  "reason" TEXT,
  "sessionInfo" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs" ("createdAt");
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs" ("entity", "entityId");

CREATE TABLE "company_settings" (
  "key" TEXT PRIMARY KEY,
  "value" JSONB NOT NULL
);

CREATE TABLE "gst_settings" (
  "id" TEXT PRIMARY KEY,
  "hsn" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "rate" NUMERIC(5,2) NOT NULL,
  "effectiveFrom" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "sequences" (
  "name" TEXT PRIMARY KEY,
  "nextValue" BIGINT NOT NULL DEFAULT 1
);

-- ============================== Password reset ==============================
CREATE TABLE "password_reset_tokens" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id"),
  "tokenHash" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "usedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens" ("userId");

-- ============================== Server-side sessions ==============================
-- Infra table, deliberately not modeled in schema.prisma (it's not business data).
CREATE TABLE "sessions" (
  "sid" TEXT PRIMARY KEY,
  "data" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");

-- ============================== Audit log lockdown ==============================
-- Per instruction: the application DB role must not be able to UPDATE or DELETE
-- audit records. Applied in a separate script (02_app_role_grants.sql) once the
-- svp_app role's exact privilege set is finalized, so this migration stays a
-- pure schema definition.
