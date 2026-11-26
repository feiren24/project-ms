import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PlanError } from '../planning/errors.js';
import { readSession } from '../auth/store.js';
import { addMembership, createProject, initializeProjects, readMemberships, readProject, readProjectDirectory, updateProject, previewMembershipRemoval, removeMembership } from './repository.js';

export function registerProjectRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, protectWrite: (request: FastifyRequest) => Promise<void>) {
  initializeProjects(db);
  const user = (request: FastifyRequest) => {
    const session = readSession(db, request, clock());
    if (!session || session.user.mustChangePassword) throw new PlanError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。填写中的内容会保留。');
    return session.user;
  };
  app.get('/api/v1/projects', (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readProjectDirectory(db, user(request)) }; });
  app.post('/api/v1/projects', { preHandler: protectWrite, bodyLimit: 16 * 1024 }, request => ({ data: createProject(db, user(request), request.body, request.headers['idempotency-key'], clock()) }));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readProject(db, user(request), request.params.projectId) }; });
  app.patch<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', { preHandler: protectWrite, bodyLimit: 16 * 1024 }, request => ({ data: updateProject(db, user(request), request.params.projectId, request.body, request.headers['idempotency-key'], clock()) }));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/memberships', (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readMemberships(db, user(request), request.params.projectId) }; });
  app.get<{ Params: { projectId: string; memberId: string } }>('/api/v1/projects/:projectId/memberships/:memberId/removal-preview', (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: previewMembershipRemoval(db, user(request), request.params.projectId, request.params.memberId) }; });
  app.post<{ Params: { projectId: string; memberId: string } }>('/api/v1/projects/:projectId/memberships/:memberId/remove', { preHandler: protectWrite, bodyLimit: 4096 }, request => ({ data: removeMembership(db, user(request), request.params.projectId, request.params.memberId, request.body, request.headers['idempotency-key'], clock()) }));
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/memberships', { preHandler: protectWrite, bodyLimit: 4096 }, request => ({ data: addMembership(db, user(request), request.params.projectId, request.body, request.headers['idempotency-key'], clock()) }));
}
