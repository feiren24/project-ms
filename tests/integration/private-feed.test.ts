import { createDecipheriv, createHmac, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openHomepageDatabase } from '../../server/src/db/connection.js';
import { registerAuthRoutes, createInitialAdmin } from '../../server/src/modules/auth/index.js';
import { registerPlanningRoutes } from '../../server/src/modules/planning/routes.js';
import { initializeSettings } from '../../server/src/modules/settings/store.js';
import { initializeTasks } from '../../server/src/modules/tasks/repository.js';
import { initializeRisks } from '../../server/src/modules/risks/repository.js';
import { initializeActivities, recordActivity } from '../../server/src/modules/activities/repository.js';
import { registerActivityRoutes } from '../../server/src/modules/activities/routes.js';
import { initializeNotifications, deliverNotification } from '../../server/src/modules/notifications/repository.js';
import { capturePlanHistoryEvent, captureProjectEvents, initializeEventTracking, type NotificationPayload } from '../../server/src/modules/notifications/events.js';
import { registerNotificationRoutes } from '../../server/src/modules/notifications/routes.js';
import { initializeJobs } from '../../server/src/jobs/store.js';
import { PlanError } from '../../server/src/modules/planning/errors.js';
import type { ActivityCategory, ActivityPage } from '../../shared/src/activities.js';

const pid = 'phase-one', prefix = `/api/v1/projects/${pid}`, now = new Date('2026-09-23T06:00:00Z');
const password = 'private-feed-memory-test-password';
const roles = { manager: 'zhou', admin: 'lin', member: 'chen', viewer: 'xu' } as const;
type Identity = keyof typeof roles | 'system';

// Every account, session, history row and notification is in this one in-memory DB.
describe('authenticated activity and notification management privacy', () => {
  let db: Database.Database, app: FastifyInstance, systemId: string;
  let sessions: Record<Identity, { cookie: string; csrf: string }>;
  beforeEach(async () => {
    db = openHomepageDatabase(':memory:'); app = Fastify();
    app.setErrorHandler((error, _request, reply) => error instanceof PlanError ? reply.code(error.statusCode).send({ error: { code: error.code } }) : reply.code(500).send({ error: String(error) }));
    const auth = registerAuthRoutes(app, db, () => now);
    app.addHook('preHandler', auth.authorizeBusiness);
    const protection = registerPlanningRoutes(app, db, () => now, auth.protectWrite, auth.actorName);
    initializeSettings(db); initializeTasks(db); initializeRisks(db); initializeJobs(db); initializeNotifications(db); initializeActivities(db, now); initializeEventTracking(db);
    registerActivityRoutes(app, db, () => now); registerNotificationRoutes(app, db, () => now, protection);
    const admin = await createInitialAdmin(db, { username: 'system', name: '系统测试管理员', password }, now); systemId = admin.id;
    const { password_hash } = db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(systemId) as { password_hash: string };
    for (const [role, memberId] of Object.entries(roles)) {
      db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND id=?').run(role === 'admin' ? 'project_admin' : role, pid, memberId);
      db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`account-${role}`, role, `${role}测试账号`, 'user', 1, 0, 0, 1, password_hash, now.toISOString(), now.toISOString());
      db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run(pid, memberId, `account-${role}`);
    }
    sessions = {} as typeof sessions;
    for (const identity of ['system', ...Object.keys(roles)] as Identity[]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: identity, password } });
      expect(response.statusCode, response.body).toBe(200);
      sessions[identity] = { cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: response.json().data.csrfToken };
    }
  });
  afterEach(async () => { await app?.close(); db?.close(); });
  const get = (path: string, identity: Identity = 'member') => app.inject({ url: `${prefix}${path}`, headers: { cookie: sessions[identity].cookie, 'x-demo-actor': 'zhou' } });
  async function data(path: string, identity: Identity = 'member') {
    const response = await get(path, identity); expect(response.statusCode, response.body).toBe(200); return response.json().data;
  }
  const mark = (body: object, identity: Identity = 'member') => app.inject({ method: 'POST', url: `${prefix}/notifications/read`, headers: { cookie: sessions[identity].cookie, 'x-csrf-token': sessions[identity].csrf, 'idempotency-key': randomUUID(), 'x-demo-actor': 'zhou' }, payload: body });
  function activity(type: string, category: ActivityCategory, historical = false, targetKind = category === 'workgroup' ? 'workgroup' : category) {
    return recordActivity(db, { projectId: pid, sourceKey: randomUUID(), type, category, actor: { id: 'zhou', name: '测试经理' }, occurredAt: now.toISOString(), target: { kind: targetKind, id: 'fixture', name: type }, summary: `${type} summary`, changes: [{ field: 'detail', before: null, after: `${type} detail` }], historical })!;
  }
  function payload(kind: string, recipientId = 'chen'): NotificationPayload {
    const target = kind.startsWith('risk.') || kind.startsWith('alert.') ? 'risk' : kind.startsWith('settings.') ? 'settings' : kind.startsWith('plan.') ? 'plan' : kind.startsWith('workstream.') ? 'workstreams' : 'task';
    return { recipientId, eventKey: randomUUID(), kind, title: `${kind} title`, message: `${kind} private detail`, target: { kind: target } };
  }
  function historicalNotification(kind: string, recipientId = 'chen') {
    const input = payload(kind, recipientId), id = randomUUID();
    db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,NULL)').run(id, pid, recipientId, input.eventKey, JSON.stringify({ id, recipientId, kind, title: input.title, message: input.message, target: input.target, createdAt: now.toISOString(), readAt: null }));
    return id;
  }
  function history(action: string) {
    const id = randomUUID();
    db.prepare('INSERT INTO plan_history VALUES(?,?,?,?)').run(id, pid, JSON.stringify({ id, action, actor: '测试经理', reason: `${action}记录`, createdAt: now.toISOString(), affectedCount: 1 }), now.toISOString());
    return id;
  }

  test.each(['member', 'viewer'] as const)('%s filters historical and current groups before pagination and denies direct/replayed private detail', async identity => {
    const publicIds = [activity('task.complete', 'task'), activity('plan.schedule', 'plan'), activity('workgroup.update', 'workgroup')];
    const privateIds = [activity('risk.create', 'risk'), activity('member.join', 'member', true), activity('project.calendar', 'project'), activity('plan.capacity', 'plan', true), activity('plan.member_update', 'plan'), activity('settings.capacity', 'project')];
    let cursor: string | null = null; const seen: string[] = [];
    do {
      const page = await data(`/activities?range=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, identity) as ActivityPage;
      seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
      expect(page.items.length).toBe(seen.length <= 2 ? 2 : 1);
      expect(JSON.stringify(page)).not.toMatch(/risk.create|member.join|project.calendar|plan.capacity|plan.member_update|settings.capacity/);
    } while (cursor);
    expect(seen.sort()).toEqual(publicIds.sort());
    const adminPage = await data('/activities?range=all', 'manager') as ActivityPage;
    for (const id of privateIds) {
      expect((await get(`/activities/${id}/items?range=all`, identity)).statusCode).toBe(404);
      const privilegedCursor = adminPage.items.find(item => item.id === id)!.itemsCursor;
      expect((await get(`/activities/${id}/items?cursor=${encodeURIComponent(privilegedCursor)}`, identity)).statusCode).toBe(404);
    }
    for (const id of publicIds) expect((await data(`/activities/${id}/items?range=all`, identity)).items).toHaveLength(1);
    expect((await data('/activities?range=all&category=risk', identity)).items).toEqual([]);
  });

  test('encrypted cursors hide sequence counters, authenticate every byte, reject legacy tokens and retain binding', async () => {
    activity('task.complete', 'task');
    for (let i=0;i<12;i++) activity('risk.create', 'risk');
    activity('plan.schedule', 'plan');
    const first = await data('/activities?range=all&limit=1') as ActivityPage;
    const again = await data('/activities?range=all&limit=1') as ActivityPage;
    const tokens = [first.nextCursor!, first.items[0]!.itemsCursor, again.nextCursor!];
    expect(tokens.every(token => token.startsWith('v2.'))).toBe(true);
    expect(new Set(tokens.map(token => token.length)).size).toBe(1);
    expect(first.nextCursor).not.toBe(again.nextCursor);
    for (const token of tokens) {
      const decoded = Buffer.from(token.split('.')[1]!, 'base64url').toString();
      expect(decoded).not.toMatch(/highwater|beforeSeq|afterSeq|phase-one|"management"/);
      expect(() => JSON.parse(decoded)).toThrow();
    }
    // Independently decrypt using the persisted secret to verify the encrypted
    // payload still carries the snapshot, rather than silently dropping its bounds.
    const { secret } = db.prepare('SELECT secret FROM activity_config WHERE id=1').get() as { secret: string };
    const aad = Buffer.from('goodwork:activity-cursor:v2');
    const packed = Buffer.from(first.nextCursor!.split('.')[1]!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', createHmac('sha256', secret).update(aad).digest(), packed.subarray(0,12));
    decipher.setAAD(aad); decipher.setAuthTag(packed.subarray(12,28));
    const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    const snapshot = JSON.parse(plaintext.subarray(2, 2+plaintext.readUInt16BE(0)).toString());
    expect(snapshot).toMatchObject({ project: pid, category: 'all', range: 'all', highwater: 14, beforeSeq: 14, management: false });
    for (const offset of [0,12,28,packed.length-1]) {
      const changed = Buffer.from(packed); changed[offset] = changed[offset]! ^ 1;
      const response = await get(`/activities?range=all&cursor=${encodeURIComponent(`v2.${changed.toString('base64url')}`)}`);
      expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('ACTIVITY_CURSOR_INVALID');
    }
    const legacyBody = Buffer.from(JSON.stringify(snapshot)).toString('base64url');
    const legacy = `${legacyBody}.${createHmac('sha256',secret).update(legacyBody).digest('base64url')}`;
    for (const token of [legacy, first.nextCursor!.replace('v2.', 'v1.')]) {
      for (const identity of ['member','system'] as const) expect((await get(`/activities?range=all&cursor=${encodeURIComponent(token)}`, identity)).statusCode).toBe(422);
    }
    for (const query of ['range=all&category=task','range=7d']) expect((await get(`/activities?${query}&cursor=${encodeURIComponent(first.nextCursor!)}`)).json().error.code).toBe('ACTIVITY_CURSOR_MISMATCH');
    const otherGroup = (await data(`/activities?range=all&cursor=${encodeURIComponent(first.nextCursor!)}`)).items[0].id;
    expect((await get(`/activities/${otherGroup}/items?cursor=${encodeURIComponent(first.items[0]!.itemsCursor)}`)).json().error.code).toBe('ACTIVITY_CURSOR_MISMATCH');
    db.prepare('INSERT INTO homepage_projects VALUES(?,?)').run('other',JSON.stringify({project:{id:'other',name:'Other project'}}));
    const crossProject = await app.inject({url:`/api/v1/projects/other/activities?range=all&cursor=${encodeURIComponent(first.nextCursor!)}`,headers:{cookie:sessions.system.cookie}});
    expect(crossProject.statusCode).toBe(422); expect(crossProject.json().error.code).toBe('ACTIVITY_CURSOR_MISMATCH');
    initializeActivities(db,now);
    expect((db.prepare('SELECT secret FROM activity_config WHERE id=1').get() as {secret:string}).secret).toBe(secret);
    expect((await data(`/activities?range=all&cursor=${encodeURIComponent(first.nextCursor!)}`)).items).toHaveLength(1);
  });

  test('encrypted feed and detail pagination keep their snapshot through private gaps and later group merges', async () => {
    const older = activity('workgroup.update','workgroup');
    const complete = (id: string) => recordActivity(db, {projectId:pid,sourceKey:randomUUID(),type:'task.complete',category:'task',actor:{id:'zhou',name:'测试经理'},occurredAt:now.toISOString(),target:{kind:'task',id,name:id},summary:id,groupable:true})!;
    const group = complete('first'); activity('risk.create','risk'); complete('second');
    const first = await data('/activities?range=all&limit=1') as ActivityPage;
    expect(first.items[0]).toMatchObject({id:group,count:2});
    const detail = await data(`/activities/${group}/items?limit=1&cursor=${encodeURIComponent(first.items[0]!.itemsCursor)}`);
    expect(detail.items.map((item: {summary:string})=>item.summary)).toEqual(['first']);
    for(let i=0;i<12;i++) activity('risk.create','risk');
    const privateOnly = await data('/activities?range=all&limit=1') as ActivityPage;
    expect(privateOnly.activityVersion).toBe(first.activityVersion);
    expect(privateOnly.nextCursor!.length).toBe(first.nextCursor!.length);
    complete('third'); const newer = activity('plan.schedule','plan');
    const next = await data(`/activities?range=all&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`) as ActivityPage;
    expect(next.items.map(item=>item.id)).toEqual([older]); expect(next.nextCursor).toBeNull();
    expect(next.items[0]!.snapshotVersion).toBe(first.items[0]!.snapshotVersion);
    expect(next.activityVersion).not.toBe(first.activityVersion);
    const rest = await data(`/activities/${group}/items?limit=1&cursor=${encodeURIComponent(detail.nextCursor)}`);
    expect(rest.items.map((item: {summary:string})=>item.summary)).toEqual(['second']); expect(rest.nextCursor).toBeNull();
    const refreshed = await data('/activities?range=all') as ActivityPage;
    expect(refreshed.items.map(item=>item.id)).toContain(newer);
    expect(refreshed.items.find(item=>item.id===group)!.count).toBe(3);
    expect((await data(`/activities/${group}/items?range=all`)).items.map((item: {summary:string})=>item.summary)).toEqual(['first','second','third']);
  });

  test('member and viewer refresh indicators follow permitted backfill state without hidden or cross-project counters', async () => {
    const group = activity('task.complete','task');
    let previous = await data('/activities?range=all') as ActivityPage;
    let revision = (await data('/revision')).revision;
    const mutations = [
      () => db.prepare("UPDATE activity_backfill SET status='running' WHERE id=1").run(),
      () => db.prepare('INSERT INTO activity_backfill_projects VALUES(?,7) ON CONFLICT(project_id) DO UPDATE SET processed_tasks=7').run(pid),
      () => db.prepare("UPDATE activity_backfill SET status='failed',error='历史动态整理失败，请重试' WHERE id=1").run(),
      () => db.prepare("UPDATE activity_backfill SET error='历史动态整理仍未完成' WHERE id=1").run(),
      () => db.prepare("UPDATE activity_backfill SET status='complete',error=NULL WHERE id=1").run(),
    ];
    for (const mutate of mutations) {
      mutate();
      const current = await data('/activities?range=all') as ActivityPage;
      expect(Number.isSafeInteger(current.activityVersion)).toBe(true);
      expect(current.activityVersion).not.toBe(previous.activityVersion);
      expect(current.items.map(item=>item.id)).toEqual([group]);
      const currentRevision = (await data('/revision')).revision;
      expect(currentRevision).not.toBe(revision);
      expect((await data(`/activities/${group}/items?range=all`)).activityVersion).toBe(current.activityVersion);
      expect((await data('/activities?range=all','viewer')).activityVersion).toBe(current.activityVersion);
      expect((await data('/revision','viewer')).revision).toBe(currentRevision);
      previous=current;revision=currentRevision;
    }
    // Internal backfill work, another project's progress and private events are
    // deliberately absent from both the returned backfill fields and the hash.
    db.prepare('UPDATE activity_backfill SET processed_tasks=9000,cursor=9000,attempts=7,retry_at=? WHERE id=1').run(now.toISOString());
    db.prepare('INSERT INTO activity_backfill_projects VALUES(?,5000)').run('other');
    activity('risk.create','risk'); activity('member.join','member'); activity('project.calendar','project');
    const unchanged = await data('/activities?range=all') as ActivityPage;
    expect(unchanged.backfill).toEqual({status:'complete',processedTasks:7,error:null});
    expect(unchanged.activityVersion).toBe(previous.activityVersion);
    expect((await data('/revision')).revision).toBe(revision);
  });

  test.each(['manager', 'admin', 'system'] as const)('%s retains management activity, notification, unread and capabilities access', async identity => {
    const privateId = activity('risk.create', 'risk', true);
    const recipient = identity === 'system' ? systemId : roles[identity];
    historicalNotification('risk.create', recipient); historicalNotification('plan.calendar', recipient);
    expect((await data('/activities?range=all', identity)).items.map((item: { id: string }) => item.id)).toContain(privateId);
    expect((await data(`/activities/${privateId}/items?range=all`, identity)).items[0].changes[0].after).toBe('risk.create detail');
    expect((await data('/notifications?actorId=chen', identity)).unread).toBe(2);
    const revision = await data('/revision?actorId=chen', identity);
    expect(revision.actorId).toBe(recipient); expect(revision.unread).toBe(2);
    expect(revision.capabilities).toEqual({ analytics: true, risks: true, settings: true });
    expect(deliverNotification(db, pid, payload('risk.create', recipient), now).delivered).toBe(true);
  });

  test('a mixed collaboration group cannot leak a private child through summary, preview or detail', async () => {
    const id = recordActivity(db, { projectId: pid, sourceKey: randomUUID(), type: 'plan.schedule', category: 'plan', actor: { id: 'zhou', name: '测试经理' }, occurredAt: now.toISOString(), target: null, summary: '含风险敏感汇总', items: [{ target: { kind: 'task', id: 'task-001', name: '普通任务' }, summary: '普通协作' }, { target: { kind: 'risk', id: 'private-risk', name: '风险秘密' }, summary: '风险秘密' }] })!;
    expect((await data('/activities?range=all')).items).toEqual([]);
    expect((await get(`/activities/${id}/items?range=all`)).statusCode).toBe(404);
    expect((await data(`/activities/${id}/items?range=all`, 'manager')).items).toHaveLength(2);
  });

  test.each(['member', 'viewer'] as const)('%s hides historical notifications and unread counts while retaining collaboration and minimal actors', async identity => {
    const recipient = roles[identity];
    for (const kind of ['risk.create', 'alert.create', 'settings.capacity', 'settings.member_update', 'plan.calendar', 'plan.capacity', 'plan.member_update']) historicalNotification(kind, recipient);
    const publicKinds = ['task.submit', 'plan.应用计划调整', 'plan.发布计划基线', 'plan.调整任务顺序', 'plan.里程碑：验收通过', 'plan.调整任务工作分组', 'workstream.update'];
    for (const kind of publicKinds) historicalNotification(kind, recipient);
    const workspace = await data('/notifications?actorId=zhou', identity), revision = await data('/revision?actorId=zhou', identity);
    expect(workspace.notifications.map((item: { kind: string }) => item.kind).sort()).toEqual(publicKinds.sort());
    expect(workspace.unread).toBe(publicKinds.length); expect(revision.unread).toBe(publicKinds.length);
    expect(workspace.jobs).toEqual([]); expect(workspace.canManageJobs).toBe(false);
    expect(revision.capabilities).toEqual({ analytics: false, risks: false, settings: false });
    for (const actor of [...workspace.actors, ...revision.actors]) expect(Object.keys(actor).sort()).toEqual(['assignable', 'id', 'name', 'role']);
    expect(revision.actors.find((actor: { id: string }) => actor.id === systemId).assignable).toBe(false);
    const before = db.prepare('SELECT total_changes() AS n').get();
    await data('/notifications', identity); await data('/revision', identity); await data('/activities', identity);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  test('private-only updates do not change a member revision or activity version; collaboration updates do', async () => {
    const before = await data('/revision'), managerBefore = await data('/revision', 'manager'), feedBefore = await data('/activities');
    for (const [table, field] of [['risk_projects', 'revision'], ['settings_projects', 'version'], ['plan_projects', 'version']]) db.prepare(`UPDATE ${table} SET ${field}=${field}+1 WHERE project_id=?`).run(pid);
    history('calendar'); history('capacity'); history('member_update'); activity('risk.create', 'risk'); activity('project.calendar', 'project');
    expect((await data('/revision')).revision).toBe(before.revision);
    expect((await data('/activities')).activityVersion).toBe(feedBefore.activityVersion);
    expect((await data('/revision', 'manager')).revision).not.toBe(managerBefore.revision);
    let revision = before.revision;
    for (const action of ['应用计划调整', '发布计划基线', '调整任务顺序', '调整任务工作分组', '里程碑：验收通过']) {
      history(action); const next = await data('/revision'); expect(next.revision).not.toBe(revision); revision = next.revision;
    }
    activity('task.complete', 'task'); expect((await data('/revision')).revision).not.toBe(revision);
  });

  test('mark-all affects only visible notifications and guessed hidden IDs get the same denial as absent IDs', async () => {
    const hidden = historicalNotification('risk.create'), visible = historicalNotification('task.submit');
    for (const ids of [[hidden], [randomUUID()], [visible, hidden]]) expect((await mark({ ids })).statusCode).toBe(403);
    expect((await mark({ all: true })).json().data.unread).toBe(0);
    expect(db.prepare('SELECT read_at FROM notifications WHERE id=?').get(hidden)).toEqual({ read_at: null });
    expect((db.prepare('SELECT read_at FROM notifications WHERE id=?').get(visible) as { read_at: string }).read_at).toBe(now.toISOString());
  });

  test('capture handles real Chinese collaboration actions and suppresses calendar/member/capacity plan history', () => {
    for (const action of ['应用计划调整', '发布计划基线', '调整任务顺序', '调整任务工作分组', '里程碑：验收通过', 'calendar', 'capacity', 'member_update']) capturePlanHistoryEvent(db, pid, now, history(action));
    const queued = (db.prepare("SELECT payload_json FROM background_jobs WHERE kind='notification'").all() as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as NotificationPayload);
    for (const recipient of ['chen', 'xu']) expect(queued.filter(item => item.recipientId === recipient).map(item => item.kind).sort()).toEqual(['plan.应用计划调整', 'plan.发布计划基线', 'plan.调整任务顺序', 'plan.调整任务工作分组', 'plan.里程碑：验收通过'].sort());
    expect(queued.filter(item => item.recipientId === 'zhou')).toHaveLength(8);
    captureProjectEvents(db, pid, now);
    expect(db.prepare("SELECT COUNT(*) AS n FROM background_jobs WHERE kind='notification'").get()).toEqual({ n: queued.length });
  });

  test('delivery and historical reads recheck CURRENT roles, account status, and global administrator elevation', async () => {
    const queued = payload('plan.calendar', 'zhou');
    expect(deliverNotification(db, pid, payload('risk.create', 'zhou'), now).delivered).toBe(true);
    const privilegedGroup = activity('risk.create', 'risk');
    const cursor = (await data('/activities?range=all', 'manager')).items[0].itemsCursor;
    db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND id='zhou'").run(pid);
    expect(deliverNotification(db, pid, queued, now).delivered).toBe(false);
    expect((await data('/notifications', 'manager')).unread).toBe(0);
    expect((await data('/revision', 'manager')).capabilities.risks).toBe(false);
    expect((await get(`/activities/${privilegedGroup}/items?cursor=${encodeURIComponent(cursor)}`, 'manager')).statusCode).toBe(404);
    expect(deliverNotification(db, pid, payload('task.submit', 'zhou'), now).delivered).toBe(true);
    db.prepare("UPDATE auth_users SET system_role='admin' WHERE id='account-member'").run();
    expect(deliverNotification(db, pid, payload('risk.create'), now).delivered).toBe(true);
    expect((await data('/revision')).capabilities.risks).toBe(true);
    db.prepare("UPDATE auth_users SET active=0 WHERE id='account-member'").run();
    expect(deliverNotification(db, pid, payload('risk.create'), now).delivered).toBe(false);
    expect(deliverNotification(db, pid, payload('task.submit'), now).delivered).toBe(false);
    expect((await get('/notifications')).statusCode).toBe(401);
  });
});
