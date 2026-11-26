import { isExistingDatabase } from '../../db/lifecycle.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { captureSnapshot, initializeAnalytics } from './snapshots.js';
import { readAnalytics } from './repository.js';
export function registerAnalyticsRoutes(app: FastifyInstance, database: Database.Database, clock: () => Date, intervalMs = 0, eagerWrites = true) {
  initializeAnalytics(database);
  const capture = (projectId?: string) => {
    try {
    const ids = projectId ? [projectId] : (database.prepare('SELECT id FROM homepage_projects').all() as {id:string}[]).map(row => row.id);
    for (const id of ids) try { captureSnapshot(database,id,clock()); } catch (error) { app.log.error({err:error,projectId:id},'Analytics snapshot failed; successful writes are retained'); }
    } catch (error) { app.log.error({err:error},'Analytics snapshot sweep failed; successful writes are retained'); }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => { if (!isExistingDatabase(database)) capture(); if (intervalMs > 0) { timer = setInterval(() => capture(),intervalMs); timer.unref(); } });
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  app.addHook('onResponse', async (request,reply) => {
    if (!eagerWrites) return;
    if (!['POST','PATCH'].includes(request.method) || reply.statusCode < 200 || reply.statusCode >= 300) return;
    const route = request.routeOptions.url ?? '';
    // Recycle checks are read-only; lifecycle writes never rewrite existing observations.
    if(route.endsWith('-preview') || /\/tasks\/(?:deleted\/)?[^/]+\/(delete|restore)$/.test(route)) return;
    if ((route.includes('/tasks') && !route.endsWith('/parent-preview')) || route.includes('/settings/') || route.endsWith('/schedule/apply') || route.endsWith('/baselines') || route.endsWith('/actions/create')) {
      const projectId = (request.params as {projectId?:string}).projectId; if (projectId) capture(projectId);
    }
  });
  app.get<{Params:{projectId:string};Querystring:Record<string,unknown>}>('/api/v1/projects/:projectId/analytics',(request,reply) => {
    reply.header('Cache-Control','no-store'); return {data:readAnalytics(database,request.params.projectId,request.query,clock())};
  });
}
