import Tokens from '@fastify/csrf';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './errors';

// 30-minute token validity — long enough for normal ERP usage between page
// loads, short enough that a leaked token doesn't stay useful indefinitely.
const tokens = new Tokens({ validity: 30 * 60 * 1000 });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface Session {
    csrfSecret?: string;
  }
}

function getOrCreateSecret(req: FastifyRequest): string {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = tokens.secretSync();
  }
  return req.session.csrfSecret;
}

/** GET /api/v1/auth/csrf-token calls this — works even for an anonymous
 * (not-yet-logged-in) visitor, since the session itself (and therefore the
 * CSRF secret) exists before authentication. */
export function generateCsrfToken(req: FastifyRequest): string {
  const secret = getOrCreateSecret(req);
  return tokens.create(secret);
}

/**
 * Applied globally to every request. Safe methods (GET/HEAD/OPTIONS) are
 * exempt by spec — they must never mutate state, so there's nothing to
 * protect. Everything else (including login) must carry a valid token tied
 * to the current session, checked via the `x-csrf-token` header.
 *
 * A secondary defense — Origin header validation — runs alongside: if the
 * browser sends an Origin that doesn't match the configured CORS_ORIGIN, the
 * request is rejected even before the token is checked. This is a soft check
 * (only enforced when the header is actually present) so non-browser API
 * clients that don't send Origin aren't broken.
 */
export async function csrfProtection(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return;

  const allowedOrigin = process.env.CORS_ORIGIN;
  const origin = req.headers.origin;
  if (origin && allowedOrigin && allowedOrigin !== '*' && origin !== allowedOrigin) {
    throw new AppError('CSRF_PROTECTION_FAILED', 'Request origin does not match the expected application origin.', 403);
  }

  const secret = req.session.csrfSecret;
  if (!secret) {
    throw new AppError('CSRF_PROTECTION_FAILED', 'Missing CSRF token. Fetch a token from /api/v1/auth/csrf-token first.', 403);
  }
  const token = (req.headers['x-csrf-token'] as string | undefined) || (req.body as any)?._csrf;
  if (!token || !tokens.verify(secret, token)) {
    throw new AppError('CSRF_PROTECTION_FAILED', 'Invalid or expired CSRF token.', 403);
  }
}
