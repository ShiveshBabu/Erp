(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.warehouseService = {
    list: () => api.get('/api/v1/warehouses'),
    create: (payload) => api.post('/api/v1/warehouses', payload),
    transfer: (batchId, toWarehouseId, qty) => api.post('/api/v1/inventory/transfer', { batchId, toWarehouseId, qty })
  };
})();
