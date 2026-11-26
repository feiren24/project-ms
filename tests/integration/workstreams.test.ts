import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthSession } from '../../shared/src/auth.js';
import type { WorkstreamWorkspace } from '../../shared/src/workstreams.js';

type Login = { cookie: string; session: AuthSession };
const password = '工作分组测试管理员密码 2026';

describe('project workstream management', () => {
  let directory: string;
  let dbPath: string;
  let app: FastifyInstance;
  let db: Database.Database;
  const now = new Date('2026-09-07T08:00:00Z');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-workstreams-'));
    dbPath = join(directory, 'workstreams.sqlite');
    app = buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 });
    db = new Database(dbPath);
  });
  afterEach(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });

  async function admin(): Promise<Login> {
    await createInitialAdmin(db, { username: 'admin', name: '实名管理员', password }, now);
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password } });
    return { cookie: String(response.headers['set-cookie']).split(';')[0]!, session: response.json().data };
  }
  const writeHeaders = (login: Login, key: string = randomUUID()) => ({ cookie: login.cookie, origin: 'http://localhost:5174', 'x-csrf-token': login.session.csrfToken, 'idempotency-key': key });
  async function workspace(login: Login, projectId = 'phase-one') {
    const response = await app.inject({ url: `/api/v1/projects/${projectId}/workstreams`, headers: { cookie: login.cookie } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data as WorkstreamWorkspace;
  }

  test('migrates current groups without changing ids, task WBS or baselines and remains idempotent after restart', async () => {
    const login = await admin();
    const beforePlan = db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get('phase-one') as { nodes_json: string };
    const beforeBaseline = db.prepare('SELECT snapshot_json FROM plan_baselines WHERE project_id=? ORDER BY rowid LIMIT 1').get('phase-one') as { snapshot_json: string };
    const first = await workspace(login);
    expect(first.workstreams.map(item => item.id)).toEqual(['system-bottom', 'b-side', 'c-side', 'commercial', 'admin', 'operations']);
    expect(first.workstreams.every(item => item.active && item.version === 1)).toBe(true);
    await app.close();
    app = buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 });
    const second = await workspace(login);
    expect(second.workstreams).toEqual(first.workstreams);
    expect((db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get('phase-one') as { nodes_json: string }).nodes_json).toBe(beforePlan.nodes_json);
    expect((db.prepare('SELECT snapshot_json FROM plan_baselines WHERE project_id=? ORDER BY rowid LIMIT 1').get('phase-one') as { snapshot_json: string }).snapshot_json).toBe(beforeBaseline.snapshot_json);
  });

  test('creates updates orders and disables a workstream with dual versions, audit and idempotent receipt', async () => {
    const login = await admin();
    let current = await workspace(login);
    const key = 'create-workstream-once';
    const createPayload = { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '建立交付分组', workstream: { name: '质量保障', description: '集成测试与发布验收', ownerId: null, color: 'purple' } };
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login, key), payload: createPayload });
    expect(created.statusCode, created.body).toBe(200);
    current = created.json().data;
    expect(current).toMatchObject({ version: 2, planVersion: 2, canManage: true });
    const item = current.workstreams.find((stream: { name: string }) => stream.name === '质量保障')!;
    expect(item).toMatchObject({ description: '集成测试与发布验收', ownerId: null, color: 'purple', active: true, version: 1, taskCount: 0 });
    const notifications = (await app.inject({ url: '/api/v1/projects/phase-one/notifications', headers: { cookie: login.cookie } })).json().data.notifications;
    expect(notifications.filter((notice: { target: { kind: string; id?: string } }) => notice.target.kind === 'workstreams' && notice.target.id === item.id)).toHaveLength(1);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login, key), payload: createPayload });
    expect(replay.json()).toEqual(created.json());
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login, key), payload: { ...createPayload, reason: '不同内容' } })).json().error.code).toBe('IDEMPOTENCY_CONFLICT');

    const moved = await app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/workstreams/${item.id}/move`, headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '调整显示顺序', direction: 'up' } });
    expect(moved.statusCode, moved.body).toBe(200);
    current = moved.json().data;
    expect(current.workstreams.at(-2)?.id).toBe(item.id);
    const disabled = await app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/workstreams/${item.id}/status`, headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '阶段范围已暂停', active: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().data.workstreams.find((stream: { id: string }) => stream.id === item.id).active).toBe(false);
    expect(disabled.json().data.history[0]).toMatchObject({ workstreamId: item.id, action: 'workstream.disable', actor: '实名管理员', reason: '阶段范围已暂停' });
  });

  test('strictly validates and isolates writes by permission, project, CSRF and real session actor', async () => {
    const login = await admin();
    const current = await workspace(login);
    const draft = { name: '非法颜色分组', description: '', ownerId: null, color: 'pink' };
    const payload = { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '验证严格字段', workstream: draft };
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login), payload });
    expect(invalid.statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: { ...writeHeaders(login), 'x-demo-actor': 'zhou' }, payload: { ...payload, workstream: { ...draft, color: 'blue' } } })).statusCode).toBe(200);
    expect((db.prepare('SELECT snapshot_json FROM workstream_events ORDER BY rowid DESC LIMIT 1').get() as { snapshot_json: string }).snapshot_json).toContain('实名管理员');
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: { cookie: login.cookie, 'x-csrf-token': login.session.csrfToken, origin: 'https://evil.example', 'idempotency-key': randomUUID() }, payload: { ...payload, workstream: { ...draft, name: '跨站请求', color: 'blue' } } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/projects/missing/workstreams', headers: { cookie: login.cookie } })).statusCode).toBe(404);
  });

  test('creates the default row for a new project and blocks new work in a disabled workstream while preserving existing edits', async () => {
    const login = await admin();
    const createdProject = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: writeHeaders(login, 'create-project-with-workstream'), payload: { name: '工作分组项目', goal: '核对空白项目默认记录', start: '2026-10-01', end: '2026-12-31' } });
    expect(createdProject.statusCode, createdProject.body).toBe(200);
    const projectId = createdProject.json().data.id;
    expect((await workspace(login, projectId)).workstreams).toMatchObject([{ id: 'general', name: '通用工作', active: true, ownerId: login.session.user!.id }]);

    let current = await workspace(login);
    const disabled = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams/b-side/status', headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '暂停新增承诺', active: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const tasks = (await app.inject({ url: '/api/v1/projects/phase-one/tasks', headers: { cookie: login.cookie } })).json().data;
    expect(tasks.workstreams.find((item: { id: string }) => item.id === 'b-side').active).toBe(false);
    const existing = tasks.tasks.find((item: { workstreamId: string; status: string }) => item.workstreamId === 'b-side' && item.status !== 'done');
    const edit = await app.inject({ method: 'PATCH', url: `/api/v1/projects/phase-one/tasks/${existing.id}`, headers: writeHeaders(login), payload: {
      title: existing.title, description: `${existing.description}（保留编辑）`, workstreamId: existing.workstreamId, parentId: existing.parentId, ownerId: existing.ownerId,
      priority: existing.priority, effortHours: existing.effortHours, requiresReview: existing.requiresReview, reviewerId: existing.reviewerId,
      acceptanceCriteria: existing.acceptanceCriteria, evidence: existing.evidence, expectedVersion: existing.version, expectedPlanVersion: tasks.planVersion,
    }});
    expect(edit.statusCode, edit.body).toBe(200);
    const latest = (await app.inject({ url: '/api/v1/projects/phase-one/tasks', headers: { cookie: login.cookie } })).json().data;
    const draft = { title: '禁止新增任务', description: '', workstreamId: 'b-side', parentId: null, ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null };
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/tasks', headers: writeHeaders(login), payload: { ...draft, expectedPlanVersion: latest.planVersion } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('WORKSTREAM_INACTIVE');
    const preview = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/tasks/parent-preview', headers: writeHeaders(login), payload: { parentId: existing.id, workstreamId: 'b-side', expectedPlanVersion: latest.planVersion } });
    expect(preview.statusCode).toBe(422);
    expect(preview.json().error.code).toBe('WORKSTREAM_INACTIVE');
    const risks = (await app.inject({ url: '/api/v1/projects/phase-one/risks', headers: { cookie: login.cookie } })).json().data;
    const risk = risks.risks.find((item: { workstreamId: string }) => item.workstreamId === 'b-side');
    const responseTask = await app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/risks/${risk.id}/actions/create`, headers: writeHeaders(login), payload: { expectedVersion: risk.version, expectedPlanVersion: latest.planVersion, draft } });
    expect(responseTask.statusCode).toBe(422);
    expect(responseTask.json().error.code).toBe('WORKSTREAM_INACTIVE');
  });

  test('does not count generated summary containers and rolls back plan, snapshot, audit and queue together', async () => {
    const login = await admin();
    const before = await workspace(login);
    const tasks = (await app.inject({ url: '/api/v1/projects/phase-one/tasks', headers: { cookie: login.cookie } })).json().data;
    const parent = tasks.tasks.find((item: { workstreamId: string; status: string; parentId: string | null }) => item.workstreamId === 'system-bottom' && item.status !== 'done' && item.parentId === null);
    const child = { title: '新增执行子任务', description: '', workstreamId: 'system-bottom', parentId: parent.id, ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null };
    const converted = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/tasks', headers: writeHeaders(login), payload: { ...child, expectedPlanVersion: tasks.planVersion, confirmParentConversion: true, expectedParentVersion: parent.version } });
    expect(converted.statusCode, converted.body).toBe(200);
    const afterConversion = await workspace(login);
    expect(afterConversion.workstreams.find(item => item.id === 'system-bottom')!.taskCount).toBe(before.workstreams.find(item => item.id === 'system-bottom')!.taskCount + 1);

    const planBefore = db.prepare('SELECT version,nodes_json FROM plan_projects WHERE project_id=?').get('phase-one');
    const snapshotBefore = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get('phase-one');
    const jobsBefore = (db.prepare('SELECT count(*) AS n FROM background_jobs').get() as { n: number }).n;
    db.exec("CREATE TRIGGER reject_workstream_event BEFORE INSERT ON workstream_events BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    const failed = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login), payload: { expectedVersion: afterConversion.version, expectedPlanVersion: afterConversion.planVersion, reason: '验证事务回滚', workstream: { name: '不应保留', description: '', ownerId: null, color: 'green' } } });
    expect(failed.statusCode).toBe(500);
    expect(db.prepare('SELECT version,nodes_json FROM plan_projects WHERE project_id=?').get('phase-one')).toEqual(planBefore);
    expect(db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get('phase-one')).toEqual(snapshotBefore);
    expect((db.prepare("SELECT count(*) AS n FROM workstreams WHERE project_id='phase-one' AND name='不应保留'").get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM background_jobs').get() as { n: number }).n).toBe(jobsBefore);
  });

  test('requires coordinator handoff before deactivating a member and keeps legacy read-only permission enforcement', async () => {
    const login = await admin();
    db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES(?,?,?,?,1)').run('phase-one', 'coord-viewer', '协调观察员', 'viewer');
    db.prepare('INSERT INTO member_capacities VALUES(?,?,?)').run('phase-one', 'coord-viewer', JSON.stringify({ memberId: 'coord-viewer', hoursPerDay: null, exceptions: {} }));
    let current = await workspace(login);
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '指定协调负责人', workstream: { name: '协调分组', description: '', ownerId: 'coord-viewer', color: 'cyan' } } });
    expect(created.statusCode, created.body).toBe(200);
    current = created.json().data;
    const settings = (await app.inject({ url: '/api/v1/projects/phase-one/settings', headers: { cookie: login.cookie } })).json().data;
    const deactivate = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/settings/member_update', headers: writeHeaders(login), payload: { expectedVersion: settings.version, expectedPlanVersion: current.planVersion, reason: '成员离开项目', member: { id: 'coord-viewer', name: '协调观察员', role: 'viewer', active: false } } });
    expect(deactivate.statusCode).toBe(422);
    expect(deactivate.json().error.code).toBe('MEMBER_HAS_WORKSTREAMS');

    await app.close();
    app = buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0, testOnlyLegacyAuth: true });
    const view = await app.inject({ url: '/api/v1/projects/phase-one/workstreams', headers: { 'x-demo-actor': 'coord-viewer' } });
    const legacy = view.json().data;
    expect(legacy.canManage).toBe(false);
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: { 'x-demo-actor': 'coord-viewer', 'x-preview-token': legacy.writeToken, origin: 'http://localhost:5174', 'idempotency-key': randomUUID() }, payload: { expectedVersion: legacy.version, expectedPlanVersion: legacy.planVersion, reason: '越权请求', workstream: { name: '禁止新增', description: '', ownerId: null, color: 'blue' } } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('WORKSTREAMS_FORBIDDEN');
  });

  test('records the authenticated account id when it differs from the project member id', async () => {
    const adminLogin = await admin();
    const accountResponse = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: writeHeaders(adminLogin), payload: { username: 'workstream-manager', name: '分组负责人账号', systemRole: 'user', canCreateProjects: false } });
    expect(accountResponse.statusCode, accountResponse.body).toBe(200);
    const credential = accountResponse.json().data;
    const firstLoginResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'workstream-manager', password: credential.initialPassword } });
    const firstLogin: Login = { cookie: String(firstLoginResponse.headers['set-cookie']).split(';')[0]!, session: firstLoginResponse.json().data };
    const changedPassword = '工作分组成员新密码 2026';
    const passwordResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: writeHeaders(firstLogin), payload: { currentPassword: credential.initialPassword, newPassword: changedPassword } });
    const managerLogin: Login = { cookie: String(passwordResponse.headers['set-cookie']).split(';')[0]!, session: passwordResponse.json().data };

    const memberships = (await app.inject({ url: '/api/v1/projects/phase-one/memberships', headers: { cookie: adminLogin.cookie } })).json().data;
    const linked = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/memberships', headers: writeHeaders(adminLogin), payload: { expectedVersion: memberships.version, expectedPlanVersion: memberships.planVersion, userId: credential.user.id, role: 'manager', reason: '关联真实分组负责人账号' } });
    expect(linked.statusCode, linked.body).toBe(200);
    const memberId = linked.json().data.members.find((member: { userId?: string }) => member.userId === credential.user.id).id;
    expect(memberId).not.toBe(credential.user.id);

    const current = await workspace(managerLogin);
    const key = 'account-audit-id-check';
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(managerLogin, key), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '核对真实账号审计', workstream: { name: '账号审计分组', description: '', ownerId: null, color: 'slate' } } });
    expect(created.statusCode, created.body).toBe(200);
    expect(db.prepare('SELECT actor_id FROM workstream_events ORDER BY rowid DESC LIMIT 1').get()).toEqual({ actor_id: credential.user.id });
    expect(db.prepare('SELECT actor_id FROM workstream_idempotency WHERE project_id=? AND request_key=?').get('phase-one', key)).toEqual({ actor_id: credential.user.id });
  });

  test('refuses to restore a disabled workstream whose coordinator became inactive', async () => {
    const login = await admin();
    db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES(?,?,?,?,1)').run('phase-one', 'paused-owner', '暂停协调员', 'viewer');
    db.prepare('INSERT INTO member_capacities VALUES(?,?,?)').run('phase-one', 'paused-owner', JSON.stringify({ memberId: 'paused-owner', hoursPerDay: null, exceptions: {} }));
    let current = await workspace(login);
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/workstreams', headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '建立待暂停分组', workstream: { name: '待恢复分组', description: '', ownerId: 'paused-owner', color: 'orange' } } });
    current = created.json().data;
    const stream = current.workstreams.find((item: { name: string }) => item.name === '待恢复分组')!;
    const disabled = await app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/workstreams/${stream.id}/status`, headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '暂停分组', active: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    current = disabled.json().data;
    const settings = (await app.inject({ url: '/api/v1/projects/phase-one/settings', headers: { cookie: login.cookie } })).json().data;
    const memberDisabled = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/settings/member_update', headers: writeHeaders(login), payload: { expectedVersion: settings.version, expectedPlanVersion: current.planVersion, reason: '成员暂时离开', member: { id: 'paused-owner', name: '暂停协调员', role: 'viewer', active: false } } });
    expect(memberDisabled.statusCode, memberDisabled.body).toBe(200);

    current = await workspace(login);
    const restored = await app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/workstreams/${stream.id}/status`, headers: writeHeaders(login), payload: { expectedVersion: current.version, expectedPlanVersion: current.planVersion, reason: '尝试恢复分组', active: true } });
    expect(restored.statusCode).toBe(422);
    expect(restored.json().error.code).toBe('WORKSTREAM_OWNER_INACTIVE');
    expect((await workspace(login)).workstreams.find(item => item.id === stream.id)).toMatchObject({ active: false, ownerId: 'paused-owner' });
  });
});
