import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { login, logout, hashPassword, getPermissionsForRole, requestPasswordReset, confirmPasswordReset } from '../services/authService';
import { emailService } from '../services/emailService';
import { query } from '../lib/db';
import { AppError } from '../lib/errors';
import { requireAuth } from '../middleware/rbac';

const loginSchema = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.')
});

const requestResetSchema = z.object({ usernameOrEmail: z.string().min(1) });
const confirmResetSchema = z.object({ token: z.string().min(1), newPassword: z.string().min(8, 'New password must be at least 8 characters.') });

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await login(body.usernameOrEmail, body.password, req.headers['user-agent'] as string | undefined);

    req.session.userId = user.id;
    req.session.roleId = user.roleId;
    req.session.roleCode = user.roleCode;
    req.session.lastSeenAt = Date.now();

    const perms = await getPermissionsForRole(user.roleId);
    return reply.send({
      success: true,
      data: { id: user.id, name: user.name, email: user.email, username: user.username, role: user.roleCode, roleLabel: user.roleLabel, permissions: [...perms] }
    });
  });

  app.post('/api/v1/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await logout(req.session.userId!);
    await req.session.destroy();
    return reply.send({ success: true, data: { loggedOut: true } });
  });

  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query<{ id: string; name: string; email: string; username: string; rolecode: string; rolelabel: string }>(
      `SELECT u.id, u.name, u.email, u.username, r.code AS rolecode, r.label AS rolelabel
       FROM users u JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`,
      [req.session.userId]
    );
    const user = rows[0];
    if (!user) throw new AppError('NOT_FOUND', 'User not found.', 404);
    const perms = await getPermissionsForRole(req.session.roleId!);
    return reply.send({ success: true, data: { ...user, role: user.rolecode, permissions: [...perms] } });
  });

  app.post('/api/v1/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = changePasswordSchema.parse(req.body);
    const { rows } = await query<{ passwordhash: string }>(`SELECT "passwordHash" AS passwordhash FROM users WHERE id = $1`, [req.session.userId]);
    const valid = await argon2.verify(rows[0]!.passwordhash, body.currentPassword).catch(() => false);
    if (!valid) throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect.', 401);
    const newHash = await hashPassword(body.newPassword);
    await query(`UPDATE users SET "passwordHash" = $1 WHERE id = $2`, [newHash, req.session.userId]);
    return reply.send({ success: true, data: { changed: true } });
  });

  // Password reset request/confirm are deliberately unauthenticated (a user
  // who forgot their password has no session) but strictly rate-limited —
  // see the per-route config below and Phase 7's tiered rate limiter.
  app.post('/api/v1/auth/password-reset/request', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } }
  }, async (req, reply) => {
    const body = requestResetSchema.parse(req.body);
    const appUrl = process.env.APP_URL || 'http://localhost:5173';
    await requestPasswordReset(body.usernameOrEmail, appUrl);
    // Always the same response, regardless of whether the account exists —
    // this is the user-enumeration protection, not an accident.
    return reply.send({ success: true, data: { message: 'If an account exists for that username or email, a reset link has been sent.' } });
  });

  app.post('/api/v1/auth/password-reset/confirm', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }
  }, async (req, reply) => {
    const body = confirmResetSchema.parse(req.body);
    await confirmPasswordReset(body.token, body.newPassword);
    return reply.send({ success: true, data: { reset: true } });
  });

  // Test-only hook: exposes the most recent reset token for a given email,
  // captured in-memory by the DEV email adapter (never read from the
  // database — the DB only ever stores the token's hash, by design). This
  // route only exists so automated tests can complete a full reset lifecycle
  // without a real SMTP server; it is hard-gated off whenever
  // NODE_ENV === 'production', and even then only works if the dev adapter
  // (no SMTP configured) is the active adapter.
  if (process.env.NODE_ENV !== 'production') {
    app.get('/api/v1/auth/_test-only/last-reset-token', async (req, reply) => {
      const { email } = req.query as { email?: string };
      const sent = emailService._devAdapterForTests.sentEmails.filter((e) => e.to === email);
      const last = sent[sent.length - 1];
      if (!last) return reply.send({ success: true, data: { token: null } });
      const url = new URL(last.resetUrl);
      const token = url.searchParams.get('token');
      return reply.send({ success: true, data: { token } });
    });
  }
}
