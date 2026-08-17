(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.manufacturingService = {
    listBoms: () => api.get('/api/v1/boms'),
    listProductionOrders: () => api.get('/api/v1/production-orders'),
    createBom: (payload) => api.post('/api/v1/boms', payload), // {code, outputProductId, batchSize, items:[{materialProductId, qty, unitId}]}
    createProductionOrder: (payload) => api.post('/api/v1/production-orders', payload), // {bomId, plannedQty, warehouseId, batchNo?}
    // Called BEFORE offering the "Complete" button — the UI disables Complete
    // if summary.blocked is true, but the backend independently re-validates
    // this on the actual complete call regardless of what the UI showed.
    checkAvailability: (productionOrderId) => api.get(`/api/v1/production-orders/${productionOrderId}/availability`),
    complete: (productionOrderId) => api.post(`/api/v1/production-orders/${productionOrderId}/complete`)
  };
})();
