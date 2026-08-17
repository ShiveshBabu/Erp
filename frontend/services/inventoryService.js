(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.inventoryService = {
    // Derived from batches on the backend — never computed independently here.
    list: () => api.get('/api/v1/inventory'),
    adjust: (batchId, type, qty, reason) => api.post('/api/v1/inventory/adjustments', { batchId, type, qty, reason })
  };
})();
