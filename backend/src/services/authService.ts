import argon2 from 'argon2';
import crypto from 'crypto';
import { query } from '../lib/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/id';
import { emailService } from './emailService';

const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS ?? 15 * 60 * 1000);

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string;
  roleId: string;
  roleCode: string;
  roleLabel: string;
  status: 'ACTIVE' | 'DISABLED';
}

export async function hashPassword(plain: string): Promise<string> {
  // argon2id: the currently recommended variant (resistant to both GPU and
  // side-channel attacks) — never bcrypt-only, never a fast hash, never
  // plaintext, and this hash never leaves the server.
  return argon2.hash(plain, { type: argon2.argon2id });
}

async function recordAuditEntry(userId: string | null, action: string, detail: string, roleLabel?: string) {
  await query(
    `INSERT INTO audit_logs (id, "userId", "roleLabel", action, entity, "newValue", "createdAt")
     VALUES ($1, $2, $3, $4, 'auth', $5, now())`,
    [newId('au'), userId, roleLabel ?? null, action, JSON.stringify({ detail })]
  );
}

export async function login(
  usernameOrEmail: string,
  plainPassword: string,
  sessionMeta?: string
): Promise<AuthUser> {
  const { rows } = await query<{
    id: string; name: string; email: string; username: string; passwordhash: string;
    status: 'ACTIVE' | 'DISABLED'; failedlogincount: number; lockeduntil: string | null;
    roleid: string; rolecode: string; rolelabel: string;
  }>(
    `SELECT u.id, u.name, u.email, u.username, u."passwordHash" AS passwordhash, u.status,
            u."failedLoginCount" AS failedlogincount, u."lockedUntil" AS lockeduntil,
            r.id AS roleid, r.code AS rolecode, r.label AS rolelabel
     FROM users u JOIN roles r ON r.id = u."roleId"
     WHERE lower(u.email) = lower($1) OR lower(u.username) = lower($1)`,
    [usernameOrEmail]
  );
  const row = rows[0];

  if (!row) {
    await recordAuditEntry(null, 'Failed login', `No such user: ${usernameOrEmail}`);
    throw new AppError('INVALID_CREDENTIALS', 'Invalid username/email or password.', 401);
  }

  if (row.lockeduntil && new Date(row.lockeduntil).getTime() > Date.now()) {
    await recordAuditEntry(row.id, 'Failed login', 'Account temporarily locked', row.rolelabel);
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', 423);
  }

  if (row.status !== 'ACTIVE') {
    await recordAuditEntry(row.id, 'Failed login', 'Account disabled', row.rolelabel);
    throw new AppError('ACCOUNT_DISABLED', 'This account has been disabled.', 403);
  }

  const valid = await argon2.verify(row.passwordhash, plainPassword).catch(() => false);
  if (!valid) {
    const attempts = row.failedlogincount + 1;
    const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null;
    await query(`UPDATE users SET "failedLoginCount" = $1, "lockedUntil" = $2 WHERE id = $3`, [
      lockedUntil ? 0 : attempts,
      lockedUntil,
      row.id
    ]);
    await recordAuditEntry(row.id, 'Failed login', `Wrong password (attempt ${attempts})`, row.rolelabel);
    if (lockedUntil) throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Account locked temporarily.', 423);
    throw new AppError('INVALID_CREDENTIALS', 'Invalid username/email or password.', 401);
  }

  await query(`UPDATE users SET "failedLoginCount" = 0, "lockedUntil" = NULL, "lastLoginAt" = now() WHERE id = $1`, [row.id]);
  await recordAuditEntry(row.id, 'Login', sessionMeta ?? 'Signed in', row.rolelabel);

  return {
    id: row.id, name: row.name, email: row.email, username: row.username,
    roleId: row.roleid, roleCode: row.rolecode, roleLabel: row.rolelabel, status: row.status
  };
}

export async function logout(userId: string): Promise<void> {
  const { rows } = await query<{ name: string; rolelabel: string }>(
    `SELECT u.name, r.label AS rolelabel FROM users u JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`,
    [userId]
  );
  await recordAuditEntry(userId, 'Logout', '', rows[0]?.rolelabel);
}

/** Business rule (independent of the generic permission map): the last active
 * SUPER_ADMIN can never be deactivated, demoted, or deleted. */
export async function assertNotDemotingLastSuperAdmin(userId: string, newRoleCode: string, newStatus: string): Promise<void> {
  const { rows } = await query<{ rolecode: string; status: string }>(
    `SELECT r.code AS rolecode, u.status FROM users u JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`,
    [userId]
  );
  const current = rows[0];
  if (!current || current.rolecode !== 'SUPER_ADMIN') return;

  const demoting = newRoleCode !== 'SUPER_ADMIN' || newStatus !== 'ACTIVE';
  if (!demoting) return;

  const { rows: activeCount } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM users u JOIN roles r ON r.id = u."roleId"
     WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE'`
  );
  if (Number(activeCount[0]?.count ?? 0) <= 1) {
    throw new AppError('LAST_SUPER_ADMIN_PROTECTED', 'Cannot deactivate or demote the last active Super Admin.', 409);
  }
}

export async function getPermissionsForRole(roleId: string): Promise<Set<string>> {
  const { rows } = await query<{ code: string }>(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp."permissionId" WHERE rp."roleId" = $1`,
    [roleId]
  );
  return new Set(rows.map((r) => r.code));
}

// =============================================================================
// Password reset
// =============================================================================
const RESET_TOKEN_VALIDITY_MS = 20 * 60 * 1000; // 20 minutes — within the requested 15-30 min window

function hashResetToken(rawToken: string): string {
  // A fast hash (not argon2) is correct here: the raw token is already
  // high-entropy (32 random bytes from crypto.randomBytes), so there is no
  // brute-force risk to slow down — unlike a user-chosen password. What
  // matters is that the raw token is never persisted, only this hash.
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Always resolves the same way regardless of whether the user exists —
 * callers must not be able to distinguish "no such user" from "reset email
 * sent" (Requirement 7 / user-enumeration protection). The actual token is
 * only ever handed to the email adapter, never returned to the caller.
 */
export async function requestPasswordReset(usernameOrEmail: string, appUrl: string): Promise<void> {
  const { rows } = await query<{ id: string; name: string; email: string; status: string; rolelabel: string }>(
    `SELECT u.id, u.name, u.email, u.status, r.label AS rolelabel
     FROM users u JOIN roles r ON r.id = u."roleId"
     WHERE lower(u.email) = lower($1) OR lower(u.username) = lower($1)`,
    [usernameOrEmail]
  );
  const user = rows[0];

  // Always audit the *attempt* against whatever identifier was given, even
  // if no such user exists — but never reveal that distinction to the caller.
  await query(
    `INSERT INTO audit_logs (id, "userId", "roleLabel", action, entity, "newValue", "createdAt") VALUES ($1,$2,$3,'PASSWORD_RESET_REQUESTED','auth',$4,now())`,
    [newId('au'), user?.id ?? null, user?.rolelabel ?? null, JSON.stringify({ identifier: usernameOrEmail, userFound: !!user })]
  );

  if (!user || user.status !== 'ACTIVE') return; // silently no-op — same external behavior as success

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_VALIDITY_MS);
  await query(
    `INSERT INTO password_reset_tokens (id, "userId", "tokenHash", "expiresAt") VALUES ($1,$2,$3,$4)`,
    [newId('prt'), user.id, tokenHash, expiresAt]
  );

  const resetUrl = `${appUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
  await emailService.sendPasswordReset(user.email, resetUrl, user.name);
  // The raw token/URL is handed only to emailService above — never logged,
  // never returned from this function, never included in the audit entry.
}

export async function confirmPasswordReset(rawToken: string, newPassword: string): Promise<void> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new AppError('INVALID_RESET_TOKEN', 'This reset link is invalid.', 400);
  }
  if (!newPassword || newPassword.length < 8) {
    throw new AppError('WEAK_PASSWORD', 'New password must be at least 8 characters.', 400);
  }

  const tokenHash = hashResetToken(rawToken);
  const { rows } = await query<{ id: string; userid: string; expiresat: string; usedat: string | null }>(
    `SELECT id, "userId" AS userid, "expiresAt"::text AS expiresat, "usedAt"::text AS usedat FROM password_reset_tokens WHERE "tokenHash" = $1`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record) throw new AppError('INVALID_RESET_TOKEN', 'This reset link is invalid.', 400);
  if (record.usedat) throw new AppError('RESET_TOKEN_ALREADY_USED', 'This reset link has already been used.', 400);
  if (new Date(record.expiresat).getTime() < Date.now()) throw new AppError('RESET_TOKEN_EXPIRED', 'This reset link has expired. Request a new one.', 400);

  const { rows: userRows } = await query<{ name: string; rolelabel: string }>(
    `SELECT u.name, r.label AS rolelabel FROM users u JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`,
    [record.userid]
  );

  const newHash = await hashPassword(newPassword);
  await query(`UPDATE users SET "passwordHash" = $1, "failedLoginCount" = 0, "lockedUntil" = NULL WHERE id = $2`, [newHash, record.userid]);
  // Single-use: mark this token consumed immediately, in the same logical
  // step as the password change (Requirement 5/8 — invalid immediately after use).
  await query(`UPDATE password_reset_tokens SET "usedAt" = now() WHERE id = $1`, [record.id]);
  // Requirement 6: invalidate every existing session for this user — a reset
  // password must not leave old sessions (e.g. on a stolen device) still valid.
  await query(`DELETE FROM sessions WHERE data->>'userId' = $1`, [record.userid]);

  await query(
    `INSERT INTO audit_logs (id, "userId", "roleLabel", action, entity, "newValue", "createdAt") VALUES ($1,$2,$3,'PASSWORD_RESET_COMPLETED','auth',$4,now())`,
    [newId('au'), record.userid, userRows[0]?.rolelabel ?? null, JSON.stringify({ sessionsInvalidated: true })]
  );
}
