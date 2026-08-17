// Sri Velan Pasumai ERP — frontend API client
// Loaded as a plain global (no bundler in this project — the app itself is
// a single <script data-dc-script> block evaluated by dc-runtime in the
// same window realm, so this file just needs to exist before that runs).
//
// Everything attaches to window.SVP.* so the app code can reference it
// without import/require, matching the existing architecture.
(function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 15000;

  // Same-origin by default (the API is expected to be reverse-proxied under
  // /api, or you can override this before support.js loads, e.g.
  // <script>window.SVP_API_BASE_URL = 'https://api.example.com';</script>).
  const API_BASE_URL = window.SVP_API_BASE_URL || '';

  /** Human-readable messages for backend error codes — the UI should never
   * show a raw code or a stack trace to the person using it. */
  const ERROR_MESSAGES = {
    VALIDATION_ERROR: 'Some of the information entered isn\'t valid. Please check and try again.',
    UNAUTHENTICATED: 'Your session has ended. Please log in again.',
    PERMISSION_DENIED: 'Your role doesn\'t have permission to do that.',
    CSRF_PROTECTION_FAILED: 'Your session needs to be refreshed. Please try again.',
    NOT_FOUND: 'That record could not be found.',
    DUPLICATE_SKU: 'That SKU already exists on another product.',
    DUPLICATE_INVOICE_NUMBER: 'That invoice number already exists.',
    DUPLICATE_BATCH: 'That batch number already exists for this product and warehouse.',
    DUPLICATE_MATERIAL_IN_BOM: 'The same material can\'t appear twice in one BOM.',
    INSUFFICIENT_STOCK: 'Not enough stock is available for this quantity.',
    BATCH_EXPIRED: 'This batch has expired and cannot be sold.',
    NO_VALID_BATCH: 'No available (non-expired) stock in this warehouse.',
    PAYMENT_EXCEEDS_BALANCE: 'That amount is more than the outstanding balance.',
    INVALID_PAYMENT_AMOUNT: 'Enter an amount greater than 0.',
    INVOICE_CANCELLED: 'This invoice has already been cancelled.',
    INVOICE_HAS_PAYMENTS: 'This invoice has active payments — reverse them first.',
    PAYMENT_ALREADY_REVERSED: 'This payment has already been reversed.',
    LAST_SUPER_ADMIN_PROTECTED: 'The last active Super Admin cannot be deactivated or demoted.',
    INVALID_CREDENTIALS: 'Incorrect username/email or password.',
    ACCOUNT_DISABLED: 'This account has been disabled.',
    ACCOUNT_LOCKED: 'Too many failed attempts. Try again later.',
    RATE_LIMITED: 'Too many requests. Please wait a few minutes before trying again.',
    INSUFFICIENT_PRODUCTION_MATERIAL: 'Not enough raw material to complete this production order.',
    INTERNAL_ERROR: 'Something went wrong on our end. Please try again.',
    NETWORK_ERROR: 'Unable to connect to the ERP server. Check your connection and retry.',
    TIMEOUT: 'The server took too long to respond. Please retry.'
  };

  function messageFor(code, fallback) {
    return ERROR_MESSAGES[code] || fallback || 'Something went wrong.';
  }

  /**
   * A single ApiError shape used everywhere in the app: { code, message, status, details }.
   * Never a raw stack trace — the backend already sanitizes those, and this
   * layer never forwards anything beyond code/message/details either.
   */
  function ApiError(code, message, status, details) {
    return { isApiError: true, code, message, status: status || 0, details: details || null };
  }

  let csrfToken = null; // in-memory only — never persisted, never in localStorage

  async function ensureCsrfToken() {
    if (csrfToken) return csrfToken;
    const res = await fetch(API_BASE_URL + '/api/v1/auth/csrf-token', { credentials: 'include' });
    const json = await res.json().catch(() => null);
    csrfToken = json && json.data && json.data.csrfToken;
    return csrfToken;
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);

    const needsCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (needsCsrf) await ensureCsrfToken();

    async function doFetch() {
      const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
      if (needsCsrf && csrfToken) headers['x-csrf-token'] = csrfToken;
      return fetch(API_BASE_URL + path, {
        method,
        credentials: 'include', // send the HTTP-only session cookie; never a token in localStorage
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    }

    let res;
    try {
      res = await doFetch();
      // A CSRF token can go stale (session recycled, first request ever,
      // etc.) — refetch once and retry rather than surfacing a confusing
      // error for something transparently recoverable.
      if (res.status === 403 && needsCsrf) {
        const cloned = await res.clone().json().catch(() => null);
        if (cloned && cloned.error && cloned.error.code === 'CSRF_PROTECTION_FAILED') {
          csrfToken = null;
          await ensureCsrfToken();
          res = await doFetch();
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err && err.name === 'AbortError') {
        throw ApiError('TIMEOUT', messageFor('TIMEOUT'), 0);
      }
      throw ApiError('NETWORK_ERROR', messageFor('NETWORK_ERROR'), 0);
    }
    clearTimeout(timeoutId);

    let json = null;
    try { json = await res.json(); } catch (e) { /* empty body, e.g. some 204s */ }

    if (!res.ok) {
      const code = (json && json.error && json.error.code) || ('HTTP_' + res.status);
      const message = messageFor(code, (json && json.error && json.error.message));
      throw ApiError(code, message, res.status, json && json.error && json.error.details);
    }
    return json && json.data !== undefined ? json.data : json;
  }

  window.SVP = window.SVP || {};
  window.SVP.api = {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body === undefined ? {} : body, opts),
    patch: (path, body, opts) => request('PATCH', path, body === undefined ? {} : body, opts),
    delete: (path, opts) => request('DELETE', path, undefined, opts),
    ApiError,
    messageFor,
    isApiError: (e) => !!(e && e.isApiError)
  };
})();
