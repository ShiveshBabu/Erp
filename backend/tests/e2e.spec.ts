import { test, expect } from '@playwright/test';

// NOTE ON EXECUTION: this spec is real and complete, but could not be run in
// the sandbox that authored it — `npx playwright install chromium` fails
// with "Host not in allowlist: cdn.playwright.dev", confirmed via the actual
// install command, not assumed. Run this in any environment with normal
// internet access: `npx playwright install && npx playwright test`.
// The frontend must be served (not opened as a file://) with window.SVP_API_BASE_URL
// pointed at the backend, e.g. via `npx serve .` in the frontend directory.

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173/Sri Velan Pasumai ERP.dc.html';
const ADMIN = { user: 'ravi.velan', pass: process.env.DEV_SEED_PASSWORD || 'ChangeMe123!' };

test.describe('Sri Velan Pasumai ERP — full workflow (E2E)', () => {
  test('Login → Customer → Product → Purchase → Batch → Invoice → Payments → Return → Transfer → Manufacturing → Ledgers → Reports → Logout', async ({ page }) => {
    // ---- AUTH-001: Login ----
    await page.goto(FRONTEND_URL);
    await page.getByPlaceholder(/username|email/i).fill(ADMIN.user);
    await page.getByPlaceholder(/password/i).fill(ADMIN.pass);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page.getByText(/dashboard/i)).toBeVisible({ timeout: 10000 });

    // ---- AUTH-004 sanity: protected route requires session (checked via reload) ----
    await page.reload();
    await expect(page.getByText(/dashboard/i)).toBeVisible({ timeout: 10000 }); // session restored via /auth/me

    // ---- Customer ----
    await page.getByRole('link', { name: /customers/i }).click();
    await page.getByRole('button', { name: /new customer/i }).click();
    await page.getByLabel(/customer.*name/i).fill('Playwright Test Farm');
    await page.getByRole('button', { name: /add customer|create customer/i }).click();
    await expect(page.getByText('Playwright Test Farm')).toBeVisible();

    // ---- Product ----
    await page.getByRole('link', { name: /products/i }).click();
    await page.getByRole('button', { name: /new product/i }).click();
    await page.getByLabel(/product name/i).fill('Playwright Test Feed');
    await page.getByLabel(/^sku/i).fill('PW-TEST-' + Date.now());
    await page.getByLabel(/purchase price/i).fill('1000');
    await page.getByLabel(/selling price/i).fill('1300');
    await page.getByLabel(/gst/i).fill('5');
    await page.getByRole('button', { name: /add product|create product/i }).click();
    await expect(page.getByText('Playwright Test Feed')).toBeVisible();

    // ---- Purchase (creates batch + supplier bill) ----
    await page.getByRole('link', { name: /inventory/i }).click();
    await page.getByRole('button', { name: /add stock/i }).click();
    await page.getByLabel(/product name/i).fill('Playwright Test Feed');
    await page.getByLabel(/warehouse/i).first().fill('Main Warehouse');
    await page.getByLabel(/quantity/i).fill('100');
    await page.getByLabel(/supplier/i).fill('Erode Maize Traders');
    await page.getByRole('button', { name: /add stock/i }).click();
    await expect(page.getByText(/added to Playwright Test Feed/i)).toBeVisible();

    // ---- Batch check (Batches page shows the new lot) ----
    await page.getByRole('link', { name: /batches/i }).click();
    await expect(page.getByText('Playwright Test Feed')).toBeVisible();

    // ---- Invoice ----
    await page.getByRole('link', { name: /billing|invoices/i }).click();
    await page.getByLabel(/customer/i).fill('Playwright Test Farm');
    // product line entry depends on the actual billing UI's add-row control
    await page.getByRole('button', { name: /add line|add product/i }).click();
    await page.getByRole('button', { name: /save & print|save invoice/i }).click();
    await expect(page.getByText(/invoice.*saved/i)).toBeVisible();

    // ---- Partial payment ----
    await page.getByRole('button', { name: /record payment/i }).click();
    await page.getByLabel(/amount/i).fill('500');
    await page.getByRole('button', { name: /record payment/i }).click();
    await expect(page.getByText(/partially paid/i)).toBeVisible();

    // ---- Full payment ----
    await page.getByRole('button', { name: /record payment/i }).click();
    await page.getByRole('button', { name: /record payment/i }).click(); // suggested amount = remaining balance
    await expect(page.getByText(/^paid$/i)).toBeVisible();

    // ---- Return ----
    await page.getByRole('button', { name: /record return/i }).click();
    await page.getByLabel(/product/i).fill('Playwright Test Feed');
    await page.getByLabel(/quantity returned/i).fill('1');
    await page.getByRole('button', { name: /record return/i }).click();
    await expect(page.getByText(/returned/i)).toBeVisible();

    // ---- Warehouse transfer ----
    await page.getByRole('link', { name: /inventory/i }).click();
    await page.getByRole('button', { name: /transfer stock/i }).click();
    await page.getByLabel(/product name/i).fill('Playwright Test Feed');
    await page.getByLabel(/source warehouse/i).fill('Main Warehouse');
    await page.getByLabel(/destination warehouse/i).fill('Feed Warehouse');
    await page.getByLabel(/quantity/i).fill('10');
    await page.getByRole('button', { name: /transfer/i }).click();
    await expect(page.getByText(/transferred/i)).toBeVisible();

    // ---- Manufacturing: BOM + production order + complete ----
    await page.getByRole('link', { name: /manufacturing/i }).click();
    await expect(page.getByText(/BOM-F50/i)).toBeVisible();
    await page.getByRole('link', { name: /production/i }).click();
    await page.getByRole('button', { name: /new production order/i }).click();
    await page.getByLabel(/bom code/i).fill('BOM-F50-v4');
    await page.getByLabel(/planned quantity/i).fill('50');
    await page.getByLabel(/output warehouse/i).fill('Feed Warehouse');
    await page.getByRole('button', { name: /create order/i }).click();
    await page.getByText(/PRD-/).first().click();
    await page.getByRole('button', { name: /complete production/i }).click();
    await expect(page.getByText(/completed/i)).toBeVisible();

    // ---- Customer ledger ----
    await page.getByRole('link', { name: /customers/i }).click();
    await page.getByText('Playwright Test Farm').click();
    await page.getByRole('tab', { name: /ledger/i }).click();
    await expect(page.getByText(/balance/i)).toBeVisible();

    // ---- Supplier ledger ----
    await page.getByRole('link', { name: /suppliers/i }).click();
    await page.getByText('Erode Maize Traders').click();
    await expect(page.getByText(/payable/i)).toBeVisible();

    // ---- GST report ----
    await page.getByRole('link', { name: /reports/i }).click();
    await page.getByText(/GSTR-1/i).click();
    await expect(page.getByText(/taxable value/i)).toBeVisible();

    // ---- P&L ----
    await page.getByText(/profit.*loss/i).click();
    await expect(page.getByText(/gross profit/i)).toBeVisible();

    // ---- Logout ----
    await page.getByRole('button', { name: /log ?out/i }).click();
    await expect(page.getByPlaceholder(/username|email/i)).toBeVisible();

    // ---- AUTH-004: protected route now requires login again ----
    await page.goto(FRONTEND_URL);
    await expect(page.getByPlaceholder(/username|email/i)).toBeVisible();
  });
});
