import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/rbac';
import { query } from '../lib/db';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import { hashPassword, assertNotDemotingLastSuperAdmin } from '../services/authService';

const ROLE_CODES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'BILLING_STAFF', 'INVENTORY_STAFF', 'SALES_STAFF'] as const;

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  username: z.string().min(3),
  phone: z.string().optional(),
  role: z.enum(ROLE_CODES),
  password: z.string().min(8)
});

const updateUserSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  role: z.enum(ROLE_CODES).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  password: z.string().min(8).optional()
});

export default async function userRoutes(app: FastifyInstance) {
  app.get('/api/v1/users', { preHandler: [requireAuth, requirePermission('users.manage')] }, async (_req, reply) => {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.username, u.phone, u.status, u."createdAt", u."lastLoginAt", r.code AS role, r.label AS "roleLabel"
       FROM users u JOIN roles r ON r.id = u."roleId" ORDER BY u.name`
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/api/v1/users', { preHandler: [requireAuth, requirePermission('users.manage')] }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const { rows: dupe } = await query(`SELECT id FROM users WHERE email = $1 OR username = $2`, [body.email, body.username]);
    if (dupe[0]) throw new AppError('VALIDATION_ERROR', 'A user with that email or username already exists.', 409);
    const { rows: roleRows } = await query<{ id: string }>(`SELECT id FROM roles WHERE code = $1`, [body.role]);
    if (!roleRows[0]) throw new AppError('VALIDATION_ERROR', 'Unknown role.', 400);

    const passwordHash = await hashPassword(body.password);
    const id = newId('user');
    await query(
      `INSERT INTO users (id, name, email, username, phone, "passwordHash", "roleId", status, "createdById")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8)`,
      [id, body.name, body.email, body.username, body.phone ?? null, passwordHash, roleRows[0].id, req.session.userId]
    );
    await query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'User created','user',$3,$4)`,
      [newId('au'), req.session.userId, id, JSON.stringify({ name: body.name, role: body.role })]);
    return reply.status(201).send({ success: true, data: { id } });
  });

  app.patch('/api/v1/users/:id', { preHandler: [requireAuth, requirePermission('users.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateUserSchema.parse(req.body);

    const { rows: existing } = await query<{ rolecode: string; status: string }>(
      `SELECT r.code AS rolecode, u.status FROM users u JOIN roles r ON r.id = u."roleId" WHERE u.id = $1`, [id]
    );
    if (!existing[0]) throw new AppError('NOT_FOUND', 'User not found.', 404);

    const newRoleCode = body.role ?? existing[0].rolecode;
    const newStatus = body.status ?? existing[0].status;
    // Backend business rule, independent of the generic permission map:
    await assertNotDemotingLastSuperAdmin(id, newRoleCode, newStatus);

    const updates: string[] = [];
    const params: any[] = [id];
    if (body.name !== undefined) { params.push(body.name); updates.push(`name = $${params.length}`); }
    if (body.phone !== undefined) { params.push(body.phone); updates.push(`phone = $${params.length}`); }
    if (body.status !== undefined) { params.push(body.status); updates.push(`status = $${params.length}`); }
    if (body.role !== undefined) {
      const { rows: roleRows } = await query<{ id: string }>(`SELECT id FROM roles WHERE code = $1`, [body.role]);
      if (!roleRows[0]) throw new AppError('VALIDATION_ERROR', 'Unknown role.', 400);
      params.push(roleRows[0].id); updates.push(`"roleId" = $${params.length}`);
    }
    if (body.password !== undefined) {
      const hash = await hashPassword(body.password);
      params.push(hash); updates.push(`"passwordHash" = $${params.length}`);
    }
    if (updates.length > 0) {
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $1`, params);
    }
    await query(`INSERT INTO audit_logs (id, "userId", action, entity, "entityId", "newValue") VALUES ($1,$2,'User edited','user',$3,$4)`,
      [newId('au'), req.session.userId, id, JSON.stringify({ ...body, password: body.password ? '(reset)' : undefined })]);
    return reply.send({ success: true, data: { id } });
  });
}
