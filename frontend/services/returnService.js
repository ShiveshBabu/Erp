(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.returnService = {
    create: (invoiceItemId, qty, reason) => api.post('/api/v1/returns', { invoiceItemId, qty, reason })
  };
})();
