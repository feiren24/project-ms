import type { DatabaseMode } from './db/lifecycle.js';
import { managementCapabilities, requestCanViewManagement, setRequestManagementAccess } from './modules/auth/project-access.js';
import { registerWeb } from './web.js';
import { initializeFeishu } from './modules/feishu/store.js';
import { initializeFeishuEngine, createFeishuRunner, type FeishuRuntimeOptions } from './modules/feishu/engine.js';
import { registerFeishuRoutes } from './modules/feishu/routes.js';
import { createSystemSettingsProvider, registerSystemSettingsRoutes, type SystemSettingsProviderOptions } from './modules/system-settings/index.js';
import { initializeActivities } from './modules/activities/repository.js';
import { registerActivityRoutes } from './modules/activities/routes.js';
import { configureBusinessJobCoalescing } from './job-integration.js';
import { registerMilestoneRoutes } from './modules/milestones/routes.js';
import { registerAuthRoutes } from './modules/auth/index.js';
import { initializeJobs } from './jobs/store.js';
import { createJobRunner } from './jobs/runner.js';
import { initializeNotifications, deliverNotification } from './modules/notifications/repository.js';
import { initializeEventTracking } from './modules/notifications/events.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import Fastify from 'fastify';
import { registerSettingsRoutes } from './modules/settings/routes.js';
import { registerRiskRoutes } from './modules/risks/routes.js';
import { registerAnalyticsRoutes } from './modules/analytics/routes.js';
import { openHomepageDatabase } from './db/connection.js';
import { readProjectOverview } from './modules/overview/repository.js';
import { registerPlanningRoutes } from './modules/planning/routes.js';
import { PlanError } from './modules/planning/errors.js';
import { registerTaskRoutes } from './modules/tasks/routes.js';
import { registerProjectRoutes } from './modules/projects/routes.js';
import { registerWorkstreamRoutes } from './modules/workstreams/routes.js';

export function buildApp(options: { databaseMode?: DatabaseMode; webRoot?: string; dbPath?: string; clock?: () => Date; snapshotIntervalMs?: number; riskIntervalMs?: number; jobIntervalMs?: number; backupDirectory?: string; testOnlyLegacyAuth?: boolean; secureCookies?: boolean; allowedOrigins?: string[]; feishu?: FeishuRuntimeOptions; systemSettings?: Omit<SystemSettingsProviderOptions, 'clock' | 'environmentKey'> } = {}) {
  if (options.testOnlyLegacyAuth && process.env.NODE_ENV !== 'test') throw new Error('Legacy authentication fixture is restricted to test processes');
  const database = openHomepageDatabase(options.dbPath, options.databaseMode);
  configureBusinessJobCoalescing(database,!options.testOnlyLegacyAuth && options.jobIntervalMs !== 0);
  const app = Fastify({ logger: { level: 'error' } });

  if (!options.webRoot) app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', message: '当前预览未提供此功能。' }, requestId: request.id,
  }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PlanError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details }, requestId: request.id });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { code: 'INVALID_REQUEST', message: '请求内容或大小不符合要求，请检查后重试。' }, requestId: request.id });
    }
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    const unavailable = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    return reply.code(unavailable ? 503 : 500).send({
      error: {
        code: unavailable ? 'TEMPORARILY_UNAVAILABLE' : 'INTERNAL_ERROR',
        message: unavailable ? '演示数据暂时忙碌，请稍后重试。' : '首页数据暂时无法读取，请重试。',
      },
      requestId: request.id,
    });
  });

  const clock = options.clock ?? (() => new Date());
  let authenticatedProtection: { protectWrite: (request: import('fastify').FastifyRequest) => Promise<void>; actorName: (request: import('fastify').FastifyRequest) => string; systemAdmin: (request: import('fastify').FastifyRequest) => boolean; accountId: (request: import('fastify').FastifyRequest) => string } | undefined;
  if (options.testOnlyLegacyAuth) {
    app.addHook('preHandler', async request => { setRequestManagementAccess(request, true); });
    app.get('/api/v1/auth/session', () => ({ data: { user: null, csrfToken: '', projects: [], initialized: true, legacyDemo: true } }));
  } else {
    const auth = registerAuthRoutes(app, database, clock, { secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production', allowedOrigins: options.allowedOrigins });
    app.addHook('preHandler', auth.authorizeBusiness);
    authenticatedProtection = auth;
  }
  const protection = registerPlanningRoutes(app, database, clock, authenticatedProtection?.protectWrite, authenticatedProtection?.actorName, options.allowedOrigins, authenticatedProtection?.accountId);
  registerSettingsRoutes(app, database, clock, protection, Boolean(options.testOnlyLegacyAuth), authenticatedProtection ? request => ({ name: authenticatedProtection!.actorName(request), systemAdmin: authenticatedProtection!.systemAdmin(request) }) : undefined);
  registerTaskRoutes(app, database, clock, protection, authenticatedProtection?.actorName);
  registerMilestoneRoutes(app, database, clock, protection, authenticatedProtection?.actorName);
  registerWorkstreamRoutes(app, database, clock, protection, authenticatedProtection ? request => ({ name: authenticatedProtection!.actorName(request), systemAdmin: authenticatedProtection!.systemAdmin(request), accountId: authenticatedProtection!.accountId(request) }) : undefined);
  registerAnalyticsRoutes(app, database, clock, options.snapshotIntervalMs, Boolean(options.testOnlyLegacyAuth));
  registerRiskRoutes(app, database, clock, protection, options.riskIntervalMs ?? 0, authenticatedProtection?.actorName, Boolean(options.testOnlyLegacyAuth));
  initializeActivities(database,clock());
  registerActivityRoutes(app,database,clock);
  initializeJobs(database);
  initializeNotifications(database);
  initializeEventTracking(database);
  initializeFeishu(database);
  initializeFeishuEngine(database);
  const systemSettings = createSystemSettingsProvider(database, {
    ...options.systemSettings,
    environmentKey: options.feishu?.masterKey ?? process.env.FEISHU_MASTER_KEY,
    clock,
  });
  if (authenticatedProtection) registerSystemSettingsRoutes(app, systemSettings, authenticatedProtection);
  const feishuOptions:FeishuRuntimeOptions = { publicBaseUrl: process.env.PUBLIC_BASE_URL, ...options.feishu, getMasterKey: options.feishu?.getMasterKey ?? systemSettings.getKey, clock, intervalMs: options.feishu?.intervalMs ?? options.jobIntervalMs };
  const feishuRunner = createFeishuRunner(database, feishuOptions);
  registerFeishuRoutes(app,database,clock,protection,feishuOptions);
  const runner = createJobRunner(database, { clock, intervalMs: options.jobIntervalMs, backupDirectory: options.backupDirectory,
    handlers: { notification: (job, now) => deliverNotification(database, job.projectId, job.payload, now) },
    onError: error => app.log.error(error),
  });
  registerNotificationRoutes(app, database, clock, protection);
  if (authenticatedProtection) registerProjectRoutes(app, database, clock, authenticatedProtection.protectWrite);
  app.addHook('onReady', async () => { if (options.databaseMode !== 'existing-only' || options.jobIntervalMs !== 0) await runner.runDueJobs(clock(),100,false); if (options.jobIntervalMs !== 0) runner.start(); if (feishuOptions.intervalMs !== 0) feishuRunner.start(); });
  app.addHook('onResponse', async (request, reply) => {
    // System key configuration does not trigger delivery. Existing enabled rules
    // resume through their normal scheduler once the recovered key is available.
    if (['POST', 'PATCH'].includes(request.method) && !(request.routeOptions.url ?? '').endsWith('-preview') && reply.statusCode < 400 && !/^\/api\/v1\/admin\/settings(?:\/|\?|$)/.test(request.url)) {
      if (options.testOnlyLegacyAuth || options.jobIntervalMs === 0) await runner.runDueJobs();
      else setImmediate(() => { void runner.runDueJobs().catch(error => app.log.error(error)); });
      if (feishuOptions.intervalMs !== 0) setImmediate(() => { void feishuRunner.runDueJobs().catch(() => app.log.error('飞书通知作业处理失败，请检查发送记录。')); });
    }
  });
  app.addHook('onClose', async () => { await feishuRunner.stop(); await runner.stop(); database.close(); });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/overview', (request, reply) => {
    const data = readProjectOverview(database, request.params.projectId, clock());
    if (!data) return reply.code(404).send({
      error: { code: 'PROJECT_NOT_FOUND', message: '未找到此演示项目。' }, requestId: request.id,
    });
    reply.header('Cache-Control', 'no-store');
    const capabilities = managementCapabilities(requestCanViewManagement(request));
    if (capabilities.risks) return { data: { ...data, capabilities } };
    const { risks: _risks, summary, ...visible } = data;
    const { highRisks: _highRisks, riskReviewOverdue: _riskReviewOverdue, ...publicSummary } = summary;
    return { data: { ...visible, activities: [], summary: publicSummary, capabilities } };
  });

  app.get('/health/live', () => ({ data: { status: 'ok', mode: 'demo' } }));
  app.get('/health/ready', (request, reply) => {
    try {
      database.prepare('SELECT id FROM homepage_projects LIMIT 1').get();
      if (database.pragma('user_version', { simple: true }) !== 1) throw new Error('Schema unavailable');
      return { data: { status: 'ok', mode: 'demo' } };
    } catch {
      return reply.code(503).send({ error: { code: 'NOT_READY', message: '演示数据尚未就绪，请稍后重试。' }, requestId: request.id });
    }
  });
  if (options.webRoot) registerWeb(app, options.webRoot);
  return app;
}
