import { configureMilestoneBaselineFixture } from '../helpers/milestone-fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { PlanEditRequest, PlanPreview, ProjectPlan } from '../../shared/src/planning.js';
import { addWorkdays, isWorkday } from '../../server/src/modules/planning/calendar.js';

describe('local DEMO complete planning', () => {
  let directory: string; let dbPath: string; let app: FastifyInstance; let token: string;
  let now = new Date('2026-09-21T08:00:00.000Z');
  const prefix = '/api/v1/projects/phase-one';
  beforeEach(async () => {
    now = new Date('2026-09-21T08:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'goodwork-planning-')); dbPath = join(directory, 'plan.sqlite');
    app = buildApp({ dbPath, clock: () => now });
    token = (await plan()).writeToken;
  });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function plan(): Promise<ProjectPlan> { const response = await app.inject(`${prefix}/gantt`); expect(response.statusCode).toBe(200); return response.json().data; }
  const payload = (extra: Partial<PlanEditRequest> = {}): PlanEditRequest => ({ expectedPlanVersion: 1, reason: 'DEMO · 评审后调整联调安排', changes: [{ taskId: 'task-006', start: '2026-10-01', end: '2026-10-05' }], mode: 'push_successors', ...extra });
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: `${prefix}${path}`, headers: { 'x-preview-token': token, origin: 'http://127.0.0.1:5174', ...headers }, payload: body as Record<string, unknown> });
  }
  async function preview(extra: Partial<PlanEditRequest> = {}): Promise<PlanPreview> { const response = await post('/schedule/preview', payload(extra)); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
  const applyBody = (preview: PlanPreview) => ({ previewId: preview.id, expectedPlanVersion: preview.basePlanVersion });
  const baselineBody = { expectedPlanVersion: 1, name: '第一次承诺（DEMO）', reason: '评审确认', calendarConfirmed: true, excludedIds: ['gap-operations'], exclusionReason: '运营范围尚未细化，单独保留后续评审。' };

  test('seeds 48 execution tasks, 6 groups, 6 milestones, one unscheduled gap and valid dates without changing homepage counts', async () => {
    const data = await plan();
    expect(data.mode).toBe('demo'); expect(data.planVersion).toBe(1);
    expect(data.nodes.filter(node => node.kind === 'task')).toHaveLength(48);
    expect(data.nodes.filter(node => node.kind === 'group')).toHaveLength(6);
    expect(data.nodes.filter(node => node.kind === 'milestone')).toHaveLength(6);
    expect(data.nodes.filter(node => node.kind === 'gap')).toMatchObject([{ id: 'gap-operations', start: null, end: null }]);
    expect(data.criticalCoverage.complete).toBe(false);
    expect(data.baselines[0]).toMatchObject({ name: '初始计划（示例）', excludedIds: ['gap-operations'], demo: true });
    expect(data.issues.some(issue => issue.code === 'RESOURCE_OVERLOAD')).toBe(true);
    for (const node of data.nodes.filter(node => node.start)) { expect(isWorkday(node.start!)).toBe(true); expect(isWorkday(node.end!)).toBe(true); }
    for (const edge of data.dependencies) {
      const from = data.nodes.find(node => node.id === edge.predecessorId)!; const to = data.nodes.find(node => node.id === edge.successorId)!;
      expect(to.start! >= addWorkdays(from.end!, edge.lagDays + (to.kind === 'milestone' ? 0 : 1))).toBe(true);
    }
    const homepage = (await app.inject(`${prefix}/overview`)).json().data;
    expect(homepage.summary).toMatchObject({ totalTasks: 48, completedTasks: 18, overdueTasks: 4, upcomingMilestones: 4 });
    for (const task of homepage.tasks) expect(task.due).toBe(data.nodes.find(node => node.id === task.id)!.end);
  });
  test('preview is non-mutating; atomic apply persists dates, milestone, group bounds, version and history once', async () => {
    const before = await plan(); const draft = await preview();
    expect(draft.canApply).toBe(true);
    expect(draft.changes.map(change => change.taskId)).toEqual(expect.arrayContaining(['task-006', 'task-007', 'milestone-03']));
    expect(draft.issues.some(issue => issue.code === 'BASELINE_MILESTONE_LATE')).toBe(true);
    expect(await plan()).toEqual(before);
    const body = applyBody(draft); const headers = { 'idempotency-key': 'same-review-001' };
    const applied = await post('/schedule/apply', body, headers); expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().data).toEqual({ planVersion: 2, affectedCount: draft.changes.length });
    const duplicate = await post('/schedule/apply', body, headers); expect(duplicate.json()).toEqual(applied.json());
    const after = await plan(); expect(after.planVersion).toBe(2); expect(after.history).toHaveLength(1); expect(after.baselines).toEqual(before.baselines);
    const homepage = (await app.inject(`${prefix}/overview`)).json().data;
    expect(homepage.tasks.find((task: { id: string }) => task.id === 'task-006').due).toBe('2026-10-05');
    expect(homepage.milestones.find((milestone: { id: string }) => milestone.id === 'milestone-03').date).toBe('2026-10-05');
    expect(homepage.workstreams.find((stream: { id: string }) => stream.id === 'system-bottom').end).toBe(after.nodes.find(node => node.id === 'group-system-bottom')!.end);
    await app.close(); app = buildApp({ dbPath, clock: () => now }); token = (await plan()).writeToken;
    const reopened = await plan(); expect(reopened.planVersion).toBe(2); expect(reopened.history).toHaveLength(1); expect(reopened.nodes).toEqual(after.nodes);
    expect((await post('/schedule/apply', body, headers)).json()).toEqual(applied.json());
    expect((await post('/schedule/apply', { ...body, expectedPlanVersion: 2 }, headers)).statusCode).toBe(409);
  });
  test('rejects stale preview after another apply or baseline and enforces 30-minute expiry', async () => {
    const first = await preview(); const second = await preview();
    expect((await post('/schedule/apply', applyBody(first), { 'idempotency-key': 'first-change' })).statusCode).toBe(200);
    const stale = await post('/schedule/apply', applyBody(second), { 'idempotency-key': 'second-change' });
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('PLAN_VERSION_CONFLICT');
    const expiring = await preview({ expectedPlanVersion: 2, changes: [{ taskId: 'task-006', start: '2026-10-06', end: '2026-10-08' }] });
    now = new Date(now.getTime() + 30 * 60_000);
    const expired = await post('/schedule/apply', applyBody(expiring), { 'idempotency-key': 'expired-change' });
    expect(expired.statusCode).toBe(409); expect(expired.json().error.code).toBe('PREVIEW_EXPIRED');
    expect((await plan()).planVersion).toBe(2);
  });
  test('rejects missing tokens and cross-origin writes, including preview generation', async () => {
    for (const headers of [{ 'x-preview-token': '' }, { origin: 'https://untrusted.example' }, { 'x-preview-token': '非'.repeat(64) }] as Record<string, string>[]) {
      expect((await post('/schedule/preview', payload(), headers)).statusCode).toBe(403);
    }
    expect((await plan()).planVersion).toBe(1);
  });
  test('service restart rejects the old token without applying and allows retry after loading the fresh token', async () => {
    const draft = await preview(); const body = applyBody(draft); const headers = { 'idempotency-key': 'restart-retry' };
    await app.close(); app = buildApp({ dbPath, clock: () => now });
    const rejected = await post('/schedule/apply', body, headers);
    expect(rejected.statusCode).toBe(403); expect(rejected.json().error.message).toContain('保留填写内容');
    const current = await plan(); expect(current.planVersion).toBe(1); expect(current.history).toHaveLength(0);
    token = current.writeToken;
    expect((await post('/schedule/apply', body, headers)).statusCode).toBe(200);
  });
  test('rechecks completed status when applying a dependency-only preview', async () => {
    const draft = await preview({ changes: [], dependencyTargetId: 'task-008', incomingDependencies: [{ predecessorId: 'task-001', lagDays: 0 }] });
    expect(draft.canApply).toBe(true); expect(draft.changes).toHaveLength(0);
    const database = new Database(dbPath);
    try { database.prepare("UPDATE homepage_tasks SET status = 'done', progress = 100 WHERE id = 'task-008'").run(); }
    finally { database.close(); }
    const before = await plan();
    const response = await post('/schedule/apply', applyBody(draft), { 'idempotency-key': 'done-dependency' });
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('DONE_IMMUTABLE');
    expect(await plan()).toEqual(before);
  });
  test('a failed audit insert rolls back schedule, homepage, preview and idempotency together', async () => {
    const draft = await preview(); const before = await plan();
    const homepage = (await app.inject(`${prefix}/overview`)).json().data;
    const database = new Database(dbPath);
    try { database.exec("CREATE TRIGGER test_fail_audit BEFORE INSERT ON plan_history BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END;"); }
    finally { database.close(); }
    const headers = { 'idempotency-key': 'rollback-change' };
    expect((await post('/schedule/apply', applyBody(draft), headers)).statusCode).toBe(500);
    expect(await plan()).toEqual(before);
    expect((await app.inject(`${prefix}/overview`)).json().data).toEqual(homepage);
    const recover = new Database(dbPath);
    try { recover.exec('DROP TRIGGER test_fail_audit'); } finally { recover.close(); }
    expect((await post('/schedule/apply', applyBody(draft), headers)).statusCode).toBe(200);
    expect((await plan()).history).toHaveLength(1);
  });
  test('rejects cycles, self-dependencies, negative/fractional lag, cross-project objects and changes to completed/group/gap nodes', async () => {
    for (const edit of [
      { changes: [], dependencyTargetId: 'task-006', incomingDependencies: [{ predecessorId: 'task-007', lagDays: 0 }] },
      { changes: [], dependencyTargetId: 'task-006', incomingDependencies: [{ predecessorId: 'task-006', lagDays: 0 }] },
      { changes: [], dependencyTargetId: 'task-006', incomingDependencies: [{ predecessorId: 'other-project-task', lagDays: 0 }] },
      { changes: [], dependencyTargetId: 'task-006', incomingDependencies: [{ predecessorId: 'gap-operations', lagDays: 0 }] },
      { changes: [], dependencyTargetId: 'task-006', incomingDependencies: [{ predecessorId: 'task-008', lagDays: -1 }] },
      { changes: [], dependencyTargetId: 'task-006', incomingDependencies: [{ predecessorId: 'task-008', lagDays: 0.5 }] },
      ...['task-001', 'group-system-bottom', 'gap-operations'].map(taskId => ({ changes: [{ taskId, start: '2026-10-01', end: '2026-10-01' }] })),
    ]) expect((await post('/schedule/preview', payload(edit))).statusCode).toBe(422);
    expect((await plan()).planVersion).toBe(1);
  });
  test('non-working dates require correction and dependency conflicts keep explicit dates instead of silently shifting', async () => {
    const weekend = await preview({ changes: [{ taskId: 'task-006', start: '2026-10-03', end: '2026-10-05' }] });
    expect(weekend.canApply).toBe(false); expect(weekend.issues.some(issue => issue.code === 'NON_WORKING_DATE')).toBe(true);
    expect(weekend.changes.find(change => change.taskId === 'task-006')!.start).toBe('2026-10-03');
    expect((await post('/schedule/apply', applyBody(weekend), { 'idempotency-key': 'weekend-change' })).statusCode).toBe(422);
    const conflict = await preview({ changes: [{ taskId: 'task-007', start: '2026-09-17', end: '2026-09-18' }] });
    expect(conflict.canApply).toBe(false); expect(conflict.issues.some(issue => issue.code === 'EXPLICIT_DATE_CONFLICT')).toBe(true);
  });
  test('earlier predecessors do not pull successors unless earliest-start is explicitly selected', async () => {
    const before = await plan(); const initial = before.nodes.find(node => node.id === 'task-007')!;
    const changes = [{ taskId: 'task-006', start: '2026-09-14', end: '2026-09-16' }];
    const push = await preview({ changes }); expect(push.changes.some(change => change.taskId === initial.id)).toBe(false);
    const early = await preview({ changes, mode: 'earliest_start' });
    expect(early.changes.find(change => change.taskId === initial.id)!.start).toBe('2026-09-17');
  });
  test('publishing requires explicit gap exclusion and calendar confirmation and creates immutable baseline/version/history', async () => {
    const fixture = new Database(dbPath); configureMilestoneBaselineFixture(fixture); fixture.close();
    const before = await plan(); const stale = await preview();
    for (const extra of [{ excludedIds: [] }, { exclusionReason: '' }, { calendarConfirmed: false }, { excludedIds: ['gap-operations', 'task-001'] }]) {
      expect((await post('/baselines', { ...baselineBody, ...extra })).statusCode).toBe(422);
    }
    const response = await post('/baselines', baselineBody); expect(response.statusCode, response.body).toBe(200);
    expect((await post('/baselines', baselineBody)).json()).toEqual(response.json());
    expect((await post('/baselines', { ...baselineBody, name: '不同承诺' })).statusCode).toBe(409);
    expect(response.json().data.entries).toHaveLength(54); expect(response.json().data.excludedIds).toEqual(['gap-operations']);
    expect(response.json().data.reason).toContain(baselineBody.exclusionReason);
    const after = await plan(); expect(after.baselines).toHaveLength(2); expect(after.baselines[0]).toEqual(before.baselines[0]); expect(after.planVersion).toBe(2); expect(after.calendar.confirmed).toBe(true);
    expect((await post('/schedule/apply', applyBody(stale), { 'idempotency-key': 'baseline-stale' })).statusCode).toBe(409);
    const database = new Database(dbPath);
    try {
      expect(() => database.prepare('DELETE FROM plan_baselines WHERE id = ?').run(before.baselines[0]!.id)).toThrow(/immutable/);
      expect(() => database.prepare('UPDATE plan_baselines SET created_at = ? WHERE id = ?').run('2026-01-01', before.baselines[0]!.id)).toThrow(/immutable/);
    } finally { database.close(); }
    await app.close(); app = buildApp({ dbPath, clock: () => now }); token = (await plan()).writeToken;
    expect((await post('/baselines', baselineBody)).json()).toEqual(response.json());
    expect((await plan()).baselines).toHaveLength(2); expect((await plan()).history).toHaveLength(1);
  });
  test('baseline checks stored task completeness and workday duration before publishing', async () => {
    const database = new Database(dbPath);
    configureMilestoneBaselineFixture(database);
    try {
      const original = database.prepare('SELECT nodes_json FROM plan_projects WHERE project_id = ?').get('phase-one') as { nodes_json: string };
      for (const invalid of [{ durationDays: 0 }, { effortHours: 0 }, { owner: '' }, { start: null }, { end: '2026-09-26' }]) {
        const nodes = JSON.parse(original.nodes_json) as ProjectPlan['nodes'];
        Object.assign(nodes.find(node => node.id === 'task-008')!, invalid);
        database.prepare('UPDATE plan_projects SET nodes_json = ? WHERE project_id = ?').run(JSON.stringify(nodes), 'phase-one');
        const response = await post('/baselines', baselineBody);
        expect(response.statusCode, response.body).toBe(422); expect(response.json().error.code).toBe('BASELINE_INCOMPLETE');
      }
      database.prepare('UPDATE plan_projects SET nodes_json = ? WHERE project_id = ?').run(original.nodes_json, 'phase-one');
    } finally { database.close(); }
    expect((await plan()).baselines).toHaveLength(1); expect((await plan()).planVersion).toBe(1);
  });
});
