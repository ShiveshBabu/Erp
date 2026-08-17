(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.customerService = {
    list: () => api.get('/api/v1/customers'),
    create: (payload) => api.post('/api/v1/customers', payload),
    update: (id, payload) => api.patch(`/api/v1/customers/${id}`, payload),
    ledger: (id) => api.get(`/api/v1/customers/${id}/ledger`)
  };
})();
