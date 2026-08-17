(function () {
  'use strict';
  const api = window.SVP.api;

  function qs(from, to) { return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`; }

  window.SVP.reportService = {
    // These four endpoints are real on the backend (src/routes/reports.ts).
    gst: (from, to) => api.get('/api/v1/reports/gst' + qs(from, to)),
    profitAndLoss: (from, to) => api.get('/api/v1/reports/profit-loss' + qs(from, to)),
    salesRegister: (from, to) => api.get('/api/v1/reports/sales-register' + qs(from, to)),
    stockSummary: () => api.get('/api/v1/reports/stock-summary'),
    // Ledgers live under their own resources, not /reports, but are exposed
    // here too since they're conceptually "reports" from the UI's point of view.
    customerLedger: (customerId) => api.get(`/api/v1/customers/${customerId}/ledger`),
    supplierLedger: (supplierId) => api.get(`/api/v1/suppliers/${supplierId}/ledger`),
    // Anything NOT in the list above (Purchase Register, Stock Movement detail,
    // Receivables/Payables ageing, etc.) has no backend endpoint yet. The UI
    // must show "Report not yet available" for these rather than fabricate
    // data — see reportVals() in the app script.
    NOT_YET_IMPLEMENTED: ['Purchase Register', 'Stock Movement', 'Receivables ageing', 'Payables ageing',
      'Product Sales', 'Customer Sales', 'Manufacturing summary', 'Production Cost', 'Batch/Expiry report']
  };
})();
