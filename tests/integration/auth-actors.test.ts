import { configureMilestoneBaselineFixture } from '../helpers/milestone-fixtures.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthSession, AuthUser } from '../../shared/src/auth.js';
import type { TaskDraft, TaskWorkspace } from '../../shared/src/tasks.js';
import type { RiskDraft, RiskWorkspace } from '../../shared/src/risks.js';

const prefix = '/api/v1/projects/phase-one';
const taskDraft: TaskDraft = { title: '实名管理员安排任务', description: '', workstreamId: 'foundation', parentId: null, ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-10-12', end: '2026-10-13' };
const riskDraft: RiskDraft = { title: '实名管理员登记风险', description: '', workstreamId: 'foundation', ownerId: 'zhou', probability: 3, impact: 4, due: '2026-10-15', reviewDate: null, response: '安排依赖核对', taskIds: [], closeReviewerId: null };

describe('authenticated administrator operation and assignment boundaries', () => {
  let directory: string, app: FastifyInstance, db: Database.Database, cookie: string, session: AuthSession, workstreamId: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-auth-actors-'));
    const path = join(directory, 'isolated.sqlite'), now = new Date('2026-09-23T06:00:00Z');
    app = buildApp({ dbPath: path, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 });
    db = new Database(path);
    await createInitialAdmin(db, { username: 'admin', name: '实名测试管理员', password: 'test-administrator-password-2026' }, now);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'test-administrator-password-2026' } });
    expect(login.statusCode, login.body).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]!; session = login.json().data;
    workstreamId = (await get<TaskWorkspace>('/tasks')).workstreams[0]!.id;
  });
  afterEach(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = () => ({ cookie, 'x-csrf-token': session.csrfToken, 'idempotency-key': randomUUID(), 'x-demo-actor': 'zhou' });
  async function get<T = any>(path: string): Promise<T> {
    const response = await app.inject({ url: `${prefix}${path}`, headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200); return response.json().data;
  }
  const write = (path: string, payload: object, method: 'POST' | 'PATCH' = 'POST') => app.inject({ method, url: `${prefix}${path}`, headers: headers(), payload });

  test('administrator acts under a real ID without becoming project staffing or assuming a demo identity', async () => {
    const tasks = await get<TaskWorkspace>('/tasks');
    expect(tasks.actors.find(a => a.id === session.user!.id)).toEqual({ id: session.user!.id, name: '实名测试管理员', role: 'manager', assignable: false });
    const settings = await get('/settings');
    expect(settings.members).toHaveLength(4); expect(settings.capacities).toHaveLength(4);
    expect(settings.members.some((m: { id: string }) => m.id === session.user!.id)).toBe(false);
    const saved = await write('/settings/capacity', { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '核对成员投入', capacity: { memberId: 'chen', hoursPerDay: 4, exceptions: {} } });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data.events[0].actor).toBe('实名测试管理员');
    const created = await write('/tasks', { ...taskDraft, workstreamId, expectedPlanVersion: (await get<TaskWorkspace>('/tasks')).planVersion });
    expect(created.statusCode, created.body).toBe(200); expect(created.json().data.task.events.at(-1).actor).toBe('实名测试管理员');
    const risk = await write('/risks', { ...riskDraft, workstreamId });
    expect(risk.statusCode, risk.body).toBe(200); expect(risk.json().data.risk.events.at(-1).actor).toBe('实名测试管理员');
    expect((await get('/notifications?actorId=zhou')).actorId).toBe(session.user!.id);
  });

  test('synthetic administrator cannot own tasks, batch assignments, risks or designated reviews', async () => {
    const workspace = await get<TaskWorkspace>('/tasks');
    for (const overrides of [{ ownerId: session.user!.id }, { requiresReview: true, reviewerId: session.user!.id, acceptanceCriteria: '核对成果' }]) {
      const response = await write('/tasks', { ...taskDraft, workstreamId, ...overrides, expectedPlanVersion: workspace.planVersion });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe('ownerId' in overrides ? 'INVALID_OWNER' : 'INVALID_REVIEWER');
    }
    const existing = workspace.tasks.find(t => t.status === 'todo' && t.taskKind !== 'summary')!;
    const batch = await write('/tasks/batch', { expectedPlanVersion: workspace.planVersion, items: [{ id: existing.id, expectedVersion: existing.version }], patch: { ownerId: session.user!.id }, reason: '尝试分配系统操作身份' });
    expect(batch.statusCode, batch.body).toBe(422); expect(batch.json().error.code).toBe('INVALID_OWNER');
    for (const overrides of [{ ownerId: session.user!.id }, { closeReviewerId: session.user!.id }]) {
      const response = await write('/risks', { ...riskDraft, workstreamId, ...overrides });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe('ownerId' in overrides ? 'INVALID_OWNER' : 'INVALID_CLOSE_REVIEWER');
    }
    expect((await get<TaskWorkspace>('/tasks')).planVersion).toBe(workspace.planVersion);
  });

  test.each(['schedule', 'baseline'])('%s audit records the authenticated name rather than the forged demo header', async operation => {
    const plan = await get('/gantt');
    if (operation === 'schedule') {
      // Schedule authority requires actual project membership, even for global admins.
      db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'zhou', session.user!.id);
      const preview = await write('/schedule/preview', { expectedPlanVersion: plan.planVersion, reason: '实名管理员调整计划', changes: [{ taskId: 'task-006', start: '2026-10-01', end: '2026-10-05' }], mode: 'push_successors' });
      expect(preview.statusCode, preview.body).toBe(200);
      const result = await write('/schedule/apply', { previewId: preview.json().data.id, expectedPlanVersion: plan.planVersion });
      expect(result.statusCode, result.body).toBe(200);
    } else {
      configureMilestoneBaselineFixture(db);
      const result = await write('/baselines', { expectedPlanVersion: plan.planVersion, name: '实名承诺基线', reason: '已完成计划核对', calendarConfirmed: true, excludedIds: ['gap-operations'], exclusionReason: '运营范围尚待细化' });
      expect(result.statusCode, result.body).toBe(200); expect(result.json().data.actor).toBe('实名测试管理员');
    }
    const history = (await get('/gantt')).history;
    expect(history[0].actor).toBe('实名测试管理员');
  });

  test('disabling a linked login removes assignment eligibility while retaining historical members and ownership', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(), payload: { username: 'linked-worker', name: '关联账号', systemRole: 'user', canCreateProjects: false } });
    expect(response.statusCode, response.body).toBe(200); const user = response.json().data.user as AuthUser;
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'chen', user.id);
    expect((await get<TaskWorkspace>('/tasks')).actors.some(a => a.id === 'chen')).toBe(true);
    for (const risk of (await get<RiskWorkspace>('/risks')).risks.filter(r => r.status !== 'closed' && [r.ownerId,r.closeReviewerId].includes('chen'))) {
      const transferred = await write(`/risks/${risk.id}/responsibilities`, {expectedVersion:risk.version,ownerId:'zhou',closeReviewerId:'zhou',reason:'停用测试账号前移交未关闭风险'});
      expect(transferred.statusCode,transferred.body).toBe(200);
    }
    const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}`, headers: headers(), payload: { expectedVersion: user.version, name: user.name, systemRole: 'user', active: false, canCreateProjects: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const tasks = await get<TaskWorkspace>('/tasks'); expect(tasks.actors.some(a => a.id === 'chen')).toBe(false);
    expect(tasks.people?.find(person => person.id === 'chen')).toEqual({ id: 'chen', name: '陈知远' });
    expect(tasks.tasks.some(t => t.ownerId === 'chen' && t.owner === '陈知远')).toBe(true);
    expect((await get('/settings')).members.some((m: { id: string }) => m.id === 'chen')).toBe(true);
    const result = await write('/tasks', { ...taskDraft, workstreamId, expectedPlanVersion: tasks.planVersion });
    expect(result.statusCode, result.body).toBe(422); expect(result.json().error.code).toBe('INVALID_OWNER');
  });

  test('disabled reviewer names remain in display directories without retaining assignment permissions', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(), payload: { username: 'linked-reviewer', name: '验收登录账号', systemRole: 'user', canCreateProjects: false } });
    expect(created.statusCode, created.body).toBe(200); const user = created.json().data.user as AuthUser;
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'lin', user.id);
    const before = await get<TaskWorkspace>('/tasks');
    expect(before.people?.find(person => person.id === 'lin')).toEqual({ id: 'lin', name: '林若宁' });
    for (const risk of (await get<RiskWorkspace>('/risks')).risks.filter(r => r.status !== 'closed' && [r.ownerId,r.closeReviewerId].includes('lin'))) {
      const transferred = await write(`/risks/${risk.id}/responsibilities`, {expectedVersion:risk.version,ownerId:'zhou',closeReviewerId:'zhou',reason:'停用测试账号前移交未关闭风险'});
      expect(transferred.statusCode,transferred.body).toBe(200);
    }
    const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}`, headers: headers(), payload: { expectedVersion: user.version, name: user.name, systemRole: 'user', active: false, canCreateProjects: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const tasks = await get<TaskWorkspace>('/tasks'), risks = await get<RiskWorkspace>('/risks');
    for (const workspace of [tasks, risks]) {
      expect(workspace.actors.some(actor => actor.id === 'lin')).toBe(false);
      expect(workspace.people?.find(person => person.id === 'lin')).toEqual({ id: 'lin', name: '林若宁' });
    }
    expect(tasks.tasks.find(task => task.id === 'task-006')?.reviewerId).toBe('lin');
    const invalid = await write('/tasks', { ...taskDraft, workstreamId, requiresReview: true, reviewerId: 'lin', acceptanceCriteria: '保留历史不恢复权限', expectedPlanVersion: tasks.planVersion });
    expect(invalid.statusCode, invalid.body).toBe(422); expect(invalid.json().error.code).toBe('INVALID_REVIEWER');
  });

  test('a former administrator referenced by a historical submission remains name-resolvable after demotion', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: headers(), payload: { username: 'former-admin', name: '历史提交管理员', systemRole: 'admin', canCreateProjects: false } });
    expect(created.statusCode, created.body).toBe(200); const user = created.json().data.user as AuthUser;
    // Isolated historical fixture: global administrators may submit on an owner's
    // behalf. Keep that existing submitter reference when the account is demoted.
    const row = db.prepare("SELECT meta_json FROM task_meta WHERE task_id='task-006'").get() as { meta_json: string };
    const meta = JSON.parse(row.meta_json);
    meta.submissions.push({ id: randomUUID(), taskId: 'task-006', version: 1, submitterId: user.id, reviewerId: 'lin', evidence: '历史成果', status: 'rejected', comment: '历史退回', createdAt: '2026-09-22T06:00:00Z', reviewedAt: '2026-09-22T07:00:00Z' });
    db.prepare("UPDATE task_meta SET meta_json=? WHERE task_id='task-006'").run(JSON.stringify(meta));
    const demoted = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}`, headers: headers(), payload: { expectedVersion: user.version, name: user.name, systemRole: 'user', active: false, canCreateProjects: false } });
    expect(demoted.statusCode, demoted.body).toBe(200);
    for (const workspace of [await get<TaskWorkspace>('/tasks'), await get<RiskWorkspace>('/risks')]) {
      expect(workspace.actors.some(actor => actor.id === user.id)).toBe(false);
      expect(workspace.people?.find(person => person.id === user.id)).toEqual({ id: user.id, name: '历史提交管理员' });
      expect(workspace.people?.find(person => person.id === user.id)).not.toHaveProperty('role');
    }
  });
});
