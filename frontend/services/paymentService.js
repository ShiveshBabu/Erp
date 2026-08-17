(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.paymentService = {
    record: (invoiceId, amount, method, reference) => api.post('/api/v1/payments', { invoiceId, amount, method, reference }),
    reverse: (paymentId) => api.post(`/api/v1/payments/${paymentId}/reverse`)
  };
})();
