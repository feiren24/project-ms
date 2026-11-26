import { isProjectManager } from '../../../../shared/src/permissions.js';
import { requestCanViewManagement, publicPlanHistory } from '../auth/project-access.js';
import { savePlanOrder } from './order.js';
import { readActors, readMembers } from '../settings/store.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BaselinePublishRequest, PlanEditRequest, PlanOrderRequest } from '../../../../shared/src/planning.js';
import { PlanError } from './errors.js';
import { applySchedule, initializePlanning, previewSchedule, publishBaseline, readPlan } from './repository.js';

export function registerPlanningRoutes(app: FastifyInstance, database: Database.Database, clock: () => Date, authenticatedWrite?: (request: FastifyRequest) => Promise<void>, authenticatedActorName?: (request: FastifyRequest) => string, trustedOrigins?: string[], authenticatedAccountId?: (request: FastifyRequest) => string) {
  initializePlanning(database);
  const token = randomBytes(32).toString('hex');
  const allowedOrigins = new Set(trustedOrigins ?? ['http://127.0.0.1:5174', 'http://localhost:5174', 'http://127.0.0.1:3100', 'http://localhost:3100']);
  const protectWrite = async (request: FastifyRequest) => {
    if (authenticatedWrite) return authenticatedWrite(request);
    const received = request.headers['x-preview-token'];
    if (typeof received !== 'string' || Buffer.byteLength(received) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(received), Buffer.from(token))) {
      throw new PlanError(403, 'PREVIEW_TOKEN_REQUIRED', '服务可能已重启，当前请求未执行。请先保留填写内容，再刷新计划、重新预览后重试。');
    }
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new PlanError(403, 'ORIGIN_FORBIDDEN', '仅允许受信任的本机页面提交计划修改。');
  };
  const canEditSchedule = (request: FastifyRequest, projectId: string) => {
    const actorId = request.headers['x-demo-actor'];
    const accountId = authenticatedAccountId?.(request);
    return typeof actorId === 'string' && readMembers(database, projectId).some(member =>
      member.id === actorId && (!authenticatedWrite || (accountId !== undefined && member.userId === accountId)) && member.active && !member.removedAt && member.accountActive !== false && isProjectManager(member.role));
  };
  const protectSchedule = async (request: FastifyRequest) => {
    await protectWrite(request);
    // Only explicit legacy token-only fixtures may omit an actor. Auth replaces
    // the header with the session's actual member ID before this handler runs.
    if ((authenticatedWrite || request.headers['x-demo-actor'] !== undefined)
      && !canEditSchedule(request, (request.params as { projectId: string }).projectId)) {
      throw new PlanError(403, 'MANAGER_REQUIRED', '仅当前项目的有效负责人或项目管理员可以调整日期与依赖。');
    }
  };
  const actorName = (request: FastifyRequest, projectId: string) => authenticatedActorName?.(request) ?? readActors(database,projectId).find(actor => actor.id === request.headers['x-demo-actor'])?.name ?? '项目操作者';
  const prefix = '/api/v1/projects/:projectId';
  app.get<{ Params: { projectId: string } }>(`${prefix}/gantt`, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const plan = readPlan(database, request.params.projectId, token, clock());
    return { data: { ...plan, history: requestCanViewManagement(request) ? plan.history : plan.history.filter(publicPlanHistory), canEditSchedule: canEditSchedule(request, request.params.projectId) } };
  });
  app.get<{ Params: { projectId: string; historyId: string } }>(`${prefix}/plan/history/:historyId`, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const row = database.prepare('SELECT snapshot_json FROM plan_history WHERE project_id=? AND id=?').get(request.params.projectId, request.params.historyId) as { snapshot_json: string } | undefined;
    if (!row) throw new PlanError(404, 'PLAN_HISTORY_NOT_FOUND', '该计划变更记录已不可用，历史动态仍保留。');
    const history = JSON.parse(row.snapshot_json);
    if (!requestCanViewManagement(request) && !publicPlanHistory(history)) throw new PlanError(404, 'PLAN_HISTORY_NOT_FOUND', '该计划变更记录已不可用。');
    return { data: history };
  });
  app.post<{ Params: { projectId: string }; Body: PlanEditRequest }>(`${prefix}/schedule/preview`, { preHandler: protectSchedule, bodyLimit: 128 * 1024 }, (request) => ({ data: previewSchedule(database, request.params.projectId, request.body, clock()) }));
  app.post<{ Params: { projectId: string }; Body: { previewId: string; expectedPlanVersion: number } }>(`${prefix}/schedule/apply`, { preHandler: protectSchedule, bodyLimit: 4096 }, (request) => ({ data: applySchedule(database, request.params.projectId, request.body, typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined, clock(), actorName(request, request.params.projectId), typeof request.headers['x-demo-actor'] === 'string' ? request.headers['x-demo-actor'] : null) }));
  app.post<{ Params: { projectId: string }; Body: BaselinePublishRequest }>(`${prefix}/baselines`, { preHandler: protectWrite, bodyLimit: 16 * 1024 }, (request) => ({ data: publishBaseline(database, request.params.projectId, request.body, clock(), actorName(request, request.params.projectId), typeof request.headers['x-demo-actor'] === 'string' ? request.headers['x-demo-actor'] : null) }));
  app.post<{ Params: { projectId: string }; Body: PlanOrderRequest }>(`${prefix}/plan/order`, { preHandler: protectWrite, bodyLimit: 1024 * 1024 }, request => ({ data: savePlanOrder(database, request.params.projectId, request.body, request.headers['idempotency-key'], request.headers['x-demo-actor'], clock(), actorName(request,request.params.projectId)) }));
  return { token, protectWrite };
}
