import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { initializeWorkstreams, readWorkstreams, writeWorkstream } from './repository.js';

export function registerWorkstreamRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, protection: { token: string; protectWrite: (request: FastifyRequest) => Promise<void> }, actorContext?: (request: FastifyRequest) => { name: string; systemAdmin: boolean; accountId: string }) {
  initializeWorkstreams(db);
  const prefix = '/api/v1/projects/:projectId/workstreams';
  const context = (request: FastifyRequest) => actorContext?.(request) ?? { name: String(request.headers['x-demo-actor'] ?? '项目操作者'), systemAdmin: false, accountId: undefined };
  app.get<{ Params: { projectId: string } }>(prefix, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = context(request);
    return { data: readWorkstreams(db, request.params.projectId, protection.token, request.headers['x-demo-actor'], actor.systemAdmin) };
  });
  for (const route of [
    { method: 'POST', path: '', operation: 'create' },
    { method: 'PATCH', path: '/:workstreamId', operation: 'update' },
    { method: 'POST', path: '/:workstreamId/status', operation: 'status' },
    { method: 'POST', path: '/:workstreamId/move', operation: 'move' },
  ] as const) app.route<{ Params: { projectId: string; workstreamId?: string }; Body: unknown }>({ method: route.method, url: `${prefix}${route.path}`, preHandler: protection.protectWrite, bodyLimit: 16 * 1024, handler: request => {
    const actor = context(request);
    return { data: writeWorkstream(db, request.params.projectId, route.operation, request.params.workstreamId, request.body, request.headers['x-demo-actor'], request.headers['idempotency-key'], clock(), protection.token, actor.systemAdmin, actor.name, actor.accountId) };
  }});
}
