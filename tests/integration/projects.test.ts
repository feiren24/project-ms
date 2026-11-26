import { deliverNotification } from '../../server/src/modules/notifications/repository.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthSession, IssuedCredential } from '../../shared/src/auth.js';
import type { MembershipWorkspace, ProjectDirectory, ProjectInfo } from '../../shared/src/projects.js';

type Login = { cookie: string; session: AuthSession };
const password = '项目测试管理员密码 2026';
const changedPassword = '项目测试成员新密码 2026';

describe('multi-project directory, creation, profile and memberships', () => {
  let directory: string;
  let dbPath: string;
  let app: FastifyInstance;
  let db: Database.Database;
  let now: Date;

  const freshApp = () => buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-projects-'));
    dbPath = join(directory, 'projects.sqlite');
    now = new Date('2026-09-07T08:00:00Z');
    app = freshApp();
    db = new Database(dbPath);
  });
  afterEach(async () => {
    await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const headers = (login: Login, key: string = randomUUID()) => ({
    cookie: login.cookie,
    'x-csrf-token': login.session.csrfToken,
    origin: 'http://localhost:5174',
    'idempotency-key': key,
  });
  async function login(username: string, secret: string): Promise<Login> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: secret } });
    expect(response.statusCode, response.body).toBe(200);
    return { cookie: String(response.headers['set-cookie']).split(';')[0]!, session: response.json().data };
  }
  async function bootstrap(): Promise<Login> {
    await createInitialAdmin(db, { username: 'admin', name: '实名管理员', password }, now);
    return login('admin', password);
  }
  async function createAccount(admin: Login, username: string, canCreateProjects = false): Promise<{ credential: IssuedCredential; login: Login }> {
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(admin), payload: { username, name: `账号 ${username}`, systemRole: 'user', canCreateProjects } });
    expect(created.statusCode, created.body).toBe(200);
    const credential = created.json().data as IssuedCredential;
    const first = await login(username, credential.initialPassword);
    const changed = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: headers(first), payload: { currentPassword: credential.initialPassword, newPassword: changedPassword } });
    expect(changed.statusCode, changed.body).toBe(200);
    return { credential, login: { cookie: String(changed.headers['set-cookie']).split(';')[0]!, session: changed.json().data } };
  }
  async function createProject(login: Login, name = '空白交付项目', key: string = randomUUID()): Promise<ProjectInfo> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(login, key), payload: { name, goal: '按计划完成真实项目交付', start: '2026-10-01', end: '2026-12-31' } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data;
  }

  test('project edits and ordinary membership omit reasons while privileged membership and removal require them', async () => {
    const admin = await bootstrap(), project = await createProject(admin);
    const member = await createAccount(admin, 'reason.member');
    const prefix = `/api/v1/projects/${project.id}`;
    const read = async () => (await app.inject({url:prefix+'/memberships',headers:headers(admin)})).json().data as MembershipWorkspace;
    let w=await read();
    const edited=await app.inject({method:'PATCH',url:prefix,headers:headers(admin),payload:{expectedVersion:project.version,expectedPlanVersion:w.planVersion,name:'更新后的项目',goal:project.goal,start:project.start,end:project.end}});
    expect(edited.statusCode,edited.body).toBe(200);w=await read();
    for(const role of ['manager','project_admin']) {
      const forbidden=await app.inject({method:'POST',url:prefix+'/memberships',headers:headers(admin),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,userId:member.credential.user.id,role}});
      expect(forbidden.statusCode,forbidden.body).toBe(422);expect(forbidden.json().error.code).toBe('REASON_REQUIRED');
    }
    const added=await app.inject({method:'POST',url:prefix+'/memberships',headers:headers(admin),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,userId:member.credential.user.id,role:'member'}});
    expect(added.statusCode,added.body).toBe(200);w=added.json().data;
    const activityFeed = (await app.inject({url:prefix+'/activities',headers:{cookie:admin.cookie}})).json().data;
    expect(activityFeed.items.map((item:{type:string})=>item.type).sort()).toEqual(['member.join','project.create']);
    const target=w.members.find(m=>m.userId===member.credential.user.id)!;
    const removal=await app.inject({method:'POST',url:prefix+`/memberships/${target.id}/remove`,headers:headers(admin),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion}});
    expect(removal.statusCode,removal.body).toBe(422);expect(removal.json().error.code).toBe('REASON_REQUIRED');
  });

  test('normalizes project nature across every workspace without rewriting legacy snapshots or provenance', async () => {
    const admin = await bootstrap();
    const project = await createProject(admin);
    const row = () => db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(project.id) as { snapshot_json: string };
    const legacy = JSON.parse(row().snapshot_json);
    delete legacy.project.isDemo;
    legacy.mode = 'demo'; legacy.project.sourceLabel = 'DEMO · 新建空白项目，仅保存本机演示数据';
    db.prepare('UPDATE homepage_projects SET snapshot_json=? WHERE id=?').run(JSON.stringify(legacy), project.id);
    const stored = row();
    const baselineBefore = db.prepare("SELECT snapshot_json FROM plan_baselines WHERE project_id='phase-one'").all();
    const endpoints = ['overview', 'gantt', 'tasks', 'settings', 'risks', 'analytics', 'notifications', 'workstreams'];
    for (const [id, isDemo] of [[project.id, false], ['phase-one', true]] as const) for (const endpoint of endpoints) {
      const response = await app.inject({ url: `/api/v1/projects/${id}/${endpoint}`, headers: { cookie: admin.cookie } });
      expect(response.statusCode, `${endpoint}: ${response.body}`).toBe(200);
      expect(response.json().data).toMatchObject({ mode: isDemo ? 'demo' : 'standard', project: { id, isDemo } });
    }
    expect(row()).toEqual(stored);
    expect(db.prepare("SELECT snapshot_json FROM plan_baselines WHERE project_id='phase-one'").all()).toEqual(baselineBefore);
    expect((await app.inject({ url: `/api/v1/projects/${project.id}`, headers: { cookie: admin.cookie } })).json().data.isDemo).toBe(false);
    // Invalid non-boolean values are absent metadata, not truthy overrides.
    legacy.project.isDemo = 'true';
    db.prepare('UPDATE homepage_projects SET snapshot_json=? WHERE id=?').run(JSON.stringify(legacy), project.id);
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/overview`, headers: { cookie: admin.cookie } })).json().data.project.isDemo).toBe(false);
    legacy.project.isDemo = true;
    db.prepare('UPDATE homepage_projects SET snapshot_json=? WHERE id=?').run(JSON.stringify(legacy), project.id);
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/overview`, headers: { cookie: admin.cookie } })).json().data.mode).toBe('demo');
    const seed = JSON.parse((db.prepare("SELECT snapshot_json FROM homepage_projects WHERE id='phase-one'").get() as {snapshot_json:string}).snapshot_json);
    seed.project.isDemo = false;
    db.prepare("UPDATE homepage_projects SET snapshot_json=? WHERE id='phase-one'").run(JSON.stringify(seed));
    expect((await app.inject({ url: '/api/v1/projects/phase-one/overview', headers: { cookie: admin.cookie } })).json().data).toMatchObject({ mode: 'standard', project: { isDemo: false } });
  });

  test('retains standard metadata after task and plan writes and preserves user DEMO text in histories and notifications', async () => {
    const admin = await bootstrap(); const project = await createProject(admin);
    const prefix = `/api/v1/projects/${project.id}`;
    const get = async (path: string) => { const response = await app.inject({ url: `${prefix}/${path}`, headers: { cookie: admin.cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json().data; };
    const post = async (path: string, payload: object) => { const response = await app.inject({ method: 'POST', url: `${prefix}/${path}`, headers: headers(admin), payload }); expect(response.statusCode, response.body).toBe(200); return response.json().data; };
    const initial = await get('tasks');
    const created = await post('tasks', { title: 'DEMO · 用户任务名称', description: 'DEMO · 用户原文', workstreamId: 'general', parentId: null, ownerId: admin.session.user!.id, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-10-01', end: '2026-10-01', expectedPlanVersion: initial.planVersion });
    expect(created.task.events.at(-1).text).toBe('新建本地任务。');
    expect(await get('tasks')).toMatchObject({ mode: 'standard', project: { isDemo: false } });
    const userText = 'DEMO · 用户明确要求保留的原文';
    const commented = await post(`tasks/${created.task.id}/comments`, { expectedVersion: created.task.version, expectedPlanVersion: created.planVersion, text: userText });
    expect(commented.task.events.at(-1).text).toBe(userText);
    const preview = await post('schedule/preview', { expectedPlanVersion: commented.planVersion, reason: userText, changes: [{ taskId: created.task.id, start: '2026-10-02', end: '2026-10-02' }], mode: 'push_successors' });
    await post('schedule/apply', { previewId: preview.id, expectedPlanVersion: preview.basePlanVersion });
    const plan = await get('gantt');
    expect(plan).toMatchObject({ mode: 'standard', project: { isDemo: false } });
    expect(plan.history[0]).toMatchObject({ action: '应用计划调整', reason: userText });
    const baseline = await post('baselines', { expectedPlanVersion: plan.planVersion, name: userText, reason: userText, calendarConfirmed: true, excludedIds: [], exclusionReason: '' });
    expect(baseline).toMatchObject({ demo: false, name: userText, reason: userText });
    const overview = await get('overview');
    expect(overview).toMatchObject({ mode: 'standard', project: { isDemo: false } });
    expect(overview.project.sourceLabel).not.toMatch(/DEMO|示例|演示/);
    const persisted = JSON.parse((db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(project.id) as {snapshot_json:string}).snapshot_json);
    expect(persisted).toMatchObject({ mode: 'standard', project: { isDemo: false, sourceLabel: overview.project.sourceLabel } });
    const analytics = await get('analytics');
    expect(analytics.warnings.join(' ')).not.toMatch(/DEMO|示例/);
    expect(analytics.metrics.milestoneAchievement.description).toContain('旧无凭证完成项不计正式达成');
    expect(analytics.metrics.milestoneAchievement.description).not.toContain('示例');
    const jobs = db.prepare("SELECT payload_json FROM background_jobs WHERE project_id=? AND kind='notification'").all(project.id) as {payload_json:string}[];
    for (const job of jobs) deliverNotification(db, project.id, JSON.parse(job.payload_json), now);
    const notifications = await get('notifications');
    expect(notifications.notifications.some((item: {message:string}) => item.message === `实名管理员：${userText}`)).toBe(true);
    expect(notifications.notifications.every((item: {message:string}) => !item.message.startsWith('DEMO · '))).toBe(true);
    expect((await get('tasks')).tasks[0]).toMatchObject({ title: 'DEMO · 用户任务名称', description: 'DEMO · 用户原文' });
  });

  test('projects only a known legacy notification outer wrapper and never edits its stored record or inner user content', async () => {
    const admin = await bootstrap(); const project = await createProject(admin);
    const insert = (id: string, eventKey: string, formatVersion?: number) => {
      const notification = { id, recipientId: admin.session.user!.id, kind: 'task.comment', title: 'DEMO · 用户标题', message: 'DEMO · 实名管理员：DEMO · 用户原文', createdAt: now.toISOString(), readAt: null, target: { kind: 'task', id: 'test-task' }, ...(formatVersion ? { formatVersion } : {}) };
      db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,NULL)').run(id, project.id, admin.session.user!.id, eventKey, JSON.stringify(notification));
    };
    insert('known-old', 'task:test-task:old-event'); insert('unknown-old', 'unrecognized-source'); insert('current-format', 'task:test-task:current-event', 1);
    const before = db.prepare('SELECT * FROM notifications WHERE project_id=? ORDER BY id').all(project.id);
    const response = await app.inject({ url: `/api/v1/projects/${project.id}/notifications`, headers: { cookie: admin.cookie } });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().data.notifications;
    expect(items.find((item: {id:string}) => item.id === 'known-old')).toMatchObject({ title: 'DEMO · 用户标题', message: '实名管理员：DEMO · 用户原文' });
    for (const id of ['unknown-old', 'current-format']) expect(items.find((item: {id:string}) => item.id === id).message).toBe('DEMO · 实名管理员：DEMO · 用户原文');
    expect(db.prepare('SELECT * FROM notifications WHERE project_id=? ORDER BY id').all(project.id)).toEqual(before);
  });

  test('requires authentication and explicit create permission while keeping unlinked users in an empty directory', async () => {
    expect((await app.inject('/api/v1/projects')).statusCode).toBe(401);
    const admin = await bootstrap();
    const ordinary = await createAccount(admin, 'ordinary');
    const directoryResponse = await app.inject({ url: '/api/v1/projects', headers: { cookie: ordinary.login.cookie } });
    expect(directoryResponse.statusCode, directoryResponse.body).toBe(200);
    expect(directoryResponse.json().data as ProjectDirectory).toEqual({ projects: [], canCreate: false });
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(ordinary.login), payload: { name: '禁止创建', goal: '无权限', start: '2026-10-01', end: '2026-11-01' } })).statusCode).toBe(403);
    const creator = await createAccount(admin, 'creator', true);
    expect((await app.inject({ url: '/api/v1/projects', headers: { cookie: creator.login.cookie } })).json().data.canCreate).toBe(true);
  });

  test('creates one transactionally complete blank project, replays idempotently, and remains blank after restart', async () => {
    const admin = await bootstrap();
    const key = 'create-project-once';
    const project = await createProject(admin, '新项目 A', key);
    expect(project).toMatchObject({ name: '新项目 A', goal: '按计划完成真实项目交付', version: 1, memberId: admin.session.user!.id, role: 'manager', isDemo: false });
    expect(project.id).toMatch(/^[A-Za-z0-9_-]+$/);
    const replay = await createProject(admin, '新项目 A', key);
    expect(replay).toEqual(project);
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(admin, key), payload: { name: '冲突项目', goal: '不同请求', start: '2026-10-01', end: '2026-12-31' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((db.prepare('SELECT count(*) AS n FROM homepage_projects WHERE id=?').get(project.id) as { n: number }).n).toBe(1);
    const [overview, tasks, plan, risks, settings, memberships, analytics, notifications] = await Promise.all([
      app.inject({ url: `/api/v1/projects/${project.id}/overview`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/tasks`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/gantt`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/risks`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/settings`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/memberships`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/analytics`, headers: { cookie: admin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/notifications`, headers: { cookie: admin.cookie } }),
    ]);
    for (const response of [overview, tasks, plan, risks, settings, memberships, analytics, notifications]) expect(response.statusCode, response.body).toBe(200);
    expect(overview.json().data.project.asOf).toBe('2026-09-07');
    expect(overview.json().data.summary.totalTasks).toBe(0);
    expect(tasks.json().data.tasks).toEqual([]);
    expect(plan.json().data.nodes).toMatchObject([{ kind: 'group', title: '通用工作' }]);
    expect(plan.json().data.baselines).toEqual([]);
    expect(risks.json().data.risks).toEqual([]);
    expect(analytics.json().data.counts.total).toBe(0);
    expect(analytics.json().data.personnel.summary.counts.total).toBe(0);
    expect(analytics.json().data.personnel.tasks).toEqual([]);
    expect(notifications.json().data.notifications).toEqual([]);
    expect(settings.json().data.members).toMatchObject([{ id: admin.session.user!.id, name: '实名管理员', role: 'manager', active: true, userId: admin.session.user!.id, username: 'admin', accountActive: true }]);
    expect(tasks.json().data.actors).toContainEqual({ id: admin.session.user!.id, name: '实名管理员', role: 'manager' });
    expect((db.prepare('SELECT count(*) AS n FROM background_job_schedules WHERE project_id=?').get(project.id) as { n: number }).n).toBe(3);
    await app.close();
    app = freshApp();
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/tasks`, headers: { cookie: admin.cookie } })).json().data.tasks).toEqual([]);
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/risks`, headers: { cookie: admin.cookie } })).json().data.risks).toEqual([]);
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/gantt`, headers: { cookie: admin.cookie } })).json().data.baselines).toEqual([]);
  });

  test('strictly validates project creation and rolls back every dependent row on failure', async () => {
    const admin = await bootstrap();
    for (const payload of [
      { name: '', goal: '目标', start: '2026-10-01', end: '2026-11-01' },
      { name: '项目', goal: '', start: '2026-10-01', end: '2026-11-01' },
      { name: '项目', goal: '目标', start: '2026-02-30', end: '2026-11-01' },
      { name: '项目', goal: '目标', start: '2026-12-01', end: '2026-11-01' },
      { name: '项目', goal: '目标', start: '2026-10-01', end: '2026-11-01', extra: true },
    ]) expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(admin), payload })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(admin, 'short'), payload: { name: '项目', goal: '目标', start: '2026-10-01', end: '2026-11-01' } })).statusCode).toBe(422);
    const longGoal = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(admin, 'valid-long-goal'), payload: { name: '允许完整目标', goal: '目标'.repeat(1000), start: '2026-10-01', end: '2026-11-01' } });
    expect(longGoal.statusCode, longGoal.body).toBe(200);
    db.exec("CREATE TRIGGER reject_project_link BEFORE INSERT ON project_user_links BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    const before = (db.prepare('SELECT count(*) AS n FROM homepage_projects').get() as { n: number }).n;
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(admin, 'transaction-failure'), payload: { name: '回滚项目', goal: '核对完整回滚', start: '2026-10-01', end: '2026-11-01' } })).statusCode).toBe(500);
    expect((db.prepare('SELECT count(*) AS n FROM homepage_projects').get() as { n: number }).n).toBe(before);
    expect((db.prepare("SELECT count(*) AS n FROM project_events WHERE json_extract(snapshot_json,'$.name')='回滚项目'").get() as { n: number }).n).toBe(0);
  });

  test('updates project profile with version/date guards, audit and project-scoped idempotency', async () => {
    const admin = await bootstrap();
    const first = await createProject(admin, '项目 A');
    const second = await createProject(admin, '项目 B');
    const key = 'same-key-different-project';
    const update = async (project: ProjectInfo, name: string, overrides: object = {}) => app.inject({ method: 'PATCH', url: `/api/v1/projects/${project.id}`, headers: headers(admin, key), payload: { expectedVersion: project.version, expectedPlanVersion: 1, name, goal: project.goal, start: project.start, end: project.end, reason: '核对项目资料', ...overrides } });
    const a = await update(first, '项目 A 已更新');
    const b = await update(second, '项目 B 已更新');
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(a.json().data).toMatchObject({ version: 2, name: '项目 A 已更新' });
    expect((await update(first, '项目 A 已更新')).json()).toEqual(a.json());
    expect((await update(first, '另一个名称')).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const stale = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${first.id}`, headers: headers(admin), payload: { expectedVersion: 99, expectedPlanVersion: 2, name: '过期版本', goal: first.goal, start: first.start, end: first.end, reason: '核对过期版本' } });
    expect(stale.json().error.code).toBe('PROJECT_VERSION_CONFLICT');
    expect((db.prepare('SELECT count(*) AS n FROM project_events WHERE project_id=? AND action=?').get(first.id, 'project_update') as { n: number }).n).toBe(1);
    const baselineCount = (db.prepare('SELECT count(*) AS n FROM plan_baselines WHERE project_id=?').get(first.id) as { n: number }).n;
    expect(baselineCount).toBe(0);
    const demo = (await app.inject({ url: '/api/v1/projects/phase-one', headers: { cookie: admin.cookie } })).json().data as ProjectInfo;
    const blocked = await app.inject({ method: 'PATCH', url: '/api/v1/projects/phase-one', headers: headers(admin), payload: { expectedVersion: demo.version, expectedPlanVersion: 1, name: demo.name, goal: demo.goal, start: '2026-10-01', end: demo.end, reason: '缩短日期' } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('PROJECT_DATE_CONFLICT');
  });

  test('adds enabled accounts, denies member-directory access to non-managers, and preserves explicit legacy member identity', async () => {
    const admin = await bootstrap();
    const managerAccount = await createAccount(admin, 'manager');
    const workerAccount = await createAccount(admin, 'worker');
    const project = await createProject(admin);
    const getWorkspace = async (login: Login) => {
      const response = await app.inject({ url: `/api/v1/projects/${project.id}/memberships`, headers: { cookie: login.cookie } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().data as MembershipWorkspace;
    };
    const add = async (workspace: MembershipWorkspace, userId: string, role: string, legacyMemberId?: string, login = admin, key: string = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/memberships`, headers: headers(login, key), payload: { expectedVersion: workspace.version, expectedPlanVersion: workspace.planVersion, userId, role, ...(legacyMemberId ? { legacyMemberId } : {}), reason: '确认添加真实账号' } });
    let workspace = await getWorkspace(admin);
    const managerKey = 'membership-manager-once';
    const managerAdded = await add(workspace, managerAccount.credential.user.id, 'manager', undefined, admin, managerKey);
    expect(managerAdded.statusCode, managerAdded.body).toBe(200);
    const managerReplay = await add(workspace, managerAccount.credential.user.id, 'manager', undefined, admin, managerKey);
    expect(managerReplay.json()).toEqual(managerAdded.json());
    const managerConflict = await add(workspace, managerAccount.credential.user.id, 'viewer', undefined, admin, managerKey);
    expect(managerConflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    workspace = managerAdded.json().data;
    const managerSession = (await app.inject({ url: '/api/v1/auth/session', headers: { cookie: managerAccount.login.cookie } })).json().data;
    managerAccount.login.session = managerSession;
    const managerView = await getWorkspace(managerAccount.login);
    expect(managerView.canManage).toBe(true);
    expect(managerView.accounts.some(account => account.id === workerAccount.credential.user.id)).toBe(true);
    const memberAdded = await add(managerView, workerAccount.credential.user.id, 'member', undefined, managerAccount.login);
    expect(memberAdded.statusCode, memberAdded.body).toBe(200);
    const workerSession = (await app.inject({ url: '/api/v1/auth/session', headers: { cookie: workerAccount.login.cookie } })).json().data;
    workerAccount.login.session = workerSession;
    const workerView = await app.inject({ url: `/api/v1/projects/${project.id}/memberships`, headers: { cookie: workerAccount.login.cookie } });
    expect(workerView.statusCode).toBe(403);
    expect(workerView.json().data).toBeUndefined();
    const taskDirectory = await app.inject({ url: `/api/v1/projects/${project.id}/tasks/options`, headers: { cookie: workerAccount.login.cookie } });
    expect(taskDirectory.statusCode).toBe(200);
    expect(taskDirectory.json().data.actors.some((actor: { id: string }) => actor.id === memberAdded.json().data.members.find((member: { userId?: string }) => member.userId === workerAccount.credential.user.id).id)).toBe(true);

    const legacyUser = await createAccount(admin, 'legacy');
    db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES (?,?,?,?,?)').run(project.id, 'legacy-reviewer', '旧验收角色', 'member', 1);
    db.prepare('INSERT INTO member_capacities VALUES (?,?,?)').run(project.id, 'legacy-reviewer', JSON.stringify({ memberId: 'legacy-reviewer', hoursPerDay: null, exceptions: {} }));
    db.prepare('UPDATE auth_users SET name=? WHERE id=?').run('旧验收角色', legacyUser.credential.user.id);
    workspace = await getWorkspace(admin);
    const ambiguous = await add(workspace, legacyUser.credential.user.id, 'member');
    expect(ambiguous.json().error).toMatchObject({ code: 'LEGACY_MEMBER_MATCH_REQUIRED' });
    expect(ambiguous.json().error.message).toContain('系统管理员');
    const mismatch = await add(workspace, legacyUser.credential.user.id, 'viewer', 'legacy-reviewer');
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('LEGACY_ROLE_MISMATCH');
    const linked = await add(workspace, legacyUser.credential.user.id, 'member', 'legacy-reviewer');
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().data.members.find((member: { id: string }) => member.id === 'legacy-reviewer')).toMatchObject({ role: 'member', userId: legacyUser.credential.user.id, username: 'legacy', accountActive: true });
    const nextWorkspace = linked.json().data as MembershipWorkspace;
    expect((await add(nextWorkspace, legacyUser.credential.user.id, 'member')).json().error.code).toBe('ACCOUNT_ALREADY_LINKED');
    const collision = await createAccount(admin, 'same-name');
    db.prepare('UPDATE auth_users SET name=? WHERE id=?').run('旧验收角色', collision.credential.user.id);
    const nameConflict = await add(nextWorkspace, collision.credential.user.id, 'member');
    expect(nameConflict.json().error).toMatchObject({ code: 'ACCOUNT_NAME_CONFLICT' });
    expect(nameConflict.json().error.message).toContain('显示姓名');
    expect((await add(nextWorkspace, legacyUser.credential.user.id, 'member', 'legacy-reviewer', managerAccount.login)).json().error.code).toBe('LEGACY_LINK_ADMIN_REQUIRED');
  });

  test('projects current non-demo observation date across overview, tasks, analytics and risks without persisting a read', async () => {
    const admin = await bootstrap();
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: headers(admin), payload: { name: '跨日项目', goal: '核对动态观察日', start: '2026-09-01', end: '2026-09-30' } });
    expect(created.statusCode, created.body).toBe(200);
    const project = created.json().data as ProjectInfo;
    const tasksBefore = (await app.inject({ url: `/api/v1/projects/${project.id}/tasks`, headers: { cookie: admin.cookie } })).json().data;
    const task = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/tasks`, headers: headers(admin), payload: { title: '跨日逾期任务', description: '', workstreamId: 'general', parentId: null, ownerId: admin.session.user!.id, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-09-07', end: '2026-09-08', expectedPlanVersion: tasksBefore.planVersion } });
    expect(task.statusCode, task.body).toBe(200);
    const storedBefore = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(project.id) as { snapshot_json: string };
    const settingsVersion = (db.prepare('SELECT version FROM settings_projects WHERE project_id=?').get(project.id) as { version: number }).version;
    const planVersion = (db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get(project.id) as { version: number }).version;
    now = new Date('2026-09-09T08:00:00Z');
    const currentAdmin = await login('admin', password);
    const [overview, tasks, analytics, risks, demo] = await Promise.all([
      app.inject({ url: `/api/v1/projects/${project.id}/overview`, headers: { cookie: currentAdmin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/tasks`, headers: { cookie: currentAdmin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/analytics`, headers: { cookie: currentAdmin.cookie } }),
      app.inject({ url: `/api/v1/projects/${project.id}/risks`, headers: { cookie: currentAdmin.cookie } }),
      app.inject({ url: '/api/v1/projects/phase-one/overview', headers: { cookie: currentAdmin.cookie } }),
    ]);
    for (const response of [overview, tasks, analytics, risks, demo]) expect(response.statusCode, response.body).toBe(200);
    expect(overview.json().data.project.asOf).toBe('2026-09-09');
    expect(overview.json().data.summary.overdueTasks).toBe(1);
    expect(tasks.json().data.project.asOf).toBe('2026-09-09');
    expect(analytics.json().data).toMatchObject({ dataAsOf: '2026-09-09', counts: { overdue: 1 } });
    expect(analytics.json().data.personnel.summary.metrics.overdue.numerator).toBe(1);
    expect(risks.json().data).toMatchObject({ project: { asOf: '2026-09-09' }, today: '2026-09-09' });
    expect(demo.json().data.project.asOf).toBe('2026-09-21');
    expect(db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(project.id)).toEqual(storedBefore);
    expect(db.prepare('SELECT version FROM settings_projects WHERE project_id=?').get(project.id)).toEqual({ version: settingsVersion });
    expect(db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get(project.id)).toEqual({ version: planVersion });
  });

  test('records the authenticated account name for both risk and nested response-task events after legacy linking', async () => {
    const admin = await bootstrap();
    const legacyAccount = await createAccount(admin, 'legacy-manager');
    const project = await createProject(admin, '实名审计项目');
    db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES (?,?,?,?,?)').run(project.id, 'legacy-manager-id', '旧负责人姓名', 'manager', 1);
    db.prepare('INSERT INTO member_capacities VALUES (?,?,?)').run(project.id, 'legacy-manager-id', JSON.stringify({ memberId: 'legacy-manager-id', hoursPerDay: null, exceptions: {} }));
    let membership = (await app.inject({ url: `/api/v1/projects/${project.id}/memberships`, headers: { cookie: admin.cookie } })).json().data as MembershipWorkspace;
    const linked = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/memberships`, headers: headers(admin), payload: { expectedVersion: membership.version, expectedPlanVersion: membership.planVersion, userId: legacyAccount.credential.user.id, role: 'manager', legacyMemberId: 'legacy-manager-id', reason: '明确绑定旧负责人' } });
    expect(linked.statusCode, linked.body).toBe(200);
    legacyAccount.login.session = (await app.inject({ url: '/api/v1/auth/session', headers: { cookie: legacyAccount.login.cookie } })).json().data;
    const risk = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/risks`, headers: headers(legacyAccount.login), payload: { title: '需创建应对任务', description: '', workstreamId: 'general', ownerId: 'legacy-manager-id', probability: 2, impact: 3, due: '2026-11-01', reviewDate: null, response: '', taskIds: [], closeReviewerId: null } });
    expect(risk.statusCode, risk.body).toBe(200);
    const data = risk.json().data;
    const action = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/risks/${data.risk.id}/actions/create`, headers: headers(legacyAccount.login), payload: { expectedVersion: data.risk.version, expectedPlanVersion: data.planVersion, draft: { title: '实名应对任务', description: '', workstreamId: 'general', parentId: null, ownerId: 'legacy-manager-id', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null } } });
    expect(action.statusCode, action.body).toBe(200);
    expect(action.json().data.risk.events.at(-1).actor).toBe('账号 legacy-manager');
    expect(action.json().data.task.events.at(-1).actor).toBe('账号 legacy-manager');
  });

  test('uses a linked administrator member for assignment with effective manager authority while preserving its stored membership role', async () => {
    const admin = await bootstrap();
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'lin', admin.session.user!.id);
    const session = (await app.inject({ url: '/api/v1/auth/session', headers: { cookie: admin.cookie } })).json().data as AuthSession;
    expect(session.projects.find(project => project.id === 'phase-one')).toMatchObject({ memberId: 'lin', role: 'manager' });
    const tasks = (await app.inject({ url: '/api/v1/projects/phase-one/tasks', headers: { cookie: admin.cookie } })).json().data;
    expect(tasks.actors.filter((actor: { id: string }) => actor.id === 'lin')).toEqual([{ id: 'lin', name: '林若宁', role: 'manager' }]);
    expect(db.prepare("SELECT role FROM project_members WHERE project_id='phase-one' AND id='lin'").get()).toEqual({ role: 'member' });
    expect(tasks.actors.some((actor: { id: string }) => actor.id === admin.session.user!.id)).toBe(false);
    const settings = (await app.inject({ url: '/api/v1/projects/phase-one/settings', headers: { cookie: admin.cookie } })).json().data;
    const changed = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/settings/calendar', headers: headers(admin), payload: { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '实名管理员确认日历', calendar: { ...settings.calendar, confirmed: true } } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().data.events[0].actor).toBe('实名管理员');
    const currentTasks = (await app.inject({ url: '/api/v1/projects/phase-one/tasks', headers: { cookie: admin.cookie } })).json().data;
    const task = currentTasks.tasks.find((item: { id: string }) => item.id === 'task-006');
    const comment = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/tasks/task-006/comments', headers: headers(admin), payload: { expectedVersion: task.version, expectedPlanVersion: currentTasks.planVersion, text: '实名管理员补充说明' } });
    expect(comment.statusCode, comment.body).toBe(200);
    expect(comment.json().data.task.events.at(-1).actor).toBe('实名管理员');
  });

  test('falls back to a nonassignable administrator identity when its linked project member is inactive', async () => {
    const admin = await bootstrap();
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'lin', admin.session.user!.id);
    db.prepare("UPDATE project_members SET active=0 WHERE project_id='phase-one' AND id='lin'").run();

    const session = (await app.inject({ url: '/api/v1/auth/session', headers: { cookie: admin.cookie } })).json().data as AuthSession;
    expect(session.projects.find(project => project.id === 'phase-one')).toMatchObject({ memberId: admin.session.user!.id, role: 'manager' });

    const settingsResponse = await app.inject({ url: '/api/v1/projects/phase-one/settings', headers: { cookie: admin.cookie } });
    expect(settingsResponse.statusCode, settingsResponse.body).toBe(200);
    const settings = settingsResponse.json().data;
    expect(settings.members.find((member: { id: string }) => member.id === 'lin')).toMatchObject({ active: false, userId: admin.session.user!.id });
    expect(settings.actors).toContainEqual({ id: admin.session.user!.id, name: '实名管理员', role: 'manager', assignable: false });
    expect(settings.actors.some((actor: { id: string }) => actor.id === 'lin')).toBe(false);

    const changed = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/settings/calendar', headers: headers(admin), payload: { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '停用关联成员后仍由全局管理员管理', calendar: { ...settings.calendar, confirmed: !settings.calendar.confirmed } } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().data.events[0].actor).toBe('实名管理员');

    const tasks = (await app.inject({ url: '/api/v1/projects/phase-one/tasks', headers: { cookie: admin.cookie } })).json().data;
    const assignment = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/tasks', headers: headers(admin), payload: { title: '禁止分配给系统管理员身份', description: '', workstreamId: tasks.workstreams[0].id, parentId: null, ownerId: admin.session.user!.id, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null, expectedPlanVersion: tasks.planVersion } });
    expect(assignment.statusCode, assignment.body).toBe(422);
    expect(assignment.json().error.code).toBe('INVALID_OWNER');
  });

  test('rejects disabled accounts, unauthorized legacy linking, cross-project access and real-mode synthetic members', async () => {
    const admin = await bootstrap();
    const member = await createAccount(admin, 'member');
    const outsider = await createAccount(admin, 'outsider');
    const project = await createProject(admin);
    const workspace = (await app.inject({ url: `/api/v1/projects/${project.id}/memberships`, headers: { cookie: admin.cookie } })).json().data as MembershipWorkspace;
    db.prepare('UPDATE auth_users SET active=0 WHERE id=?').run(member.credential.user.id);
    const disabled = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/memberships`, headers: headers(admin), payload: { expectedVersion: workspace.version, expectedPlanVersion: workspace.planVersion, userId: member.credential.user.id, role: 'member', reason: '尝试添加停用账号' } });
    expect(disabled.statusCode).toBe(422);
    expect(disabled.json().error.code).toBe('ACCOUNT_INACTIVE');
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/tasks`, headers: { cookie: outsider.login.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/analytics`, headers: { cookie: outsider.login.cookie } })).statusCode).toBe(404);
    const settings = (await app.inject({ url: `/api/v1/projects/${project.id}/settings`, headers: { cookie: admin.cookie } })).json().data;
    const synthetic = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/settings/member_create`, headers: headers(admin), payload: { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '尝试创建虚构成员', member: { name: '虚构成员', role: 'member', active: true } } });
    expect(synthetic.statusCode).toBe(422);
    expect(synthetic.json().error.code).toBe('ACCOUNT_LINK_REQUIRED');
    expect(settings.project.isDemo).toBe(false);
    const invalidName = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/settings/member_update`, headers: headers(admin), payload: { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '校验成员姓名', member: { id: admin.session.user!.id, name: '   ', role: 'manager', active: true } } });
    expect(invalidName.statusCode).toBe(422);
    expect(invalidName.json().error).toMatchObject({ code: 'INVALID_TEXT', message: '成员姓名必填且最多 60 字。' });
    const deactivateCreator = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/settings/member_update`, headers: headers(admin), payload: { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '尝试停用最后负责人', member: { id: admin.session.user!.id, name: '实名管理员', role: 'manager', active: false } } });
    expect(deactivateCreator.json().error.code).toBe('LAST_MANAGER_REQUIRED');
  });

  test('isolates task, risk and receipt identifiers across two projects', async () => {
    const admin = await bootstrap();
    const a = await createProject(admin, '隔离项目 A');
    const b = await createProject(admin, '隔离项目 B');
    const taskKey = 'same-task-key-projects';
    const taskPayload = (planVersion: number, title: string) => ({ title, description: '', workstreamId: 'general', parentId: null, ownerId: admin.session.user!.id, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null, expectedPlanVersion: planVersion });
    const aTasks = (await app.inject({ url: `/api/v1/projects/${a.id}/tasks`, headers: { cookie: admin.cookie } })).json().data;
    const bTasks = (await app.inject({ url: `/api/v1/projects/${b.id}/tasks`, headers: { cookie: admin.cookie } })).json().data;
    const taskA = await app.inject({ method: 'POST', url: `/api/v1/projects/${a.id}/tasks`, headers: headers(admin, taskKey), payload: taskPayload(aTasks.planVersion, 'A 项目任务') });
    const taskB = await app.inject({ method: 'POST', url: `/api/v1/projects/${b.id}/tasks`, headers: headers(admin, taskKey), payload: taskPayload(bTasks.planVersion, 'B 项目任务') });
    expect(taskA.statusCode, taskA.body).toBe(200);
    expect(taskB.statusCode, taskB.body).toBe(200);
    const foreignTask = await app.inject({ method: 'POST', url: `/api/v1/projects/${b.id}/tasks/${taskA.json().data.task.id}/comments`, headers: headers(admin), payload: { expectedVersion: taskA.json().data.task.version, expectedPlanVersion: taskB.json().data.planVersion, text: '跨项目写入' } });
    expect(foreignTask.statusCode).toBe(404);

    const riskPayload = { title: 'A 项目风险', description: '', workstreamId: 'general', ownerId: admin.session.user!.id, probability: 2, impact: 2, due: '2026-11-01', reviewDate: null, response: '', taskIds: [], closeReviewerId: null };
    const riskA = await app.inject({ method: 'POST', url: `/api/v1/projects/${a.id}/risks`, headers: headers(admin), payload: riskPayload });
    expect(riskA.statusCode, riskA.body).toBe(200);
    const foreignRisk = await app.inject({ method: 'POST', url: `/api/v1/projects/${b.id}/risks/${riskA.json().data.risk.id}/transition`, headers: headers(admin), payload: { expectedVersion: riskA.json().data.risk.version, action: 'assess', reason: '跨项目写入' } });
    expect(foreignRisk.statusCode).toBe(404);
    expect((db.prepare('SELECT count(*) AS n FROM homepage_tasks WHERE id=? AND project_id=?').get(taskA.json().data.task.id, b.id) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM risk_records WHERE id=? AND project_id=?').get(riskA.json().data.risk.id, b.id) as { n: number }).n).toBe(0);
  });
  test('removes membership logically with current versions, audit, history retention and explicit same-account restoration', async () => {
    const admin = await bootstrap(); const project = await createProject(admin);
    const account = await createAccount(admin, 'remove-me');
    const url = `/api/v1/projects/${project.id}`;
    const members = async () => (await app.inject({ url: `${url}/memberships`, headers: { cookie: admin.cookie } })).json().data as MembershipWorkspace;
    let w = await members();
    const added = await app.inject({ method: 'POST', url: `${url}/memberships`, headers: headers(admin), payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, userId: account.credential.user.id, role: 'member', reason: '添加测试成员' } });
    expect(added.statusCode, added.body).toBe(200); w = added.json().data;
    const member = w.members.find(member => member.userId === account.credential.user.id)!;
    const previewUrl = `${url}/memberships/${member.id}/removal-preview`;
    const preview = await app.inject({ url: previewUrl, headers: { cookie: admin.cookie } });
    expect(preview.json().data).toMatchObject({ canRemove: true, blockers: [], version: w.version });
    expect((await app.inject({ url: previewUrl, headers: { cookie: account.login.cookie } })).statusCode).toBe(403);
    const key = randomUUID(); const body = { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: '成员退出项目' };
    const remove = (payload = body, requestKey = key) => app.inject({ method: 'POST', url: `${url}/memberships/${member.id}/remove`, headers: headers(admin, requestKey), payload });
    expect((await remove({ ...body, expectedPlanVersion: body.expectedPlanVersion - 1 })).statusCode).toBe(409);
    const result = await remove(); expect(result.statusCode, result.body).toBe(200);
    expect((await remove()).json()).toEqual(result.json());
    expect((await remove({ ...body, reason: '其他原因' })).statusCode).toBe(409);
    w = result.json().data; expect(w.members.find(item => item.id === member.id)).toMatchObject({ active: false, removedAt: now.toISOString(), userId: account.credential.user.id });
    expect(w.accounts.some(item => item.id === account.credential.user.id)).toBe(true);
    expect(db.prepare('SELECT 1 FROM member_capacities WHERE project_id=? AND member_id=?').get(project.id, member.id)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM project_user_links WHERE project_id=? AND member_id=?').get(project.id, member.id)).toBeTruthy();
    for (const endpoint of ['tasks','risks','settings','notifications','workstreams']) expect((await app.inject({ url: `${url}/${endpoint}`, headers: { cookie: account.login.cookie } })).statusCode).toBe(404);
    const resurrect = await app.inject({ method: 'POST', url: `${url}/settings/member_update`, headers: headers(admin), payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: '绕过添加恢复', member: { id: member.id, name: member.name, active: true, role: 'member' } } });
    expect(resurrect.json().error.code).toBe('MEMBER_REMOVED');
    const restore = await app.inject({ method: 'POST', url: `${url}/memberships`, headers: headers(admin), payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, userId: account.credential.user.id, role: 'project_admin', reason: '重新加入，明确管理员角色' } });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json().data.members.find((item: { id: string }) => item.id === member.id)).toMatchObject({ active: true, removedAt: null, role: 'project_admin' });
    expect((await app.inject({ url: `${url}/memberships`, headers: { cookie: account.login.cookie } })).json().data.canManage).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id=? AND action='membership_remove'").get(project.id)).toEqual({ n: 1 });
    await app.close(); app = freshApp();
    expect((await members()).members.find(item => item.id === member.id)?.role).toBe('project_admin');
  });

  test('removal lists actionable task, pending-review, risk and group blockers and protects owner and self', async () => {
    const admin = await bootstrap(); const url = '/api/v1/projects/phase-one';
    const preview = async (id: string) => (await app.inject({ url: `${url}/memberships/${id}/removal-preview`, headers: { cookie: admin.cookie } })).json().data;
    expect((await preview('zhou')).blockers.some((item: { kind: string }) => item.kind === 'protection')).toBe(true);
    expect((await preview('chen')).blockers.some((item: { kind: string }) => item.kind === 'task')).toBe(true);
    expect((await preview('lin')).blockers.some((item: { kind: string }) => item.kind === 'review')).toBe(true);
    const task = JSON.parse((db.prepare("SELECT meta_json FROM task_meta WHERE task_id='task-006'").get() as { meta_json: string }).meta_json);
    task.reviewStatus = 'submitted'; db.prepare("UPDATE task_meta SET meta_json=? WHERE task_id='task-006'").run(JSON.stringify(task));
    db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-006'").run();
    expect((await preview('lin')).blockers.find((item: { kind: string }) => item.kind === 'review').message).toContain('先退回');
    const riskRow = db.prepare("SELECT id,snapshot_json FROM risk_records WHERE project_id='phase-one' LIMIT 1").get() as { id: string; snapshot_json: string };
    const risk = JSON.parse(riskRow.snapshot_json); Object.assign(risk, { ownerId: 'lin', closeReviewerId: 'lin', status: 'monitoring' });
    db.prepare('UPDATE risk_records SET snapshot_json=? WHERE id=?').run(JSON.stringify(risk), riskRow.id);
    db.prepare("UPDATE workstreams SET owner_id='lin' WHERE project_id='phase-one'").run();
    const blockers = await preview('lin'); expect(blockers.blockers.map((item: { kind: string }) => item.kind)).toEqual(expect.arrayContaining(['review','risk','workstream']));
    const blocked = await app.inject({ method: 'POST', url: `${url}/memberships/lin/remove`, headers: headers(admin), payload: { expectedVersion: blockers.version, expectedPlanVersion: blockers.planVersion, reason: '禁止遗漏职责' } });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.details.blockers).toEqual(blockers.blockers);
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','xu',admin.session.user!.id);
    expect((await preview('xu')).blockers.some((item: { message: string }) => item.message.includes('自己'))).toBe(true);
  });

  test('viewer sessions cannot mutate notifications or any project surface, while project administrators can manage settings', async () => {
    const admin = await bootstrap(); const account = await createAccount(admin, 'view-access');
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','xu',account.credential.user.id);
    const isolatedProject = await createProject(admin, '动态隔离项目');
    expect((await app.inject('/api/v1/projects/phase-one/activities')).statusCode).toBe(401);
    const viewerFeed = await app.inject({url:'/api/v1/projects/phase-one/activities',headers:{cookie:account.login.cookie}});
    expect(viewerFeed.statusCode,viewerFeed.body).toBe(200);
    expect(viewerFeed.json().data.items).toEqual([]);
    expect((await app.inject({url:`/api/v1/projects/${isolatedProject.id}/activities`,headers:{cookie:account.login.cookie}})).statusCode).toBe(404);
    const projectFeed = (await app.inject({url:`/api/v1/projects/${isolatedProject.id}/activities`,headers:{cookie:admin.cookie}})).json().data;
    expect(projectFeed.items).toMatchObject([{type:'project.create',actor:{id:admin.session.user!.id}}]);
    const detail = projectFeed.items[0];
    expect((await app.inject({url:`/api/v1/projects/phase-one/activities/${detail.id}/items?cursor=${detail.itemsCursor}`,headers:{cookie:account.login.cookie}})).statusCode).toBe(422);
    expect((await app.inject({url:`/api/v1/projects/phase-one/activities/${detail.id}/items`,headers:{cookie:account.login.cookie}})).statusCode).toBe(404);
    for (const endpoint of ['notifications/read','risks/evaluate','tasks/parent-preview','settings/calendar','workstreams','schedule/preview','memberships']) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/${endpoint}`, headers: headers(account.login), payload: {} });
      expect(response.statusCode, endpoint + response.body).toBe(403);
    }
    db.prepare("UPDATE project_members SET role='project_admin' WHERE project_id='phase-one' AND id='xu'").run();
    const url = '/api/v1/projects/phase-one'; const w = (await app.inject({ url: `${url}/settings`, headers: { cookie: account.login.cookie } })).json().data;
    const changed = await app.inject({ method: 'POST', url: `${url}/settings/calendar`, headers: headers(account.login), payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: '管理员确认日历', calendar: { ...w.calendar, confirmed: true } } });
    expect(changed.statusCode, changed.body).toBe(200);
    const notifications = await app.inject({ url: `${url}/notifications`, headers: { cookie: account.login.cookie } }); expect(notifications.json().data.canManageJobs).toBe(true);
    expect((await app.inject({ url: `${url}/workstreams`, headers: { cookie: account.login.cookie } })).json().data.canManage).toBe(true);
  });

  test('retains an effective project owner when demoting to project administrator or disabling its linked login', async () => {
    const admin = await bootstrap(); const owner = await createAccount(admin, 'only-owner', true); const project = await createProject(owner.login);
    const w = (await app.inject({ url: `/api/v1/projects/${project.id}/settings`, headers: { cookie: admin.cookie } })).json().data;
    const member = w.members[0];
    const demote = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/settings/member_update`, headers: headers(admin), payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: '管理员不能替代唯一负责人', member: { id: member.id, name: member.name, role: 'project_admin', active: true } } });
    expect(demote.json().error.code).toBe('LAST_MANAGER_REQUIRED');
    const account = (await app.inject({ url: '/api/v1/admin/users', headers: { cookie: admin.cookie } })).json().data.users.find((item: { id: string }) => item.id === owner.credential.user.id);
    const disable = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${account.id}`, headers: headers(admin), payload: { expectedVersion: account.version, name: account.name, systemRole: 'user', active: false, canCreateProjects: true } });
    expect(disable.json().error.code).toBe('LAST_MANAGER_REQUIRED');
    expect((await app.inject({ url: `/api/v1/projects/${project.id}/tasks`, headers: { cookie: owner.login.cookie } })).statusCode).toBe(200);
  });

  test('completed converted summaries retain display ownership without preventing deactivation or logical removal', async () => {
    const admin = await bootstrap(); const account = await createAccount(admin, 'summary-owner'); const project = await createProject(admin);
    const url = `/api/v1/projects/${project.id}`;
    const get = async (endpoint: string) => (await app.inject({ url: `${url}/${endpoint}`, headers: { cookie: admin.cookie } })).json().data;
    const post = (endpoint: string, payload: object, method: 'POST' | 'PATCH' = 'POST') => app.inject({ method, url: `${url}/${endpoint}`, headers: headers(admin), payload });
    let w = await get('memberships');
    const added = await post('memberships', { expectedVersion: w.version, expectedPlanVersion: w.planVersion, userId: account.credential.user.id, role: 'member', reason: '添加成员' });
    expect(added.statusCode).toBe(200); const member = added.json().data.members.find((item: { userId: string }) => item.userId === account.credential.user.id);
    const draft = { title: '待转换执行任务', description: '', workstreamId: 'general', parentId: null, ownerId: member.id, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null };
    const created = await post('tasks', { ...draft, expectedPlanVersion: (await get('tasks')).planVersion }); expect(created.statusCode, created.body).toBe(200);
    const original = created.json().data.task;
    const converted = await post('tasks', { ...draft, title: '新增子任务', ownerId: admin.session.user!.id, parentId: original.id, expectedPlanVersion: created.json().data.planVersion, confirmParentConversion: true, expectedParentVersion: original.version });
    expect(converted.statusCode, converted.body).toBe(200); const summary = converted.json().data.parentTask;
    w = await get('tasks'); const retained = w.tasks.find((item: { id: string }) => item.id === original.id);
    const { start: _start, end: _end, ...edit } = draft;
    const assigned = await post(`tasks/${original.id}`, { ...edit, parentId: summary.id, ownerId: admin.session.user!.id, expectedVersion: retained.version, expectedPlanVersion: w.planVersion }, 'PATCH'); expect(assigned.statusCode, assigned.body).toBe(200);
    for (const id of [original.id, converted.json().data.task.id]) {
      w = await get('tasks'); const task = w.tasks.find((item: { id: string }) => item.id === id);
      const complete = await post(`tasks/${id}/transition`, { expectedVersion: task.version, expectedPlanVersion: w.planVersion, action: 'complete', reason: '子任务已交付' }); expect(complete.statusCode, complete.body).toBe(200);
    }
    expect((await get('tasks')).tasks.find((item: { id: string }) => item.id === summary.id)).toMatchObject({ status: 'done', ownerId: member.id, taskKind: 'summary' });
    expect(db.prepare('SELECT status FROM homepage_tasks WHERE id=?').get(summary.id)).toEqual({ status: 'todo' });
    const preview = await get(`memberships/${member.id}/removal-preview`); expect(preview).toMatchObject({ canRemove: true, blockers: [] });
    const deactivate = await post('settings/member_update', { expectedVersion: preview.version, expectedPlanVersion: preview.planVersion, reason: '汇总仅保留历史显示责任人', member: { id: member.id, name: member.name, role: member.role, active: false } }); expect(deactivate.statusCode, deactivate.body).toBe(200);
    const fresh = await get(`memberships/${member.id}/removal-preview`);
    const removed = await post(`memberships/${member.id}/remove`, { expectedVersion: fresh.version, expectedPlanVersion: fresh.planVersion, reason: '执行职责已移交，保留汇总历史' }); expect(removed.statusCode, removed.body).toBe(200);
    expect((await get('tasks')).tasks.find((item: { id: string }) => item.id === summary.id)?.ownerId).toBe(member.id);
  });

  test('milestone responsibility blocks real membership removal and role revocation until cancellation', async () => {
    const admin=await bootstrap(), project=await createProject(admin), account=await createAccount(admin,'milestone.owner');
    const prefix=`/api/v1/projects/${project.id}`;
    const memberships=async()=>(await app.inject({url:prefix+'/memberships',headers:headers(admin)})).json().data as MembershipWorkspace;
    let membership=await memberships();
    const added=await app.inject({method:'POST',url:prefix+'/memberships',headers:headers(admin),payload:{expectedVersion:membership.version,expectedPlanVersion:membership.planVersion,userId:account.credential.user.id,role:'member'}});
    expect(added.statusCode,added.body).toBe(200);membership=added.json().data;
    const member=membership.members.find(item=>item.userId===account.credential.user.id)!;
    const milestoneResponse=await app.inject({method:'POST',url:prefix+'/milestones',headers:headers(admin),payload:{expectedPlanVersion:membership.planVersion,title:'专属交付责任',description:'完成项目验证',workstreamId:'general',ownerId:member.id,reviewerId:project.memberId,date:null,criteria:[{id:'report',kind:'evidence',title:'验证报告',taskId:null}]}});
    expect(milestoneResponse.statusCode,milestoneResponse.body).toBe(200);
    const milestone=milestoneResponse.json().data.milestone;
    const preview=await app.inject({url:prefix+`/memberships/${member.id}/removal-preview`,headers:headers(admin)});
    expect(preview.json().data).toMatchObject({canRemove:false,blockers:[{kind:'milestone',id:milestone.id}]});
    membership=await memberships();
    const removal=await app.inject({method:'POST',url:prefix+`/memberships/${member.id}/remove`,headers:headers(admin),payload:{expectedVersion:membership.version,expectedPlanVersion:membership.planVersion,reason:'移交前尝试移除'}});
    expect(removal.statusCode).toBe(409); expect(removal.json().error.code).toBe('MEMBER_REMOVAL_BLOCKED');
    const settings=(await app.inject({url:prefix+'/settings',headers:headers(admin)})).json().data;
    // The canonical settings endpoint must also protect the same responsibility.
    const changed=await app.inject({method:'POST',url:prefix+'/settings/member_update',headers:headers(admin),payload:{expectedVersion:settings.version,expectedPlanVersion:settings.planVersion,member:{id:member.id,name:member.name,role:'viewer',active:true},reason:'验收前调整权限'}});
    expect(changed.statusCode,changed.body).toBe(422);
    expect(changed.json().error.code).toBe('MEMBER_HAS_RESPONSIBILITIES');
    const cancelled=await app.inject({method:'POST',url:prefix+`/milestones/${milestone.id}/transition`,headers:headers(admin),payload:{expectedPlanVersion:membership.planVersion,expectedVersion:milestone.version,action:'cancel',reason:'业务目标取消，保留历史'}});
    expect(cancelled.statusCode,cancelled.body).toBe(200);
    const after=await app.inject({url:prefix+`/memberships/${member.id}/removal-preview`,headers:headers(admin)});
    expect(after.json().data.canRemove).toBe(true);
  });

});
