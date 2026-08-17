(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.invoiceService = {
    list: () => api.get('/api/v1/invoices'),
    get: (id) => api.get(`/api/v1/invoices/${id}`),
    // NOTE: this payload deliberately never includes subtotal/tax/grandTotal.
    // Only qty/rate/discountPct/productId/batchId(optional) go to the server —
    // the backend recalculates every money figure itself. Any preview total
    // shown before saving is UI-only and is discarded once the real response
    // comes back.
    create: (payload) => api.post('/api/v1/invoices', payload),
    cancel: (id, reason) => api.post(`/api/v1/invoices/${id}/cancel`, { reason })
  };
})();
