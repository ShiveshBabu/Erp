(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.productService = {
    list: () => api.get('/api/v1/products'),
    categories: () => api.get('/api/v1/product-categories'),
    units: () => api.get('/api/v1/units'),
    create: (payload) => api.post('/api/v1/products', payload),
    update: (id, payload) => api.patch(`/api/v1/products/${id}`, payload)
  };
})();
