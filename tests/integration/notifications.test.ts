import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openHomepageDatabase } from '../../server/src/db/connection.js';
import { registerPlanningRoutes } from '../../server/src/modules/planning/routes.js';
import { initializeTasks } from '../../server/src/modules/tasks/repository.js';
import { initializeSettings } from '../../server/src/modules/settings/store.js';
import { initializeRisks } from '../../server/src/modules/risks/repository.js';
import { PlanError } from '../../server/src/modules/planning/errors.js';
import { enqueueJob, initializeJobs, listJobs } from '../../server/src/jobs/store.js';
import { captureProjectEvents, initializeEventTracking, type NotificationPayload } from '../../server/src/modules/notifications/events.js';
import { deliverNotification, initializeNotifications } from '../../server/src/modules/notifications/repository.js';
import { registerNotificationRoutes } from '../../server/src/modules/notifications/routes.js';
const projectId = 'phase-one'; const prefix = `/api/v1/projects/${projectId}`; const now = new Date('2026-09-23T02:00:00Z');
describe('durable project notifications and recipient-scoped API', () => {
  let db: Database.Database; let app: FastifyInstance; let token: string;
  beforeEach(() => {
    db = openHomepageDatabase(':memory:'); app = Fastify();
    app.addHook('preHandler', async request => { setRequestManagementAccess(request, true); });
    app.setErrorHandler((error, _request, reply) => error instanceof PlanError ? reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } }) : reply.code(500).send({ error: { message: error instanceof Error ? error.message : String(error) } }));
    const protection = registerPlanningRoutes(app, db, () => now); token = protection.token;
    initializeSettings(db); initializeTasks(db); initializeRisks(db); initializeJobs(db); initializeNotifications(db); initializeEventTracking(db);
    registerNotificationRoutes(app, db, () => now, protection);
  });
  afterEach(async () => { await app.close(); db.close(); });
  const payload = (recipientId = 'chen', eventKey = randomUUID()): NotificationPayload => ({ recipientId, eventKey, kind: 'task.submit', title: 'DEMO 任务成果提交', message: 'DEMO · 已提交待验收', target: { kind: 'task', id: 'task-001' } });
  async function workspace(actor = 'chen') { const response = await app.inject(`${prefix}/notifications?actorId=${actor}`); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
  async function write(path: string, body: object, actor = 'chen', key: string = randomUUID(), headers: Record<string, string> = {}) { return app.inject({ method: 'POST', url: `${prefix}/notifications/${path}`, headers: { 'x-preview-token': token, 'x-demo-actor': actor, 'idempotency-key': key, ...headers }, payload: body }); }
  function addTaskEvent(id = randomUUID()) {
    const row = db.prepare("SELECT meta_json FROM task_meta WHERE task_id='task-001'").get() as { meta_json: string }; const meta = JSON.parse(row.meta_json);
    meta.ownerId = 'chen'; meta.reviewerId = 'lin'; meta.events.push({ id, actor: '周亦安', action: 'submit', text: 'DEMO 已提交', createdAt: now.toISOString() });
    db.prepare("UPDATE task_meta SET meta_json=? WHERE task_id='task-001'").run(JSON.stringify(meta)); return id;
  }
  test('initial historical events are skipped; new events dedupe across repeated initialization, capture and delivery', async () => {
    captureProjectEvents(db, projectId, now); expect(listJobs(db, projectId)).toHaveLength(0);
    addTaskEvent(); initializeNotifications(db); initializeEventTracking(db); captureProjectEvents(db, projectId, now);
    expect(listJobs(db, projectId)).toHaveLength(3);
    captureProjectEvents(db, projectId, now); initializeEventTracking(db); captureProjectEvents(db, projectId, now); expect(listJobs(db, projectId)).toHaveLength(3);
    for (const row of db.prepare('SELECT payload_json FROM background_jobs').all() as { payload_json: string }[]) { const item = JSON.parse(row.payload_json); deliverNotification(db, projectId, item, now); deliverNotification(db, projectId, item, now); }
    expect((await workspace()).notifications).toHaveLength(1); expect((await workspace('lin')).notifications).toHaveLength(1); expect((await workspace('zhou')).notifications).toHaveLength(1); expect((await workspace('xu')).notifications).toHaveLength(0);
  });
  test('persistent initialization marker survives database reopen without swallowing uncaptured events', async () => {
    addTaskEvent(); const directory = await mkdtemp(join(tmpdir(), 'goodwork-notification-restart-')); const path = join(directory, 'restart.sqlite');
    try {
      await db.backup(path); const restored = openHomepageDatabase(path);
      try { initializeNotifications(restored); initializeEventTracking(restored); captureProjectEvents(restored, projectId, now); expect(listJobs(restored, projectId)).toHaveLength(3); captureProjectEvents(restored, projectId, now); expect(listJobs(restored, projectId)).toHaveLength(3); } finally { restored.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('queue and seen marker roll back with event and enqueue errors', () => {
    expect(() => db.transaction(() => { addTaskEvent(); captureProjectEvents(db, projectId, now); throw new Error('business rollback'); })()).toThrow('business rollback'); expect(listJobs(db, projectId)).toHaveLength(0);
    const id = addTaskEvent(); db.exec("CREATE TRIGGER fail_notification_queue BEFORE INSERT ON background_jobs BEGIN SELECT RAISE(ABORT,'queue failure'); END;");
    expect(() => captureProjectEvents(db, projectId, now)).toThrow('queue failure'); expect(db.prepare('SELECT 1 FROM notification_seen WHERE event_key=?').get(`task:task-001:${id}`)).toBeUndefined(); db.exec('DROP TRIGGER fail_notification_queue');
    captureProjectEvents(db, projectId, now); expect(listJobs(db, projectId)).toHaveLength(3);
  });
  test('GETs never create business writes or queue jobs; revision includes business changes but excludes read state', async () => {
    deliverNotification(db, projectId, payload(), now); const before = (await app.inject(`${prefix}/revision?actorId=chen`)).json().data;
    const changes = db.prepare('SELECT total_changes() AS n').get(); await workspace(); await app.inject(`${prefix}/revision?actorId=chen`); expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect((await write('read', { all: true })).statusCode).toBe(200); const after = (await app.inject(`${prefix}/revision?actorId=chen`)).json().data; expect(after.revision).toBe(before.revision); expect(before.unread).toBe(1); expect(after.unread).toBe(0);
    let revision = after.revision;
    for (const [table, field] of [['plan_projects', 'version'], ['risk_projects', 'revision'], ['settings_projects', 'version']]) { db.prepare(`UPDATE ${table} SET ${field}=${field}+1 WHERE project_id=?`).run(projectId); const next = (await app.inject(`${prefix}/revision?actorId=chen`)).json().data.revision; expect(next).not.toBe(revision); revision = next; }
    expect(listJobs(db, projectId)).toHaveLength(0);
  });
  test('read requires active actor, token/origin, exact payload, idempotency and own project recipient IDs', async () => {
    deliverNotification(db, projectId, payload(), now); deliverNotification(db, projectId, payload('lin'), now);
    const own = (await workspace()).notifications[0].id; const other = (await workspace('lin')).notifications[0].id;
    expect((await app.inject(`${prefix}/notifications`)).statusCode).toBe(403); expect((await app.inject('/api/v1/projects/missing/notifications?actorId=chen')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${prefix}/notifications/read`, payload: { all: true } })).statusCode).toBe(403);
    expect((await write('read', { all: true }, 'chen', randomUUID(), { origin: 'https://evil.example' })).statusCode).toBe(403);
    for (const body of [{}, { all: false }, { ids: [] }, { ids: [own, own] }, { all: true, ids: [own] }, { all: true, actorId: 'lin' }, { ids: [null] }]) expect((await write('read', body)).statusCode).toBe(422);
    expect((await write('read', { ids: [own, other] })).statusCode).toBe(403); expect((await workspace()).unread).toBe(1);
    expect((await write('read', { ids: [own] }, 'chen', 'bad')).statusCode).toBe(422);
    const key = randomUUID(); const response = await write('read', { ids: [own] }, 'chen', key); expect(response.statusCode).toBe(200); expect(response.json().data.unread).toBe(0);
    expect((await write('read', { ids: [own] }, 'chen', key)).statusCode).toBe(200); expect((await write('read', { all: true }, 'chen', key)).statusCode).toBe(409); expect((await workspace('lin')).unread).toBe(1);
    db.prepare('UPDATE project_members SET active=0 WHERE project_id=? AND id=?').run(projectId, 'chen');
    expect((await app.inject(`${prefix}/notifications?actorId=chen`)).statusCode).toBe(403); expect((await app.inject(`${prefix}/revision?actorId=chen`)).statusCode).toBe(403); expect((await write('read', { ids: [own] }, 'chen', key)).statusCode).toBe(403);
    expect(deliverNotification(db, projectId, payload(), now).delivered).toBe(false);
  });
  test('retry is manager-only, project-scoped, failed-only and replay never resets a running job', async () => {
    addTaskEvent(); captureProjectEvents(db, projectId, now); const job = listJobs(db, projectId)[0]!;
    expect((await workspace()).jobs).toEqual([]); expect((await workspace('zhou')).jobs).toHaveLength(3);
    expect((await write(`jobs/${job.id}/retry`, {}, 'chen')).statusCode).toBe(403); expect((await write(`jobs/${job.id}/retry`, {}, 'zhou')).statusCode).toBe(409);
    db.prepare("UPDATE background_jobs SET status='failed',attempts=4,error='DEMO failure' WHERE id=?").run(job.id);
    expect((await write(`jobs/${job.id}/retry`, { force: true }, 'zhou')).statusCode).toBe(422);
    const key = randomUUID(); expect((await write(`jobs/${job.id}/retry`, {}, 'zhou', key)).statusCode).toBe(200);
    db.prepare("UPDATE background_jobs SET status='running' WHERE id=?").run(job.id);
    expect((await write(`jobs/${job.id}/retry`, {}, 'zhou', key)).statusCode).toBe(200); expect(listJobs(db, projectId).find(item => item.id === job.id)?.status).toBe('running');
    expect(db.prepare('SELECT project_id,job_id,actor_id,retried_at FROM notification_job_retries').all()).toEqual([{ project_id: projectId, job_id: job.id, actor_id: 'zhou', retried_at: now.toISOString() }]);
    expect((await write(`jobs/${job.id}/retry`, {}, 'zhou')).statusCode).toBe(409);
    db.prepare("UPDATE background_jobs SET status='succeeded' WHERE id=?").run(job.id); expect((await write(`jobs/${job.id}/retry`, {}, 'zhou')).statusCode).toBe(409);
  });
  test('existing jobs and notifications from another project cannot be retried or marked read', async () => {
    db.prepare('INSERT INTO homepage_projects VALUES (?,?)').run('other', JSON.stringify({ project: { id: 'other', name: 'DEMO 其他项目' } }));
    const id = enqueueJob(db, { projectId: 'other', kind: 'notification', dedupeKey: 'other-event', payload: payload(), dueAt: now }, now);
    db.prepare("UPDATE background_jobs SET status='failed' WHERE id=?").run(id);
    expect((await write(`jobs/${id}/retry`, {}, 'zhou')).statusCode).toBe(409);
    db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,NULL)').run('other-notification', 'other', 'chen', 'other-event', JSON.stringify({ id: 'other-notification', ...payload() }));
    expect((await write('read', { ids: ['other-notification'] })).statusCode).toBe(403);
    expect((await workspace()).notifications).toHaveLength(0); expect((await workspace('zhou')).jobs).toHaveLength(0);
  });
  test('risk events and plan/settings events route to distinct active recipient sets; repeated evidence is quiet', () => {
    const row = db.prepare("SELECT snapshot_json FROM risk_records WHERE id='risk-01'").get() as { snapshot_json: string }; const risk = JSON.parse(row.snapshot_json); risk.ownerId = 'chen'; risk.closeReviewerId = 'lin'; risk.taskIds = []; risk.events.push({ id: 'fresh-risk', action: 'assess', actor: '周亦安', text: 'DEMO 已评估', createdAt: now.toISOString() });
    db.prepare("UPDATE risk_records SET snapshot_json=? WHERE id='risk-01'").run(JSON.stringify(risk)); captureProjectEvents(db, projectId, now); expect(listJobs(db, projectId)).toHaveLength(1);
    expect((db.prepare("SELECT json_extract(payload_json,'$.recipientId') AS recipient FROM background_jobs").all())).toEqual([{ recipient: 'zhou' }]);
    risk.description = '更新证据但无新事件'; db.prepare("UPDATE risk_records SET snapshot_json=? WHERE id='risk-01'").run(JSON.stringify(risk)); captureProjectEvents(db, projectId, now); expect(listJobs(db, projectId)).toHaveLength(1);
    const event = { id: randomUUID(), action: '发布计划基线', actor: '周亦安', reason: 'DEMO 确认基线', createdAt: now.toISOString() }; db.prepare('INSERT INTO plan_history VALUES (?,?,?,?)').run(event.id, projectId, JSON.stringify(event), event.createdAt);
    const setting = { ...event, id: randomUUID(), action: 'capacity', summary: 'DEMO 容量更新' }; db.prepare('INSERT INTO settings_events VALUES (?,?,?)').run(setting.id, projectId, JSON.stringify(setting));
    captureProjectEvents(db, projectId, now); expect(listJobs(db, projectId)).toHaveLength(6);
  });
});
import { setRequestManagementAccess } from '../../server/src/modules/auth/project-access.js';
