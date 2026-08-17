import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AppError } from './lib/errors';
import { csrfProtection, generateCsrfToken } from './lib/csrf';
import { PgSessionStore, startSessionSweeper } from './lib/sessionStore';
import { closePool } from './lib/db';

import authRoutes from './routes/auth';
import customerRoutes from './routes/customers';
import supplierRoutes from './routes/suppliers';
import productRoutes from './routes/products';
import warehouseRoutes from './routes/warehouses';
import batchRoutes from './routes/batches';
import invoiceRoutes from './routes/invoices';
import paymentRoutes from './routes/payments';
import returnRoutes from './routes/returns';
import purchaseRoutes from './routes/purchases';
import manufacturingRoutes from './routes/manufacturing';
import expenseRoutes from './routes/expenses';
import reportRoutes from './routes/reports';
import auditRoutes from './routes/audit';
import userRoutes from './routes/users';

export function buildServer() {
  const app = Fastify({
    logger: {
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
      // Redact anything that could leak credentials into logs.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'body.password', 'body.currentPassword', 'body.newPassword']
    }
  });

  app.register(helmet, { contentSecurityPolicy: process.env.NODE_ENV === 'production' });
  app.register(cors, { origin: process.env.CORS_ORIGIN ?? true, credentials: true });
  // Tiered rate limiting (Phase 7): a single flat global limit either lets
  // brute-force login attempts through or throttles legitimate rapid ERP
  // usage (both observed as real problems in testing). This uses
  // @fastify/rate-limit's dynamic `max` (a function, not a fixed number) so
  // the effective limit depends on what's actually being hit, without
  // needing a per-route override on every single route file:
  //   - health check / CSRF token fetch: generous (polled often, harmless)
  //   - login: strict (brute-force target; account lockout is a second layer)
  //   - authenticated reads (GET): higher allowance (normal browsing/reports)
  //   - authenticated writes (POST/PUT/PATCH/DELETE): moderate
  // Login and password-reset routes additionally set their own even-stricter
  // per-route override below, which takes precedence over this global policy.
  app.register(rateLimit, {
    timeWindow: '1 minute',
    max: (req: any) => {
      if (req.url === '/health' || req.url === '/api/v1/auth/csrf-token') return 300;
      if (req.url === '/api/v1/auth/login') return 10;
      if (req.method === 'GET') return 200;
      return 60; // authenticated writes
    }
  });

  app.register(cookie);
  app.register(session, {
    secret: process.env.SESSION_SECRET!,
    cookieName: process.env.SESSION_COOKIE_NAME ?? 'svp_sid',
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: Number(process.env.SESSION_MAX_AGE_MS ?? 28_800_000)
    },
    store: new PgSessionStore() as any
  });

  // Consistent error contract for the whole API — never leak stack traces.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      req.log.warn({ code: err.code }, err.message);
      return reply.status(err.statusCode).send(err.toJSON());
    }
    if ((err as any).issues) {
      // zod validation error
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: (err as any).issues } });
    }
    // @fastify/rate-limit throws a plain Error with .statusCode = 429 (and
    // sets its own Retry-After header already) — map it to the same stable
    // contract as every other error instead of falling through to a generic
    // 500 (a real bug found during password-reset rate-limit testing: this
    // branch didn't exist before, so throttled requests looked like server
    // crashes rather than a deliberate, expected rate limit).
    if ((err as any).statusCode === 429) {
      req.log.warn({ code: 'RATE_LIMITED' }, err.message);
      return reply.status(429).send({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait before trying again.' } });
    }
    req.log.error(err);
    const isProd = process.env.NODE_ENV === 'production';
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: isProd ? 'Something went wrong.' : err.message }
    });
  });

  app.get('/health', async () => ({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));

  // Any client (even not-yet-logged-in) fetches a token here before making
  // its first state-changing request. Safe methods never need this.
  app.get('/api/v1/auth/csrf-token', async (req, reply) => {
    const token = generateCsrfToken(req);
    return reply.send({ success: true, data: { csrfToken: token } });
  });
  app.addHook('onRequest', async (req, reply) => { await csrfProtection(req, reply); });

  app.register(authRoutes);
  app.register(customerRoutes);
  app.register(supplierRoutes);
  app.register(productRoutes);
  app.register(warehouseRoutes);
  app.register(batchRoutes);
  app.register(invoiceRoutes);
  app.register(paymentRoutes);
  app.register(returnRoutes);
  app.register(purchaseRoutes);
  app.register(manufacturingRoutes);
  app.register(expenseRoutes);
  app.register(reportRoutes);
  app.register(auditRoutes);
  app.register(userRoutes);

  return app;
}

async function main() {
  const app = buildServer();
  const sweeper = startSessionSweeper();
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';

  const shutdown = async () => {
    clearInterval(sweeper);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port, host });
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start server', err);
    process.exit(1);
  });
}
