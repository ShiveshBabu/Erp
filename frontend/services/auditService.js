(function () {
  'use strict';
  const api = window.SVP.api;

  // Deliberately read-only: there is no update/delete method here, matching
  // the backend where no such route exists and the DB role has no grant for it.
  window.SVP.auditService = {
    list: (limit) => api.get('/api/v1/audit' + (limit ? `?limit=${limit}` : ''))
  };
})();
