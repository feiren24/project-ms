import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SettingsOperation } from '../../../../shared/src/settings.js';
import { PlanError } from '../planning/errors.js';
import { readSession } from '../auth/store.js';
import { initializeSettings } from './store.js';
import { readSettings, writeSettings } from './repository.js';
export function registerSettingsRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, protection: { token: string; protectWrite: (request: FastifyRequest) => Promise<void> }, allowLegacyMemberCreate = true, actorContext?: (request: FastifyRequest) => { name: string; systemAdmin: boolean }) {
  initializeSettings(db);
  const prefix = '/api/v1/projects/:projectId/settings';
  app.get<{ Params: { projectId: string } }>(prefix, (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readSettings(db, request.params.projectId, protection.token) }; });
  app.post<{ Params: { projectId: string; operation: SettingsOperation }; Body: unknown }>(`${prefix}/:operation`, { preHandler: protection.protectWrite, bodyLimit: 128 * 1024 }, request => {
    if (!allowLegacyMemberCreate && request.params.operation === 'member_create') throw new PlanError(422, 'ACCOUNT_LINK_REQUIRED', '真实登录模式请从已有启用账号添加项目成员。');
    const session = actorContext?.(request) ?? (allowLegacyMemberCreate ? undefined : (() => { const value = readSession(db, request, clock()); return value ? { name: value.user.name, systemAdmin: value.user.systemRole === 'admin' } : undefined; })());
    const data = writeSettings(db, request.params.projectId, request.params.operation, request.body, request.headers['x-demo-actor'], request.headers['idempotency-key'], clock(), session?.systemAdmin, session?.name);
    data.writeToken = protection.token; return { data };
  });
}
