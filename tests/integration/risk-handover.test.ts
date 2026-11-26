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
import type { ManagedRisk, RiskWorkspace } from '../../shared/src/risks.js';

const prefix = '/api/v1/projects/phase-one', now = new Date('2026-09-23T06:00:00Z');
describe('risk responsibility handover with real authentication', () => {
  let directory: string, app: FastifyInstance, db: Database.Database, cookie: string, session: AuthSession;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-risk-handover-'));
    const dbPath = join(directory, 'isolated.sqlite');
    app = buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 }); db = new Database(dbPath);
    await createInitialAdmin(db, { username: 'admin', name: '移交测试管理员', password: 'test-administrator-password-2026' }, now);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'test-administrator-password-2026' } });
    expect(login.statusCode, login.body).toBe(200); cookie = String(login.headers['set-cookie']).split(';')[0]!; session = login.json().data;
    db.prepare("UPDATE project_members SET role='project_admin' WHERE project_id='phase-one' AND id='lin'").run();
  });
  afterEach(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = (key: string = randomUUID()) => ({ cookie, 'x-csrf-token': session.csrfToken, 'idempotency-key': key });
  const write = (path: string, payload: object, key?: string, method: 'POST' | 'PATCH' = 'POST') => app.inject({ method, url: prefix + path, headers: headers(key), payload });
  async function get(path: string) { const result = await app.inject({ url: prefix + path, headers: { cookie } }); expect(result.statusCode, result.body).toBe(200); return result.json().data; }
  const workspace = (): Promise<RiskWorkspace> => get('/risks');
  async function create(overrides: object = {}) {
    const w = await workspace();
    return write('/risks', { title: '风险责任移交', description: '', workstreamId: w.workstreams[0]!.id, ownerId: 'zhou', probability: 3, impact: 4, due: '2026-10-15', reviewDate: null, response: '核验措施', taskIds: [], closeReviewerId: 'lin', ...overrides });
  }
  async function newRisk() { const result = await create(); expect(result.statusCode, result.body).toBe(200); return result.json().data.risk as ManagedRisk; }
  function store(risk: ManagedRisk) { db.prepare('UPDATE risk_records SET snapshot_json=? WHERE id=?').run(JSON.stringify(risk), risk.id); }
  function stored(id: string): ManagedRisk { return JSON.parse((db.prepare('SELECT snapshot_json FROM risk_records WHERE id=?').get(id) as { snapshot_json: string }).snapshot_json); }
  const handover = (risk: ManagedRisk, changes: object = {}, key?: string) => write(`/risks/${risk.id}/responsibilities`, { expectedVersion: risk.version, ownerId: 'lin', closeReviewerId: 'zhou', reason: '工作职责调整，已核对接手人员', ...changes }, key);

  test('only actual active management members qualify, even for a linked global administrator', async () => {
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'chen', session.user!.id);
    const w = await workspace(); expect(w.actors.find(a => a.id === 'chen')?.role).toBe('manager');
    expect(w.responsibilityCandidates.map(a => a.id).sort()).toEqual(['lin', 'zhou']);
    for (const id of ['chen', 'xu', session.user!.id, 'missing']) {
      expect((await create({ ownerId: id })).statusCode).toBe(422); expect((await create({ closeReviewerId: id })).statusCode).toBe(422);
    }
    db.prepare("UPDATE project_members SET active=0 WHERE id='lin'").run(); expect((await create()).statusCode).toBe(422);
  });
  test('historical open responsibility state is computed without rewriting snapshots, versions or events', async () => {
    const risk = await newRisk(); risk.ownerId = 'chen'; risk.closeReviewerId = 'xu'; store(risk); const before = stored(risk.id);
    for (let i = 0; i < 2; i++) { const read = (await workspace()).risks.find(r => r.id === risk.id)!; expect(read.needsHandover).toBe(true); expect(read.responsibilityIssues).toEqual(['owner', 'closeReviewer']); }
    expect(stored(risk.id)).toEqual(before);
    const result = await handover(risk); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.risk).toMatchObject({ ownerId: 'lin', closeReviewerId: 'zhou', needsHandover: false, version: risk.version + 1 });
    expect(stored(risk.id)).not.toHaveProperty('needsHandover'); expect(stored(risk.id).events.at(-1)).toMatchObject({ action: 'responsibilities', actor: '移交测试管理员' }); expect(stored(risk.id).events.at(-1)!.text).toContain('chen');
  });
  test('requires version, eligible IDs and reason; retry is idempotent and stale writes conflict', async () => {
    const risk = await newRisk();
    for (const changes of [{ reason: '' }, { reason: null }, { ownerId: 'chen' }, { closeReviewerId: null }, { expectedVersion: 0 }, { ownerId: session.user!.id }]) { expect((await handover(risk, changes)).statusCode).toBe(422); expect(stored(risk.id).version).toBe(risk.version); }
    const key = randomUUID(), first = await handover(risk, {}, key); expect(first.statusCode, first.body).toBe(200);
    expect((await handover(risk, {}, key)).json()).toEqual(first.json()); expect((await handover(risk, { reason: '其他原因' }, key)).statusCode).toBe(409);
    const stale = await handover(risk); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('RISK_VERSION_CONFLICT');
    expect(stored(risk.id).events.filter(e => e.action === 'responsibilities')).toHaveLength(1);
  });
  test('pending-close handover preserves closure snapshot, status and task associations', async () => {
    const risk = await newRisk(); risk.status = 'pending_close'; risk.ownerId = 'chen'; risk.closure = { reason: '关闭依据', submittedBy: 'chen', taskVersions: { 'task-006': 4 }, residualReasons: { 'task-006': '剩余风险已接受' } }; risk.actionTaskIds = ['task-006']; store(risk);
    const result = await handover(risk); expect(result.statusCode, result.body).toBe(200); expect(stored(risk.id)).toMatchObject({ status: 'pending_close', closure: risk.closure, actionTaskIds: risk.actionTaskIds });
  });
  test('closed history is preserved and explicit handover enables reopening', async () => {
    const risk = await newRisk(); risk.status = 'closed'; risk.ownerId = 'chen'; risk.closeReviewerId = 'xu'; risk.closure = { reason: '历史关闭', submittedBy: 'chen', taskVersions: {}, residualReasons: {}, reviewedById: 'xu', reviewedAt: now.toISOString() }; store(risk);
    expect((await workspace()).risks.find(r => r.id === risk.id)!.needsHandover).toBe(false); expect(stored(risk.id).closure).toEqual(risk.closure);
    expect((await write(`/risks/${risk.id}/transition`, { expectedVersion: risk.version, action: 'reopen', reason: '重新跟进' })).statusCode).toBe(422);
    const result = await handover(risk); expect(result.statusCode, result.body).toBe(200); expect(result.json().data.risk.status).toBe('closed');
    const reopened = await write(`/risks/${risk.id}/transition`, { expectedVersion: result.json().data.risk.version, action: 'reopen', reason: '重新跟进' }); expect(reopened.statusCode, reopened.body).toBe(200); expect(reopened.json().data.risk).toMatchObject({ status: 'monitoring', closure: risk.closure });
  });
  test('management self-review still requires reason after pending-close handover', async () => {
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'lin', session.user!.id);
    const risk = await newRisk(); risk.status = 'pending_close'; risk.closure = { reason: '关闭依据', submittedBy: 'zhou', taskVersions: {}, residualReasons: {} }; store(risk);
    const result = await handover(risk); expect(result.statusCode, result.body).toBe(200); const payload = { expectedVersion: result.json().data.risk.version, action: 'approve_close', reason: '' };
    expect((await write(`/risks/${risk.id}/transition`, payload)).statusCode).toBe(422); const approved = await write(`/risks/${risk.id}/transition`, { ...payload, reason: '管理者已核验材料并说明自审依据' }); expect(approved.statusCode, approved.body).toBe(200); expect(approved.json().data.risk.closure.selfReview).toBe(true);
  });
  test.each(['ownerId', 'closeReviewerId'].flatMap(responsibility => ['demote', 'deactivate', 'remove'].map(change => ({ responsibility, change }))))('open $responsibility blocks $change until handover', async ({ responsibility, change }) => {
    db.prepare("INSERT INTO project_members(project_id,id,name,role,active) VALUES('phase-one','handover-reviewer','移交复核人','project_admin',1)").run();
    const risk = await newRisk(); if (responsibility === 'ownerId') { risk.ownerId = 'handover-reviewer'; risk.owner = '移交复核人'; } else risk.closeReviewerId = 'handover-reviewer'; store(risk);
    async function changeMember() {
      const settings = await get('/settings');
      if (change === 'remove') { const memberships = await get('/memberships'); return write('/memberships/handover-reviewer/remove', { expectedVersion: memberships.version, expectedPlanVersion: memberships.planVersion, reason: '移除成员' }); }
      return write('/settings/member_update', { expectedVersion: settings.version, expectedPlanVersion: settings.planVersion, reason: '调整管理职责', member: { id: 'handover-reviewer', name: '移交复核人', role: change === 'demote' ? 'member' : 'project_admin', active: change !== 'deactivate' } });
    }
    const blocked = await changeMember(); expect(blocked.statusCode, blocked.body).toBe(change === 'remove' ? 409 : 422); expect((await handover(risk, { ownerId: 'zhou', closeReviewerId: 'zhou' })).statusCode).toBe(200); const changed = await changeMember(); expect(changed.statusCode, changed.body).toBe(200);
  });
  test('handover rollback keeps risk, revision and receipt intact; ordinary patch cannot bypass handover', async () => {
    const risk = await newRisk(), before = stored(risk.id), w = await workspace(), key = randomUUID();
    db.exec("CREATE TRIGGER reject_handover BEFORE UPDATE ON risk_records BEGIN SELECT RAISE(ABORT, 'handover rollback fixture'); END");
    expect((await handover(risk, {}, key)).statusCode).toBe(500);
    expect(stored(risk.id)).toEqual(before); expect((await workspace()).version).toBe(w.version);
    expect(db.prepare('SELECT 1 FROM risk_idempotency WHERE request_key=?').get(key)).toBeUndefined();
    db.exec('DROP TRIGGER reject_handover');
    const retry = await handover(risk, {}, key); expect(retry.statusCode, retry.body).toBe(200);
    const latest = retry.json().data.risk;
    const draft = Object.fromEntries(['title', 'description', 'workstreamId', 'ownerId', 'probability', 'impact', 'due', 'reviewDate', 'response', 'taskIds', 'closeReviewerId'].map(field => [field, latest[field]]));
    const bypass = await write(`/risks/${risk.id}`, { ...draft, ownerId: 'zhou', expectedVersion: latest.version }, undefined, 'PATCH');
    expect(bypass.statusCode).toBe(422); expect(bypass.json().error.code).toBe('RISK_HANDOVER_REQUIRED');
  });
  test('members/viewers cannot enter risk domain; members still execute risk-linked tasks', async () => {
    const risk = await newRisk(), w = await workspace();
    const created = await write(`/risks/${risk.id}/actions/create`, { expectedVersion: risk.version, expectedPlanVersion: w.planVersion, draft: { title: '普通成员执行风险应对任务', description: '', workstreamId: risk.workstreamId, parentId: null, ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null } });
    expect(created.statusCode, created.body).toBe(200); const task = created.json().data.task;
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'chen', session.user!.id); db.prepare("UPDATE auth_users SET system_role='user' WHERE id=?").run(session.user!.id);
    for (const role of ['member', 'viewer']) { db.prepare('UPDATE project_members SET role=? WHERE id=?').run(role, 'chen'); expect((await app.inject({ url: prefix + '/risks', headers: { cookie } })).statusCode).toBe(403); expect((await handover(risk)).statusCode).toBe(403); expect((await write('/risks/evaluate', {})).statusCode).toBe(403); }
    db.prepare("UPDATE project_members SET role='member' WHERE id='chen'").run();
    for (const action of ['start', 'complete']) {
      const tasks = await get('/tasks'), current = tasks.tasks.find((item: { id: string }) => item.id === task.id);
      const executed = await write(`/tasks/${task.id}/transition`, { expectedVersion: current.version, expectedPlanVersion: tasks.planVersion, action });
      expect(executed.statusCode, executed.body).toBe(200);
    }
    expect((await get('/tasks')).tasks.find((item: { id: string }) => item.id === task.id).status).toBe('done');
  });
});
