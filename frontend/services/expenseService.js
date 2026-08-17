(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.expenseService = {
    list: () => api.get('/api/v1/expenses'),
    create: (payload) => api.post('/api/v1/expenses', payload)
  };
})();
