(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.userService = {
    list: () => api.get('/api/v1/users'),
    create: (payload) => api.post('/api/v1/users', payload),
    update: (id, payload) => api.patch(`/api/v1/users/${id}`, payload)
  };
})();
