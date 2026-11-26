import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { PlanEditRequest, PlanNode, PlanPreview, ProjectPlan } from '../../shared/src/planning.js';
const prefix = '/api/v1/projects/phase-one', now = new Date('2026-09-23T06:00:00Z');
describe('unified task planning contracts', () => {
  let directory: string, app: FastifyInstance, db: Database.Database, token: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unified-task-planning-'));
    const dbPath = join(directory, 'isolated.sqlite');
    app = buildLegacyApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 }); db = new Database(dbPath);
    token = (await plan()).writeToken;
    db.prepare("UPDATE plan_projects SET dependencies_json=? WHERE project_id='phase-one'").run(JSON.stringify([{ predecessorId: 'task-007', successorId: 'task-008', type: 'FS', lagDays: 0 }]));
  });
  afterEach(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  async function plan(actor?: string): Promise<ProjectPlan> {
    const r = await app.inject({ url: `${prefix}/gantt`, headers: actor === undefined ? {} : { 'x-demo-actor': actor } });
    expect(r.statusCode, r.body).toBe(200); return r.json().data;
  }
  const post = (path: string, payload: object, actor?: string, key: string = randomUUID()) => app.inject({ method: 'POST', url: `${prefix}${path}`, headers: { 'x-preview-token': token, 'idempotency-key': key, ...(actor === undefined ? {} : { 'x-demo-actor': actor }) }, payload });
  const edit = (extra: Partial<PlanEditRequest> = {}): PlanEditRequest => ({ expectedPlanVersion: 1, calculation: 'relationships_only', changes: [], mode: 'push_successors', dependencyTargetId: 'task-007', incomingDependencies: [{ predecessorId: 'task-006', lagDays: 0 }], ...extra });
  async function preview(extra: Partial<PlanEditRequest> = {}) { const r = await post('/schedule/preview', edit(extra)); expect(r.statusCode, r.body).toBe(200); return r.json().data as PlanPreview; }
  const apply = (p: PlanPreview, actor?: string, key?: string) => post('/schedule/apply', { previewId: p.id, expectedPlanVersion: p.basePlanVersion }, actor, key);
  function nodes(change: (nodes: PlanNode[]) => void) {
    const row = db.prepare("SELECT nodes_json FROM plan_projects WHERE project_id='phase-one'").get() as { nodes_json: string };
    const value = JSON.parse(row.nodes_json); change(value);
    db.prepare("UPDATE plan_projects SET nodes_json=? WHERE project_id='phase-one'").run(JSON.stringify(value, null, 1));
  }
  function meta(id: string, value: object) { db.prepare('UPDATE task_meta SET meta_json=json_patch(meta_json,?) WHERE task_id=?').run(JSON.stringify(value), id); }
  function milestone(id: string, value: object) { db.prepare('UPDATE milestone_records SET record_json=json_patch(record_json,?) WHERE id=?').run(JSON.stringify(value), id); }
  function persisted() {
    return { plan: db.prepare("SELECT nodes_json,calendar_json FROM plan_projects WHERE project_id='phase-one'").get(), home: db.prepare('SELECT * FROM homepage_projects ORDER BY id').all(), tasks: db.prepare('SELECT * FROM homepage_tasks ORDER BY id').all(), meta: db.prepare('SELECT * FROM task_meta ORDER BY task_id').all(), milestones: db.prepare('SELECT * FROM milestone_records ORDER BY id').all() };
  }
  test.each(['unplanned', 'mixed', 'scheduled'])('%s chain: preserve every persisted node, homepage field and metadata byte-for-byte', async variant => {
    nodes(value => { for (const n of value.filter(n => ['task-006','task-007','task-008'].includes(n.id))) {
      if (variant === 'unplanned' || (variant === 'mixed' && n.id === 'task-007')) Object.assign(n, { start: null, end: null, durationDays: null });
      else Object.assign(n, { start: n.id === 'task-006' ? '2026-10-20' : '2026-09-24', end: n.id === 'task-006' ? '2026-10-22' : '2026-09-25', durationDays: 17 });
    } });
    const before = persisted(), structure = db.prepare("SELECT version FROM plan_structure_versions WHERE project_id='phase-one'").get() as { version: number }, p = await preview({ mode: 'earliest_start' });
    expect(p).toMatchObject({ calculation: 'relationships_only', canApply: true, dependencyChanged: true, changes: [] });
    expect(p.issues.some(i => (variant === 'scheduled' ? i.code === 'DEPENDENCY_DATE_CONFLICT' : i.code.startsWith('UNSCHEDULED')) && i.severity === 'warning')).toBe(true);
    expect(persisted()).toEqual(before);
    const key = randomUUID(), result = await apply(p, 'zhou', key); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toEqual({ planVersion: 2, affectedCount: 1 }); expect(persisted()).toEqual(before);
    expect(db.prepare("SELECT version FROM plan_structure_versions WHERE project_id='phase-one'").get()).toEqual({ version: structure.version + 1 });
    expect((await plan()).dependencies).toEqual(p.dependencies);
    expect((await apply(p, 'zhou', key)).json()).toEqual(result.json()); expect((await plan()).history).toHaveLength(1);
    expect(db.prepare("SELECT actor_name FROM activity_groups WHERE type='plan.schedule'").all()).toEqual([{ actor_name: '周亦安' }]);
    const jobs = db.prepare("SELECT kind FROM background_jobs WHERE dedupe_key LIKE 'business-%'").all() as { kind: string }[];
    expect(jobs.map(job => job.kind)).toEqual(expect.arrayContaining(['risk_evaluate','snapshot']));
  });
  test('schedule defaults to propagation and still blocks an unplanned chain', async () => {
    const p = await preview({ calculation: undefined, changes: [{ taskId: 'task-006', start: '2026-10-20', end: '2026-10-22' }] });
    expect(p.calculation).toBe('schedule'); expect(p.changes.some(c => c.taskId === 'task-007')).toBe(true);
    nodes(value => Object.assign(value.find(n => n.id === 'task-008')!, { start: null, end: null, durationDays: null }));
    expect((await preview({ calculation: 'schedule' })).canApply).toBe(false);
  });
  test.each([
    ['unknown calculation', { calculation: 'other' }],
    ['dates in relation mode', { changes: [{ taskId: 'task-007', start: '2026-10-01', end: '2026-10-02' }] }],
    ['missing edit', { dependencyTargetId: undefined, incomingDependencies: undefined }],
    ['group', { dependencyTargetId: 'group-system-bottom' }],
    ['cross-project/missing', { incomingDependencies: [{ predecessorId: 'other-project-task', lagDays: 0 }] }],
    ['self', { incomingDependencies: [{ predecessorId: 'task-007', lagDays: 0 }] }],
    ['duplicate', { incomingDependencies: [{ predecessorId: 'task-006', lagDays: 0 }, { predecessorId: 'task-006', lagDays: 1 }] }],
    ['cycle', { incomingDependencies: [{ predecessorId: 'task-008', lagDays: 0 }] }],
    ...[-1,261,0.5,'1'].map((lagDays): [string, object] => [`lag ${lagDays}`, { incomingDependencies: [{ predecessorId: 'task-006', lagDays }] }]),
    ['non-FS', { incomingDependencies: [{ predecessorId: 'task-006', lagDays: 0, type: 'SS' }] }],
  ])('rejects invalid relationship %s', async (_label, change) => {
    const r = await post('/schedule/preview', edit(change as Partial<PlanEditRequest>)); expect(r.statusCode, r.body).toBe(422);
  });
  test.each(['upstream','sibling'])('crafted schedule rejects a mixed component with an unplanned %s', async direction => {
    const dependencies = [
      { predecessorId: 'task-006', successorId: 'task-007', type: 'FS', lagDays: 0 },
      { predecessorId: 'task-007', successorId: 'task-008', type: 'FS', lagDays: 0 },
      { predecessorId: direction === 'upstream' ? 'task-009' : 'task-006', successorId: direction === 'upstream' ? 'task-006' : 'task-009', type: 'FS', lagDays: 0 },
    ];
    db.prepare("UPDATE plan_projects SET dependencies_json=? WHERE project_id='phase-one'").run(JSON.stringify(dependencies));
    nodes(value => Object.assign(value.find(n => n.id === 'task-009')!, { start: null, end: null, durationDays: null }));
    const before = persisted(), p = await preview({ calculation: 'schedule', changes: [{ taskId: 'task-007', start: '2026-10-20', end: '2026-10-22' }] });
    expect(p.canApply).toBe(false); expect(p.issues.some(i => i.objectId === 'task-009' && i.severity === 'error')).toBe(true);
    expect((await apply(p)).statusCode).toBe(422); expect(persisted()).toEqual(before); expect((await plan()).planVersion).toBe(1);
  });
  test('taskKind identifies summaries and execution tasks, not workstream groups', async () => {
    meta('task-009', { taskKind: 'summary' }); const p = await plan();
    expect(p.nodes.find(n => n.id === 'task-009')).toMatchObject({ kind: 'group', taskKind: 'summary' });
    expect(p.nodes.find(n => n.id === 'task-006')).toMatchObject({ kind: 'task', taskKind: 'execution' });
    expect(p.nodes.find(n => n.id === 'group-system-bottom')).not.toHaveProperty('taskKind');
    expect((await post('/schedule/preview', edit({ dependencyTargetId: 'task-009' }))).statusCode).toBe(422);
  });
  test.each(['task-006','task-007'])('cancelled %s is unavailable', async id => { meta(id, { cancelled: true }); expect((await post('/schedule/preview', edit())).statusCode).toBe(422); });
  test('read plan excludes cancelled tasks from candidates', async () => { meta('task-006', { cancelled: true }); expect((await plan()).nodes.some(node => node.id === 'task-006')).toBe(false); });
  test('deleted source is unavailable', async () => { nodes(value => value.splice(value.findIndex(n => n.id === 'task-006'), 1)); expect((await post('/schedule/preview', edit())).statusCode).toBe(422); });
  test.each(['submitted','cancelled','accepted'])('milestone target %s is locked', async state => {
    milestone('milestone-03', { state, acceptedAt: state === 'accepted' ? now.toISOString() : null });
    expect((await post('/schedule/preview', edit({ dependencyTargetId: 'milestone-03' }))).statusCode).toBe(422);
  });
  test('eligible milestone permits relationships; cancelled milestone source cannot be newly selected', async () => {
    const p = await preview({ dependencyTargetId: 'milestone-03' }); expect(p.canApply).toBe(true); expect((await apply(p)).statusCode).toBe(200);
    milestone('milestone-04', { state: 'cancelled' });
    expect((await post('/schedule/preview', edit({ expectedPlanVersion: 2, incomingDependencies: [{ predecessorId: 'milestone-04', lagDays: 0 }] }))).statusCode).toBe(422);
  });
  test('milestone acceptance graph cannot cycle', async () => {
    milestone('milestone-03', { criteria: [{ id: 'criterion', kind: 'task', taskId: 'task-007', title: '必要交付' }] });
    const r = await post('/schedule/preview', edit({ incomingDependencies: [{ predecessorId: 'milestone-03', lagDays: 0 }] }));
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('MILESTONE_ACCEPTANCE_CYCLE');
  });
  test.each(['task-007','task-008'])('pending %s remains locked in an unplanned chain', async id => {
    nodes(value => Object.assign(value.find(n => n.id === id)!, { start: null, end: null, durationDays: null })); meta(id, { reviewStatus: 'submitted' });
    expect((await post('/schedule/preview', edit())).json().error.code).toBe('REVIEW_PENDING');
  });
  test('pending downstream milestone is locked', async () => {
    db.prepare("UPDATE plan_projects SET dependencies_json=? WHERE project_id='phase-one'").run(JSON.stringify([{ predecessorId: 'task-007', successorId: 'milestone-03', type: 'FS', lagDays: 0 }]));
    milestone('milestone-03', { state: 'submitted' }); expect((await post('/schedule/preview', edit())).json().error.code).toBe('REVIEW_PENDING');
  });
  test('known completed conflicts are errors and done targets cannot edit dependencies', async () => {
    db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-008'").run();
    nodes(value => { Object.assign(value.find(n => n.id === 'task-007')!, { start: '2026-10-20', end: '2026-10-22' }); Object.assign(value.find(n => n.id === 'task-008')!, { start: '2026-09-24', end: '2026-09-25' }); });
    const p = await preview(); expect(p.canApply).toBe(false);
    expect(p.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DONE_DEPENDENCY_CONFLICT', severity: 'error' })])); expect((await apply(p)).statusCode).toBe(422);
    expect((await post('/schedule/preview', edit({ dependencyTargetId: 'task-008' }))).statusCode).toBe(422);
  });
  test('apply rechecks downstream review state before any receipt', async () => {
    const p = await preview(); meta('task-008', { reviewStatus: 'submitted' }); const r = await apply(p);
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('REVIEW_PENDING'); expect((await plan()).planVersion).toBe(1); expect(db.prepare('SELECT * FROM plan_idempotency').all()).toHaveLength(0);
  });
  test.each(['done-target','cancelled-target','cancelled-source','deleted-source','completed-conflict'])('apply revalidates live %s without changing dates', async state => {
    const p = await preview();
    if (state === 'done-target') db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-007'").run();
    if (state === 'cancelled-target') meta('task-007', { cancelled: true });
    if (state === 'cancelled-source') meta('task-006', { cancelled: true });
    if (state === 'deleted-source') nodes(value => value.splice(value.findIndex(node => node.id === 'task-006'), 1));
    if (state === 'completed-conflict') {
      db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-008'").run();
      nodes(value => { Object.assign(value.find(n => n.id === 'task-007')!, { start: '2026-10-20', end: '2026-10-22' }); });
    }
    const before = persisted(), r = await apply(p);
    expect(r.statusCode, r.body).toBe(422); expect(persisted()).toEqual(before);
    expect(db.prepare("SELECT version FROM plan_projects WHERE project_id='phase-one'").get()).toEqual({ version: 1 });
  });
  test('late receipt failure rolls back dependencies, audit and durable jobs together', async () => {
    const p = await preview();
    const state = () => Object.fromEntries(['plan_projects','plan_structure_versions','plan_history','plan_idempotency','activity_groups','activity_items','background_jobs'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    const before = state();
    db.exec("CREATE TRIGGER fail_unified_receipt BEFORE INSERT ON plan_idempotency BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect((await apply(p)).statusCode).toBe(500); expect(state()).toEqual(before);
    expect(db.prepare('SELECT applied FROM plan_previews WHERE id=?').get(p.id)).toEqual({ applied: 0 });
  });
  test('stale, expired, replay and rollback paths are atomic', async () => {
    const p = await preview(), other = await preview(), before = persisted(), key = randomUUID();
    db.exec("CREATE TRIGGER fail_unified_history BEFORE INSERT ON plan_history BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect((await apply(p, 'zhou', key)).statusCode).toBe(500); expect(persisted()).toEqual(before); expect((await plan()).planVersion).toBe(1);
    expect(db.prepare('SELECT * FROM plan_idempotency').all()).toHaveLength(0); expect(db.prepare('SELECT applied FROM plan_previews WHERE id=?').get(p.id)).toEqual({ applied: 0 });
    db.exec('DROP TRIGGER fail_unified_history'); expect((await apply(p, 'zhou', key)).statusCode).toBe(200);
    expect((await apply(other, 'zhou', key)).json().error.code).toBe('IDEMPOTENCY_CONFLICT'); expect((await apply(other)).json().error.code).toBe('PLAN_VERSION_CONFLICT');
    const expiring = await preview({ expectedPlanVersion: 2, incomingDependencies: [] }); db.prepare('UPDATE plan_previews SET expires_at=? WHERE id=?').run(now.toISOString(), expiring.id);
    expect((await apply(expiring)).json().error.code).toBe('PREVIEW_EXPIRED');
  });
  test('per-actor capability guards preview/apply/replay and preserves token-only fixtures', async () => {
    expect((await plan('zhou')).canEditSchedule).toBe(true);
    for (const actor of ['chen','xu','missing','']) { expect((await plan(actor)).canEditSchedule).toBe(false); expect((await post('/schedule/preview', edit(), actor)).statusCode).toBe(403); }
    expect((await plan('zhou')).canEditSchedule).toBe(true);
    const p = await preview(), key = randomUUID();
    expect((await apply(p, 'xu', key)).statusCode).toBe(403);
    expect((await apply(p, 'zhou', key)).statusCode).toBe(200);
    db.prepare("UPDATE project_members SET active=0 WHERE id='zhou'").run();
    expect((await plan('zhou')).canEditSchedule).toBe(false); expect((await apply(p, 'zhou', key)).statusCode).toBe(403);
    db.prepare("UPDATE project_members SET active=1 WHERE id='zhou'").run();
    db.prepare("UPDATE project_members SET removed_at=? WHERE id='zhou'").run(now.toISOString());
    expect((await plan('zhou')).canEditSchedule).toBe(false); expect((await apply(p, 'zhou', key)).statusCode).toBe(403);
    expect((await post('/schedule/preview', edit({ expectedPlanVersion: 2 }), 'zhou')).statusCode).toBe(403);
  });
});
describe('authenticated schedule authority', () => {
  test('admin alone false/403; linked manager succeeds; readonly/removed cannot preview or replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unified-task-auth-')), dbPath = join(directory, 'isolated.sqlite');
    const app = buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 }), db = new Database(dbPath);
    try {
      await createInitialAdmin(db, { username: 'admin', name: '真实管理员', password: 'test-unified-admin-password-2026' }, now);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'test-unified-admin-password-2026' } }); expect(login.statusCode).toBe(200);
      const session = login.json().data, cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const headers = { cookie, 'x-csrf-token': session.csrfToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() };
      const read = async () => (await app.inject({ url: `${prefix}/gantt`, headers })).json().data as ProjectPlan;
      const post = (path: string, payload: object) => app.inject({ method: 'POST', url: `${prefix}${path}`, headers, payload });
      const edit = { expectedPlanVersion: 1, changes: [{ taskId: 'task-006', start: '2026-10-01', end: '2026-10-05' }], mode: 'push_successors' };
      expect((await read()).canEditSchedule).toBe(false); expect((await post('/schedule/preview', edit)).statusCode).toBe(403);
      expect((await post('/schedule/apply', { previewId: 'missing', expectedPlanVersion: 1 })).statusCode).toBe(403);
      // Matching a legacy member ID is not an authenticated account link.
      db.prepare('INSERT INTO project_members(project_id,id,name,role,active) VALUES(?,?,?,?,?)').run('phase-one',session.user.id,'未关联同名标识','manager',1);
      expect((await read()).canEditSchedule).toBe(false); expect((await post('/schedule/preview', edit)).statusCode).toBe(403);
      db.prepare('DELETE FROM project_members WHERE project_id=? AND id=?').run('phase-one',session.user.id);
      db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','zhou',session.user.id); expect((await read()).canEditSchedule).toBe(true);
      const p = await post('/schedule/preview', edit); expect(p.statusCode, p.body).toBe(200); const body = { previewId: p.json().data.id, expectedPlanVersion: 1 }; expect((await post('/schedule/apply', body)).statusCode).toBe(200);
      for (const role of ['member','viewer','project_admin']) {
        db.prepare("UPDATE project_members SET role=? WHERE id='zhou'").run(role); expect((await read()).canEditSchedule).toBe(role === 'project_admin');
        expect((await post('/schedule/apply', body)).statusCode).toBe(role === 'project_admin' ? 200 : 403);
        if (role !== 'project_admin') expect((await post('/schedule/preview', { ...edit, expectedPlanVersion: 2 })).statusCode).toBe(403);
      }
      db.prepare("UPDATE project_members SET removed_at=? WHERE id='zhou'").run(now.toISOString()); expect((await read()).canEditSchedule).toBe(false);
      expect((await post('/schedule/apply', body)).statusCode).toBe(403); expect((await post('/schedule/preview', { ...edit, expectedPlanVersion: 2 })).statusCode).toBe(403);
    } finally { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
