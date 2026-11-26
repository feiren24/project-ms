import { requestCanViewManagement } from '../auth/project-access.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readNotifications, readProjectRevision, writeNotifications } from './repository.js';
export function registerNotificationRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, protection: { token: string; protectWrite: (request: FastifyRequest) => Promise<void> }) {
  const prefix = '/api/v1/projects/:projectId';
  app.get<{ Params: { projectId: string }; Querystring: { actorId?: string } }>(`${prefix}/notifications`, (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readNotifications(db, request.params.projectId, request.query.actorId, protection.token, requestCanViewManagement(request)) }; });
  app.get<{ Params: { projectId: string }; Querystring: { actorId?: string } }>(`${prefix}/revision`, (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readProjectRevision(db, request.params.projectId, request.query.actorId, requestCanViewManagement(request)) }; });
  app.post<{ Params: { projectId: string }; Body: unknown }>(`${prefix}/notifications/read`, { preHandler: protection.protectWrite, bodyLimit: 128 * 1024 }, request => ({ data: writeNotifications(db, request.params.projectId, 'read', undefined, request.body, request.headers['x-demo-actor'], request.headers['idempotency-key'], clock(), protection.token, requestCanViewManagement(request)) }));
  app.post<{ Params: { projectId: string; jobId: string }; Body: unknown }>(`${prefix}/notifications/jobs/:jobId/retry`, { preHandler: protection.protectWrite }, request => ({ data: writeNotifications(db, request.params.projectId, 'retry', request.params.jobId, request.body, request.headers['x-demo-actor'], request.headers['idempotency-key'], clock(), protection.token, requestCanViewManagement(request)) }));
}
