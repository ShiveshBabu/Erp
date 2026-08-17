import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../lib/errors';
import { getPermissionsForRole } from '../services/authService';

declare module 'fastify' {
  interface Session {
    userId?: string;
    roleId?: string;
    roleCode?: string;
    lastSeenAt?: number;
  }
}

const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000);

/** Attach to every route that requires a logged-in user. Also enforces idle
 * timeout independent of the cookie's own expiry. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const session = req.session;
  if (!session?.userId) {
    throw new AppError('UNAUTHENTICATED', 'You must be logged in.', 401);
  }
  const lastSeen = session.lastSeenAt ?? 0;
  if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
    session.userId = undefined;
    throw new AppError('UNAUTHENTICATED', 'Session expired due to inactivity. Please log in again.', 401);
  }
  session.lastSeenAt = Date.now();
}

/**
 * Server-side permission check — this is the actual enforcement point.
 * The frontend may hide buttons for UX, but that is decorative only:
 * calling the API directly without the right permission is rejected here,
 * regardless of what the client claims about its own role.
 */
export function requirePermission(permissionCode: string) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const session = req.session;
    if (!session?.userId || !session.roleId) {
      throw new AppError('UNAUTHENTICATED', 'You must be logged in.', 401);
    }
    const perms = await getPermissionsForRole(session.roleId);
    if (!perms.has('*') && !perms.has(permissionCode)) {
      throw new AppError('PERMISSION_DENIED', `Your role does not have permission to perform this action (${permissionCode}).`, 403);
    }
  };
}
