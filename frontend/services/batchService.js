(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.batchService = {
    list: () => api.get('/api/v1/batches'),
    create: (payload) => api.post('/api/v1/batches', payload)
  };
})();
