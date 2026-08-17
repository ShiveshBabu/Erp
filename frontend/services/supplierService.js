(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.supplierService = {
    list: () => api.get('/api/v1/suppliers'),
    create: (payload) => api.post('/api/v1/suppliers', payload),
    ledger: (id) => api.get(`/api/v1/suppliers/${id}/ledger`),
    recordPayment: (billId, payload) => api.post(`/api/v1/purchases/${billId}/payments`, payload)
  };
})();
