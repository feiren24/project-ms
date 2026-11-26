import { isExistingDatabase } from '../../db/lifecycle.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { initializeRisks, readRisks } from './repository.js';
import { PlanError } from '../planning/errors.js';
import { evaluateProjectRisks, recordEvaluationFailure, writeRisk } from './service.js';

export function registerRiskRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, protection: { token: string; protectWrite: (request: FastifyRequest) => Promise<void> }, intervalMs = 15 * 60_000, authenticatedActorName?: (request: FastifyRequest) => string, eagerWrites = true) {
  initializeRisks(db);
  const evaluate = (projectId?: string) => {
    try {
      const ids = projectId ? [projectId] : (db.prepare('SELECT project_id FROM risk_projects').all() as { project_id: string }[]).map(row => row.project_id);
      for (const id of ids) try { evaluateProjectRisks(db, id, clock()); } catch (error) {
        app.log.error({ err: error, projectId: id }, 'Risk evaluation failed; successful business writes are retained');
        try { recordEvaluationFailure(db, id); } catch (failure) { app.log.error({ err: failure }, 'Cannot persist risk evaluation warning'); }
      }
    } catch (error) { app.log.error({ err: error }, 'Risk evaluation sweep failed'); }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => { if (!isExistingDatabase(db)) evaluate(); if (intervalMs > 0) { timer = setInterval(() => evaluate(), intervalMs); timer.unref(); } });
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  app.addHook('onResponse', async (request, reply) => {
    if (!eagerWrites) return;
    if (!['POST', 'PATCH'].includes(request.method) || reply.statusCode < 200 || reply.statusCode >= 300) return;
    const route = request.routeOptions.url ?? '';
    if(route.endsWith('-preview')) return;
    if ((route.includes('/tasks') && !route.endsWith('/parent-preview')) || route.includes('/settings/') || route.endsWith('/schedule/apply') || route.endsWith('/baselines') || route.endsWith('/actions/create')) {
      const projectId = (request.params as { projectId?: string }).projectId; if (projectId) evaluate(projectId);
    }
  });
  const prefix = '/api/v1/projects/:projectId/risks';
  app.get<{ Params: { projectId: string } }>(prefix, (request, reply) => { reply.header('Cache-Control', 'no-store'); return { data: readRisks(db, request.params.projectId, protection.token, clock()) }; });
  for (const route of [
    { method: 'POST', path: '', operation: 'create' }, { method: 'PATCH', path: '/:objectId', operation: 'update' },
    { method: 'POST', path: '/:objectId/responsibilities', operation: 'responsibilities' },
    { method: 'POST', path: '/:objectId/transition', operation: 'transition' }, { method: 'POST', path: '/:objectId/actions', operation: 'action' },
    { method: 'POST', path: '/:objectId/actions/create', operation: 'create_action' }, { method: 'POST', path: '/alerts/:objectId/snooze', operation: 'snooze' },
    { method: 'POST', path: '/evaluate', operation: 'evaluate' },
  ] as const) app.route<{ Params: { projectId: string; objectId?: string }; Body: unknown }>({ method: route.method, url: `${prefix}${route.path}`, preHandler: protection.protectWrite, bodyLimit: 128 * 1024,
    handler: request => {
      try {
        const data = writeRisk(db, request.params.projectId, route.operation, request.params.objectId, request.body, request.headers['x-demo-actor'], request.headers['idempotency-key'], clock(), authenticatedActorName?.(request));
        if ('writeToken' in data) data.writeToken = protection.token;
        return { data };
      } catch (error) {
        if (route.operation !== 'evaluate' || error instanceof PlanError) throw error;
        app.log.error({ err: error, projectId: request.params.projectId }, 'Manual risk evaluation failed');
        try { recordEvaluationFailure(db, request.params.projectId); } catch (failure) { app.log.error({ err: failure }, 'Cannot persist risk evaluation warning'); }
        throw new PlanError(503, 'RISK_EVALUATION_FAILED', '风险预警刷新失败，当前仍显示上次结果。已完成的业务操作保留，请稍后重试。');
      }
    },
  });
}
