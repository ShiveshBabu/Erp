(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.purchaseService = {
    list: () => api.get('/api/v1/purchases'),
    create: (payload) => api.post('/api/v1/purchases', payload), // {supplierId, warehouseId, productId, batchNo?, qty, rate, mfgDate?, expiryDate?}
    recordSupplierPayment: (billId, payload) => api.post(`/api/v1/purchases/${billId}/payments`, payload)
  };
})();
