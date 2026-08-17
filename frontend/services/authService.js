(function () {
  'use strict';
  const api = window.SVP.api;

  window.SVP.authService = {
    login: (usernameOrEmail, password) => api.post('/api/v1/auth/login', { usernameOrEmail, password }),
    logout: () => api.post('/api/v1/auth/logout'),
    me: () => api.get('/api/v1/auth/me'),
    changePassword: (currentPassword, newPassword) => api.post('/api/v1/auth/change-password', { currentPassword, newPassword })
  };
})();
