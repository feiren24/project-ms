import { configureMilestoneBaselineFixture } from '../helpers/milestone-fixtures.js';
import { initializeMilestones, readMilestoneRecords, saveMilestoneRecord } from '../../server/src/modules/milestones/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { ManagedTask, TaskDraft, TaskWorkspace } from '../../shared/src/tasks.js';

const prefix = '/api/v1/projects/phase-one';
const draft: TaskDraft = { title: 'DEMO · 测试交付任务', description: '虚构本地任务', workstreamId: 'foundation', parentId: null, ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-10-12', end: '2026-10-13' };
describe('local task management and independent acceptance', () => {
  let directory: string; let dbPath: string; let app: FastifyInstance;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'goodwork-tasks-')); dbPath = join(directory, 'tasks.sqlite'); app = buildApp({ dbPath, clock: () => new Date('2026-09-23T02:00:00Z') }); });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function workspace(): Promise<TaskWorkspace> { const response = await app.inject(`${prefix}/tasks`); expect(response.statusCode).toBe(200); return response.json().data; }
  async function send(path: string, body: object, actor = 'zhou', method: 'POST' | 'PATCH' = 'POST', key = randomUUID()) { const data = await workspace(); return app.inject({ method, url: `${prefix}/tasks${path}`, headers: { 'x-preview-token': data.writeToken, 'x-demo-actor': actor, 'idempotency-key': key }, payload: body }); }
  async function create(extra: Partial<TaskDraft> = {}) { const data = await workspace(); const response = await send('', { ...draft, workstreamId: data.workstreams[0]!.id, ...extra, expectedPlanVersion: data.planVersion }); expect(response.statusCode, response.body).toBe(200); return response.json().data.task as ManagedTask; }
  async function transition(id: string, action: string, extra: object = {}, actor = 'chen') { const data = await workspace(); const task = data.tasks.find(t => t.id === id)!; return send(`/${id}/transition`, { expectedVersion: task.version, expectedPlanVersion: data.planVersion, reason: 'DEMO · 测试操作依据', action, ...extra }, actor); }
  async function update(task: ManagedTask, extra: Partial<TaskDraft>, actor = 'zhou') { const data = await workspace(); const { title, description, workstreamId, parentId, ownerId, priority, effortHours, requiresReview, reviewerId, acceptanceCriteria, evidence } = task; return send(`/${task.id}`, { title, description, workstreamId, parentId, ownerId, priority, effortHours, requiresReview, reviewerId, acceptanceCriteria, evidence, ...extra, expectedVersion: task.version, expectedPlanVersion: data.planVersion }, actor, 'PATCH'); }

  test('preserves fictional snapshot and unknown actual dates; creates synchronized scheduled and unplanned tasks', async () => {
    const before = await workspace(); expect(before.tasks).toHaveLength(48); expect(before.tasks.filter(t => t.status === 'done')).toHaveLength(18);
    expect(before.tasks.every(t => t.actualStart === null && t.actualEnd === null)).toBe(true);
    expect(before.tasks.find(t => t.id === 'task-006')).toMatchObject({ requiresReview: true, reviewerId: 'lin', reviewStatus: 'none', submissions: [] });
    expect(before.actors.map(a => a.id)).toEqual(['zhou', 'chen', 'lin', 'xu']);
    const scheduled = await create(); const unplanned = await create({ start: null, end: null, effortHours: null });
    expect(scheduled.version).toBe(1); expect(scheduled.status).toBe('todo'); expect(unplanned.start).toBeNull();
    const plan = (await app.inject(`${prefix}/gantt`)).json().data;
    expect(plan.nodes.find((n: { id: string }) => n.id === scheduled.id)).toMatchObject({ title: scheduled.title, start: scheduled.start });
    expect(plan.nodes.find((n: { id: string }) => n.id === unplanned.id)).toMatchObject({ start: null, end: null });
    expect(plan.issues.some((i: { objectId: string }) => i.objectId === unplanned.id)).toBe(true);
    const overview = (await app.inject(`${prefix}/overview`)).json().data;
    expect(overview.summary.totalTasks).toBe(50); expect(overview.summary.overdueTasks).toBe(4);
    const baseline = await app.inject({ method: 'POST', url: `${prefix}/baselines`, headers: { 'x-preview-token': before.writeToken }, payload: { expectedPlanVersion: plan.planVersion, name: '测试基线', reason: '测试', calendarConfirmed: true, excludedIds: ['gap-operations'], exclusionReason: 'DEMO 排除范围缺口' } });
    expect(baseline.statusCode).toBe(422); expect(baseline.json().error.code).toBe('BASELINE_INCOMPLETE');
  });

  test('rejects malformed dates, unknown fields, viewer assignment and unsafe links without writes', async () => {
    for (const extra of [{ start: '2026-10-11' }, { start: '2026-02-30' }, { start: null }, { start: '2026-09-01' }, { end: '2026-10-09' }, { ownerId: 'xu' }, { evidence: 'javascript:alert(1)' }, { role: 'manager' }, { status: 'done' }]) {
      const data = await workspace(); const response = await send('', { ...draft, workstreamId: data.workstreams[0]!.id, ...extra, expectedPlanVersion: data.planVersion }); expect(response.statusCode, response.body).toBe(422);
    }
    expect((await workspace()).tasks).toHaveLength(48);
  });

  test('requires local token and actor; owner may update only description/evidence; viewers cannot write', async () => {
    const task = await create();
    const missing = await app.inject({ method: 'POST', url: `${prefix}/tasks`, payload: draft }); expect(missing.statusCode).toBe(403);
    expect((await transition(task.id, 'start', {}, 'xu')).statusCode).toBe(403);
    expect((await update(task, { title: '越权标题' }, 'chen')).statusCode).toBe(403);
    expect((await update(task, { description: '负责人补充说明', evidence: 'https://example.com/demo' }, 'chen')).statusCode).toBe(200);
    const data = await workspace(); const response = await send(`/${task.id}/comments`, { expectedVersion: 2, expectedPlanVersion: data.planVersion, text: 'DEMO · 独立验收人讨论' }, 'lin');
    expect(response.statusCode).toBe(200); expect(response.json().data.task.events.at(-1).actor).toBe('林若宁');
    const foreign = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers: { 'x-preview-token': data.writeToken, origin: 'https://evil.example', 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: draft }); expect(foreign.statusCode).toBe(403);
  });

  test('atomically checks plan/task versions and replays idempotent writes after restart', async () => {
    const task = await create(); const data = await workspace(); const key = randomUUID();
    const body = { expectedVersion: task.version, expectedPlanVersion: data.planVersion, reason: '开始执行', action: 'start' };
    const first = await send(`/${task.id}/transition`, body, 'chen', 'POST', key); expect(first.statusCode).toBe(200);
    expect((await send(`/${task.id}/transition`, body, 'chen')).statusCode).toBe(409);
    const newer = await workspace(); const stale = await send(`/${task.id}/transition`, { ...body, expectedPlanVersion: newer.planVersion }); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('TASK_VERSION_CONFLICT');
    await app.close(); app = buildApp({ dbPath });
    const replay = await send(`/${task.id}/transition`, body, 'chen', 'POST', key); expect(replay.json()).toEqual(first.json());
    expect((await send(`/${task.id}/transition`, { ...body, reason: '不同内容' }, 'chen', 'POST', key)).statusCode).toBe(409);
    expect((await workspace()).tasks.find(t => t.id === task.id)?.events).toHaveLength(2);
  });

  test('ordinary completion records dates, respects independent blocker and protects completed commitments', async () => {
    const task = await create(); expect((await transition(task.id, 'start')).statusCode).toBe(200);
    let response = await transition(task.id, 'block', { reason: '接口不可用' }); expect(response.json().data.task.status).toBe('in_progress');
    expect((await transition(task.id, 'complete')).json().error.code).toBe('TASK_BLOCKED');
    expect((await transition(task.id, 'progress', { progress: 40 })).statusCode).toBe(200);
    expect((await transition(task.id, 'unblock')).statusCode).toBe(200);
    response = await transition(task.id, 'complete'); expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({ status: 'done', progress: 100, actualStart: '2026-09-23', actualEnd: '2026-09-23' });
    expect((await update(response.json().data.task, { title: '完成后修改' })).statusCode).toBe(422);
    expect((await transition(task.id, 'reopen', { reason: '', progress: 20 })).statusCode).toBe(422);
    response = await transition(task.id, 'reopen', { progress: 20 }); expect(response.statusCode).toBe(200); expect(response.json().data.task).toMatchObject({ status: 'in_progress', progress: 20, actualEnd: null });
  });

  test('key deliverables require evidence and independent review, retain rejected snapshots and reject stale submissions', async () => {
    const task = await create({ requiresReview: true, reviewerId: 'lin', acceptanceCriteria: '可验证结果' });
    await transition(task.id, 'start'); expect((await transition(task.id, 'complete')).json().error.code).toBe('REVIEW_REQUIRED');
    expect((await transition(task.id, 'submit')).json().error.code).toBe('EVIDENCE_REQUIRED');
    let response = await transition(task.id, 'submit', { evidence: 'DEMO · 第一版交付说明' }); expect(response.statusCode).toBe(200);
    const first = response.json().data.task.submissions[0];
    expect(first.snapshot).toMatchObject({ acceptanceCriteria: '可验证结果', ownerId: 'chen' });
    expect((await transition(task.id, 'accept', { submissionId: first.id })).statusCode).toBe(403);
    expect((await transition(task.id, 'accept', { submissionId: 'old-version' }, 'lin')).statusCode).toBe(409);
    response = await transition(task.id, 'reject', { submissionId: first.id, reason: '缺少异常处理' }, 'lin'); expect(response.statusCode).toBe(200);
    expect(response.json().data.task.status).toBe('in_progress');
    expect((await update(response.json().data.task, { requiresReview: false, reviewerId: null })).statusCode).toBe(422);
    expect((await update(response.json().data.task, { acceptanceCriteria: '补充异常处理验证' })).statusCode).toBe(200);
    response = await transition(task.id, 'submit', { evidence: 'DEMO · 修订交付说明' }); const second = response.json().data.task.submissions[1];
    expect((await transition(task.id, 'accept', { submissionId: first.id }, 'lin')).statusCode).toBe(409);
    response = await transition(task.id, 'accept', { submissionId: second.id, reason: '已核对全部标准' }, 'lin'); expect(response.statusCode).toBe(200);
    expect(response.json().data.task).toMatchObject({ status: 'done', progress: 100, reviewStatus: 'accepted' });
    expect(response.json().data.task.submissions[0]).toMatchObject({ evidence: 'DEMO · 第一版交付说明', status: 'rejected', comment: '缺少异常处理' });
    expect(response.json().data.task.submissions[0].snapshot.acceptanceCriteria).toBe('可验证结果');
    expect(response.json().data.task.submissions[1].snapshot.acceptanceCriteria).toBe('补充异常处理验证');
    await transition(task.id, 'reopen', { progress: 70 });
    expect((await workspace()).tasks.find(t => t.id === task.id)?.submissions[1]).toMatchObject({ evidence: 'DEMO · 修订交付说明', status: 'accepted' });
  });

  test('batch validates every task and rolls back without silent permission or version skips', async () => {
    const first = await create(); const second = await create(); const data = await workspace();
    const body = { expectedPlanVersion: data.planVersion, items: [{ id: first.id, expectedVersion: 1 }, { id: second.id, expectedVersion: 0 }], patch: { priority: 'P0' }, reason: 'DEMO · 统一优先级' };
    expect((await send('/batch', body)).statusCode).toBe(422);
    let current = await workspace(); expect(current.planVersion).toBe(data.planVersion); expect(current.tasks.find(t => t.id === first.id)?.priority).toBe('P1');
    body.items[1]!.expectedVersion = 1;
    expect((await send('/batch', body, 'chen')).statusCode).toBe(403);
    const response = await send('/batch', body); expect(response.statusCode).toBe(200); expect(response.json().data.affectedCount).toBe(2);
    current = await workspace(); expect(current.tasks.find(t => t.id === second.id)).toMatchObject({ priority: 'P0', version: 2 });
  });

  test('cancel excludes counts and Gantt yet preserves history and dates for reopen after schedule apply', async () => {
    const task = await create(); const other = await create();
    const cancelled = await transition(task.id, 'cancel', {}, 'zhou'); expect(cancelled.statusCode).toBe(200);
    let plan = (await app.inject(`${prefix}/gantt`)).json().data; expect(plan.nodes.some((n: { id: string }) => n.id === task.id)).toBe(false);
    const preview = await app.inject({ method: 'POST', url: `${prefix}/schedule/preview`, headers: { 'x-preview-token': plan.writeToken }, payload: { expectedPlanVersion: plan.planVersion, reason: 'DEMO · 移动另一任务', changes: [{ taskId: other.id, start: '2026-10-14', end: '2026-10-15' }], mode: 'push_successors' } }); expect(preview.statusCode, preview.body).toBe(200);
    const apply = await app.inject({ method: 'POST', url: `${prefix}/schedule/apply`, headers: { 'x-preview-token': plan.writeToken, 'idempotency-key': randomUUID() }, payload: { expectedPlanVersion: plan.planVersion, previewId: preview.json().data.id } }); expect(apply.statusCode).toBe(200);
    expect((await app.inject(`${prefix}/overview`)).json().data.summary.totalTasks).toBe(49);
    const reopened = await transition(task.id, 'reopen', { progress: 0 }); expect(reopened.statusCode).toBe(200); expect(reopened.json().data.task.start).toBe(task.start);
    plan = (await app.inject(`${prefix}/gantt`)).json().data; expect(plan.nodes.some((n: { id: string }) => n.id === task.id)).toBe(true);
  });

  test('task mutations invalidate existing Gantt previews and cannot rewrite dates through task patch', async () => {
    const task = await create(); const data = await workspace();
    const preview = await app.inject({ method: 'POST', url: `${prefix}/schedule/preview`, headers: { 'x-preview-token': data.writeToken }, payload: { expectedPlanVersion: data.planVersion, reason: '测试预览', changes: [{ taskId: task.id, start: '2026-10-14', end: '2026-10-15' }], mode: 'push_successors' } }); expect(preview.statusCode).toBe(200);
    expect((await update(task, { start: '2026-10-15', end: '2026-10-16' })).json().error.code).toBe('DATES_USE_GANTT');
    await transition(task.id, 'start'); const current = await workspace();
    const apply = await app.inject({ method: 'POST', url: `${prefix}/schedule/apply`, headers: { 'x-preview-token': data.writeToken, 'idempotency-key': randomUUID() }, payload: { expectedPlanVersion: current.planVersion, previewId: preview.json().data.id } }); expect(apply.statusCode).toBe(409);
  });

  test('submitted acceptance scope cannot silently change through Gantt dates or incoming dependencies', async () => {
    const task = await create({ requiresReview: true, reviewerId: 'lin', acceptanceCriteria: '验证标准', evidence: 'DEMO · 交付成果' });
    await transition(task.id, 'start'); await transition(task.id, 'submit'); const data = await workspace();
    for (const change of [
      { changes: [{ taskId: task.id, start: '2026-10-14', end: '2026-10-15' }] },
      { changes: [], dependencyTargetId: task.id, incomingDependencies: [{ predecessorId: 'task-001', lagDays: 0 }] },
    ]) {
      const response = await app.inject({ method: 'POST', url: `${prefix}/schedule/preview`, headers: { 'x-preview-token': data.writeToken }, payload: { expectedPlanVersion: data.planVersion, reason: '试图变更待验收承诺', mode: 'push_successors', ...change } });
      expect(response.statusCode, response.body).toBe(422); expect(response.json().error.code).toBe('REVIEW_PENDING');
    }
    expect((await workspace()).planVersion).toBe(data.planVersion);
    expect((await workspace()).tasks.find(t => t.id === task.id)).toMatchObject({ reviewStatus: 'submitted', start: task.start, end: task.end });
  });

  async function convert(parent: ManagedTask, extra: Partial<TaskDraft> = {}) {
    const data = await workspace();
    const payload = { ...draft, workstreamId: parent.workstreamId, parentId: parent.id, ...extra, expectedPlanVersion: data.planVersion, confirmParentConversion: true, expectedParentVersion: parent.version };
    const response = await send('', payload); expect(response.statusCode, response.body).toBe(200); return response.json().data;
  }

  test('conversion preview is read only and atomic conversion preserves execution identity and references', async () => {
    const original = await create({ evidence: 'DEMO retained evidence', requiresReview: true, reviewerId: 'lin', acceptanceCriteria: '保留标准' });
    const baselineFixture = new Database(dbPath); configureMilestoneBaselineFixture(baselineFixture); baselineFixture.close();
    const baselinePlan = (await app.inject(`${prefix}/gantt`)).json().data;
    const baseline = await app.inject({ method: 'POST', url: `${prefix}/baselines`, headers: { 'x-preview-token': baselinePlan.writeToken }, payload: { expectedPlanVersion: baselinePlan.planVersion, name: '转换前基线', reason: '保留原始执行引用', calendarConfirmed: true, excludedIds: ['gap-operations'], exclusionReason: 'DEMO 排除范围缺口' } });
    expect(baseline.statusCode, baseline.body).toBe(200);
    const fixture = new Database(dbPath);
    const baselineBefore = fixture.prepare('SELECT snapshot_json FROM plan_baselines').all();
    const edges = JSON.parse((fixture.prepare('SELECT dependencies_json FROM plan_projects').get() as { dependencies_json: string }).dependencies_json);
    edges.push({ predecessorId: original.id, successorId: 'task-006', type: 'FS', lagDays: 0 });
    fixture.prepare('UPDATE plan_projects SET dependencies_json=?').run(JSON.stringify(edges)); fixture.close();
    await transition(original.id, 'start');
    const submitted = await transition(original.id, 'submit'); expect(submitted.statusCode).toBe(200);
    await transition(original.id, 'reject', { submissionId: submitted.json().data.task.submissions[0].id, reason: '补充说明' }, 'lin');
    await transition(original.id, 'progress', { progress: 45 });
    const before = await workspace(); const parent = before.tasks.find(t => t.id === original.id)!;
    const preview = await send('/parent-preview', { parentId: parent.id, workstreamId: parent.workstreamId, expectedPlanVersion: before.planVersion });
    expect(preview.statusCode, preview.body).toBe(200); expect(preview.json().data).toMatchObject({ mode: 'convert', expectedParentVersion: parent.version, executionCountDelta: 1 });
    expect(await workspace()).toEqual(before);
    const unconfirmed = await send('', { ...draft, workstreamId: parent.workstreamId, parentId: parent.id, expectedPlanVersion: before.planVersion });
    expect(unconfirmed.json().error.code).toBe('PARENT_CONFIRMATION_REQUIRED');
    const payload = { ...draft, workstreamId: parent.workstreamId, parentId: parent.id, expectedPlanVersion: before.planVersion, confirmParentConversion: true, expectedParentVersion: parent.version };
    expect((await send('', { ...payload, expectedParentVersion: 1 })).statusCode).toBe(409);
    expect((await send('', payload, 'chen')).statusCode).toBe(403);
    const key = randomUUID(); const result = await send('', payload, 'zhou', 'POST', key); expect(result.statusCode, result.body).toBe(200);
    const { parentTask, task, reparentedTaskId } = result.json().data;
    expect(parentTask).toMatchObject({ taskKind: 'summary', parentId: null, title: parent.title }); expect(reparentedTaskId).toBe(parent.id);
    expect(task.parentId).toBe(parentTask.id);
    const after = await workspace(); const retained = after.tasks.find(t => t.id === parent.id)!;
    expect(retained).toMatchObject({ parentId: parentTask.id, originalWork: true, wbs: parent.wbs, status: parent.status, progress: 45, evidence: parent.evidence, requiresReview: true, start: parent.start, end: parent.end, effortHours: parent.effortHours });
    expect(retained.submissions).toEqual(parent.submissions); expect(retained.events.slice(0, -1)).toEqual(parent.events); expect(after.dependencies).toEqual(before.dependencies);
    const verifyDb = new Database(dbPath); expect(verifyDb.prepare('SELECT snapshot_json FROM plan_baselines').all()).toEqual(baselineBefore); verifyDb.close();
    expect(after.planVersion).toBe(before.planVersion + 1); expect(after.tasks.length).toBe(before.tasks.length + 2);
    expect((await send('', payload, 'zhou', 'POST', key)).json()).toEqual(result.json());
    expect((await app.inject(`${prefix}/overview`)).json().data.summary.totalTasks).toBe(50);
  });

  test('two-level summary accepts further children, remains a summary when empty and rejects execution or third levels', async () => {
    const original = await create(); const { parentTask, task: child } = await convert(original);
    let data = await workspace(); const summary = data.tasks.find(t => t.id === parentTask.id)!;
    expect((await send('', { ...draft, workstreamId: child.workstreamId, parentId: child.id, expectedPlanVersion: data.planVersion })).json().error.code).toBe('MAX_TASK_DEPTH');
    expect((await update(summary, { parentId: child.id, effortHours: null })).statusCode).toBe(422);
    expect((await transition(summary.id, 'complete')).json().error.code).toBe('SUMMARY_READ_ONLY');
    expect((await transition(summary.id, 'cancel', {}, 'zhou')).json().error.code).toBe('TASK_REFERENCED');
    for (let attempt = 0; attempt < 2; attempt++) { const current = (await workspace()).tasks.find(t => t.id === child.id)!; expect((await update(current, { description: `edit ${attempt}` })).statusCode).toBe(200); }
    await transition(child.id, 'complete'); await transition(original.id, 'complete');
    expect((await workspace()).tasks.find(t => t.id === summary.id)?.status).toBe('done');
    // Persisted rollups may carry done after earlier versions or planning writes.
    const rollupFixture = new Database(dbPath); rollupFixture.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id=?").run(summary.id); rollupFixture.close();
    const next = await create({ parentId: summary.id }); expect(next.parentId).toBe(summary.id);
    for (let attempt = 0; attempt < 2; attempt++) { const current = (await workspace()).tasks.find(t => t.id === next.id)!; expect((await update(current, { description: `after-done edit ${attempt}` })).statusCode).toBe(200); }
    for (const id of [child.id, original.id]) await transition(id, 'reopen', { progress: 0 });
    for (const id of [child.id, original.id, next.id]) expect((await transition(id, 'cancel', {}, 'zhou')).statusCode).toBe(200);
    await app.close(); app = buildApp({ dbPath }); data = await workspace();
    expect(data.tasks.find(t => t.id === summary.id)).toMatchObject({ taskKind: 'summary', isContainer: true, status: 'todo', progress: 0, start: null, end: null, effortHours: null });
    expect((await transition(summary.id, 'start')).json().error.code).toBe('SUMMARY_READ_ONLY');
    expect((await app.inject(`${prefix}/overview`)).json().data.summary.totalTasks).toBe(48);
    expect((await app.inject(`${prefix}/gantt`)).json().data.nodes.find((n: { id: string }) => n.id === summary.id)).toMatchObject({ kind: 'group', effortHours: null, start: null, progress: 0 });
  });

  test('manager restores cancelled summary without execution progress or review changes', async () => {
    const original = await create(); const { parentTask, task } = await convert(original);
    await transition(original.id, 'complete'); await transition(task.id, 'complete');
    const fixture = new Database(dbPath);
    fixture.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.cancelled',1,'$.requiresReview',json('true'),'$.reviewStatus','accepted') WHERE task_id=?").run(parentTask.id); fixture.close();
    expect((await transition(parentTask.id, 'reopen', {}, 'chen')).statusCode).toBe(403);
    const restored = await transition(parentTask.id, 'reopen', {}, 'zhou'); expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().data.task).toMatchObject({ taskKind: 'summary', status: 'done', progress: 100, reviewStatus: 'accepted', requiresReview: true, actualStart: null, actualEnd: null });
    const plan = (await app.inject(`${prefix}/gantt`)).json().data;
    expect(plan.nodes.find((node: { id: string }) => node.id === parentTask.id)).toMatchObject({ kind: 'group', status: 'done', progress: 100 });
  });

  test('summary blocked state matches descendant execution tasks in workspace and Gantt', async () => {
    const original = await create(); await transition(original.id, 'block', { reason: '等待接口' });
    const current = (await workspace()).tasks.find(t => t.id === original.id)!;
    const { parentTask } = await convert(current);
    for (const expected of [true, false]) {
      if (!expected) await transition(original.id, 'unblock', { reason: '接口已就绪' });
      expect((await workspace()).tasks.find(t => t.id === parentTask.id)?.blocked).toBe(expected);
      const plan = (await app.inject(`${prefix}/gantt`)).json().data;
      expect(plan.nodes.find((node: { id: string }) => node.id === parentTask.id)?.blocked).toBe(expected);
    }
  });

  test('batch rejects summaries atomically without modifying earlier execution items', async () => {
    const original = await create(); const { parentTask, task } = await convert(original);
    const before = await workspace();
    for (const patch of [{ priority: 'P0' }, { ownerId: 'zhou' }]) {
      const response = await send('/batch', { expectedPlanVersion: before.planVersion, items: [{ id: task.id, expectedVersion: task.version }, { id: parentTask.id, expectedVersion: parentTask.version }], patch, reason: '验证汇总只读' });
      expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('SUMMARY_READ_ONLY'); expect(await workspace()).toEqual(before);
    }
  });

  test('preview rejects cross-workstream, completed, cancelled, pending review and stale versions; conversion retains historical viewer owner', async () => {
    const original = await create();
    for (const [action, extra] of [['complete', {}], ['reopen', { progress: 0 }], ['cancel', {}]] as const) {
      expect((await transition(original.id, action, extra, 'zhou')).statusCode).toBe(200);
      if (action === 'reopen') continue;
      const data = await workspace();
      expect((await send('/parent-preview', { parentId: original.id, workstreamId: original.workstreamId, expectedPlanVersion: data.planVersion })).json().error.code).toBe('PARENT_UNAVAILABLE');
    }
    const review = await create({ requiresReview: true, reviewerId: 'lin', acceptanceCriteria: '标准', evidence: '成果' });
    await transition(review.id, 'start'); await transition(review.id, 'submit'); let data = await workspace();
    expect((await send('/parent-preview', { parentId: review.id, workstreamId: review.workstreamId, expectedPlanVersion: data.planVersion })).json().error.code).toBe('PARENT_UNAVAILABLE');
    expect((await send('/parent-preview', { parentId: review.id, workstreamId: 'wrong', expectedPlanVersion: data.planVersion })).json().error.code).toBe('INVALID_PARENT');
    expect((await send('/parent-preview', { parentId: review.id, workstreamId: review.workstreamId, expectedPlanVersion: data.planVersion - 1 })).statusCode).toBe(409);
    const historical = await create(); const fixture = new Database(dbPath);
    fixture.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.ownerId','xu') WHERE task_id=?").run(historical.id);
    fixture.prepare("UPDATE homepage_tasks SET owner='许景行' WHERE id=?").run(historical.id); fixture.close();
    const conversion = await convert(historical); data = await workspace();
    expect(data.tasks.find(t => t.id === historical.id)).toMatchObject({ ownerId: 'xu', owner: '许景行', originalWork: true });
    expect(conversion.parentTask).toMatchObject({ ownerId: 'xu', owner: '许景行' });
    expect(conversion.task.ownerId).toBe('chen');
  });

  test('late storage failure rolls back every conversion node, version, event and receipt', async () => {
    const original = await create(); const before = await workspace(); const fixture = new Database(dbPath);
    fixture.exec("CREATE TRIGGER reject_task_receipt BEFORE INSERT ON task_idempotency BEGIN SELECT RAISE(ABORT, 'test simulated storage failure'); END;");
    const failed = await send('', { ...draft, workstreamId: original.workstreamId, parentId: original.id, expectedPlanVersion: before.planVersion, confirmParentConversion: true, expectedParentVersion: original.version });
    expect(failed.statusCode).toBe(500); expect(await workspace()).toEqual(before);
    fixture.exec('DROP TRIGGER reject_task_receipt'); fixture.close();
    expect((await convert(original)).reparentedTaskId).toBe(original.id);
  });

  test('predecessor blocks completion and cancellation; reopening invalidates accepted dependent and linked milestone', async () => {
    const upstream = await create(); const downstream = await create({ requiresReview: true, reviewerId: 'lin', acceptanceCriteria: '关键验收标准', evidence: 'DEMO · 成果说明' });
    const db = new Database(dbPath);
    const row = db.prepare('SELECT nodes_json,dependencies_json FROM plan_projects WHERE project_id=?').get('phase-one') as { nodes_json: string; dependencies_json: string };
    const nodes = JSON.parse(row.nodes_json); const milestone = nodes.find((n: { kind: string }) => n.kind === 'milestone');
    milestone.status = 'done'; milestone.progress = 100;
    const edges = JSON.parse(row.dependencies_json); edges.push({ predecessorId: upstream.id, successorId: downstream.id, type: 'FS', lagDays: 0 }, { predecessorId: downstream.id, successorId: milestone.id, type: 'FS', lagDays: 0 });
    db.prepare('UPDATE plan_projects SET nodes_json=?,dependencies_json=? WHERE project_id=?').run(JSON.stringify(nodes), JSON.stringify(edges), 'phase-one');
    initializeMilestones(db, new Date('2026-09-23T02:00:00Z')); db.close();
    await transition(downstream.id, 'start'); expect((await transition(downstream.id, 'submit')).json().error.code).toBe('PREDECESSOR_INCOMPLETE');
    expect((await transition(upstream.id, 'cancel', {}, 'zhou')).json().error.code).toBe('TASK_REFERENCED');
    await transition(upstream.id, 'start'); await transition(upstream.id, 'complete');
    const submission = (await transition(downstream.id, 'submit')).json().data.task.submissions[0];
    expect((await transition(downstream.id, 'accept', { submissionId: submission.id }, 'lin')).statusCode).toBe(200);
    const milestoneFixture = new Database(dbPath);
    const record = readMilestoneRecords(milestoneFixture, 'phase-one').find(item => item.id === milestone.id)!;
    saveMilestoneRecord(milestoneFixture, 'phase-one', {...record,state:'accepted',acceptedAt:'2026-09-23T02:00:00.000Z',criteria:[{id:'dependency',kind:'task',title:'必要成果',taskId:downstream.id}]});
    milestoneFixture.close();
    expect((await transition(upstream.id, 'reopen', { progress: 80 })).statusCode).toBe(200);
    const after = await workspace(); expect(after.tasks.find(t => t.id === downstream.id)).toMatchObject({ reviewStatus: 'needs_review', status: 'in_progress', actualEnd: null });
    expect(after.tasks.find(t => t.id === downstream.id)?.submissions[0]?.status).toBe('accepted');
    expect((await app.inject(`${prefix}/overview`)).json().data.milestones.find((m: { id: string }) => m.id === milestone.id).status).toBe('review');
  });

  test('cancelled child history prevents parent cancellation and reopening validates every ancestor atomically', async () => {
    const grandparent = await create({ effortHours: null });
    const parent = await create({ effortHours: null });
    const child = await create();
    const fixture = new Database(dbPath);
    for (const [id, parentId] of [[parent.id, grandparent.id], [child.id, parent.id]]) fixture.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.parentId',?) WHERE task_id=?").run(parentId, id);
    const fixtureRow = fixture.prepare('SELECT nodes_json FROM plan_projects').get() as { nodes_json: string };
    const fixtureNodes = JSON.parse(fixtureRow.nodes_json);
    for (const [id, parentId] of [[parent.id, grandparent.id], [child.id, parent.id]]) fixtureNodes.find((n: { id: string }) => n.id === id).parentId = parentId;
    fixture.prepare('UPDATE plan_projects SET nodes_json=?').run(JSON.stringify(fixtureNodes)); fixture.close();
    expect((await transition(child.id, 'cancel', {}, 'zhou')).statusCode).toBe(200);
    const cancelledParent = await transition(parent.id, 'cancel', {}, 'zhou');
    expect(cancelledParent.statusCode).toBe(422); expect(cancelledParent.json().error.code).toBe('TASK_REFERENCED');
    // Simulate an older persisted state where a distant ancestor was cancelled.
    const db = new Database(dbPath);
    db.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.cancelled',1) WHERE task_id=?").run(grandparent.id); db.close();
    const before = await workspace();
    expect(before.tasks.find(t => t.id === grandparent.id)?.status).toBe('cancelled');
    const blocked = await transition(child.id, 'reopen', { progress: 10 });
    expect(blocked.statusCode).toBe(422); expect(blocked.json().error.code).toBe('PARENT_CANCELLED');
    const after = await workspace(); expect(after.planVersion).toBe(before.planVersion);
    expect(after.tasks.find(t => t.id === child.id)).toEqual(before.tasks.find(t => t.id === child.id));
    expect(after.tasks.find(t => t.id === parent.id)?.version).toBe(before.tasks.find(t => t.id === parent.id)?.version);
    expect((await transition(grandparent.id, 'reopen', { progress: 0 }, 'zhou')).statusCode).toBe(200);
    expect((await transition(child.id, 'reopen', { progress: 10 })).statusCode).toBe(200);
    const plan = (await app.inject(`${prefix}/gantt`)).json().data;
    const ids = new Set(plan.nodes.map((node: { id: string }) => node.id));
    for (const node of plan.nodes.filter((node: { id: string }) => [parent.id, child.id].includes(node.id))) expect(ids.has(node.parentId)).toBe(true);
  });

  test('reopening a nested completed leaf restores all completed ancestor rollups and clears their actual end dates', async () => {
    const grandparent = await create({ effortHours: null });
    const parent = await create({ effortHours: null });
    const child = await create();
    const fixture = new Database(dbPath);
    for (const [id, parentId] of [[parent.id, grandparent.id], [child.id, parent.id]]) fixture.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.parentId',?) WHERE task_id=?").run(parentId, id);
    const fixtureRow = fixture.prepare('SELECT nodes_json FROM plan_projects').get() as { nodes_json: string };
    const fixtureNodes = JSON.parse(fixtureRow.nodes_json);
    for (const [id, parentId] of [[parent.id, grandparent.id], [child.id, parent.id]]) fixtureNodes.find((n: { id: string }) => n.id === id).parentId = parentId;
    fixture.prepare('UPDATE plan_projects SET nodes_json=?').run(JSON.stringify(fixtureNodes)); fixture.close();
    expect((await transition(child.id, 'complete')).statusCode).toBe(200);
    const before = await workspace();
    for (const id of [parent.id, grandparent.id]) expect(before.tasks.find(t => t.id === id)).toMatchObject({ status: 'done', progress: 100, actualEnd: null });
    expect((await transition(child.id, 'reopen', { progress: 35 })).statusCode).toBe(200);
    const after = await workspace(); expect(after.planVersion).toBe(before.planVersion + 1);
    for (const id of [parent.id, grandparent.id]) {
      const restored = after.tasks.find(t => t.id === id)!;
      expect(restored).toMatchObject({ status: 'in_progress', progress: 35, actualEnd: null, isContainer: true });
      expect(restored.version).toBe(before.tasks.find(t => t.id === id)!.version + 1);
      expect(restored.events.at(-1)?.action).toBe('child_reopened');
    }
    const plan = (await app.inject(`${prefix}/gantt`)).json().data;
    for (const id of [parent.id, grandparent.id]) expect(plan.nodes.find((node: { id: string }) => node.id === id)).toMatchObject({ kind: 'group', status: 'in_progress', progress: 35 });
    const overview = (await app.inject(`${prefix}/overview`)).json().data;
    expect(overview.summary).toMatchObject({ totalTasks: 49, completedTasks: 18 });
    await app.close(); app = buildApp({ dbPath });
    expect((await workspace()).tasks.find(t => t.id === grandparent.id)).toMatchObject({ status: 'in_progress', actualEnd: null, progress: 35 });
  });
  test('members create and assign complete tasks but only managers convert an execution parent', async () => {
    let w = await workspace();
    let response = await send('', { ...draft, workstreamId: w.workstreams[0]!.id, ownerId: 'lin', reviewerId: 'chen', requiresReview: true, acceptanceCriteria: '可验证成果', expectedPlanVersion: w.planVersion }, 'chen');
    expect(response.statusCode, response.body).toBe(200); const task = response.json().data.task as ManagedTask;
    expect(task).toMatchObject({ ownerId: 'lin', reviewerId: 'chen' });
    expect((await transition(task.id, 'start', {}, 'chen')).statusCode).toBe(403);
    w = await workspace();
    const previewBody = { parentId: task.id, workstreamId: task.workstreamId, expectedPlanVersion: w.planVersion };
    expect((await send('/parent-preview', previewBody, 'chen')).statusCode).toBe(403);
    const childBody = { ...draft, workstreamId: task.workstreamId, parentId: task.id, expectedPlanVersion: w.planVersion, expectedParentVersion: task.version, confirmParentConversion: true };
    expect((await send('', childBody, 'chen')).statusCode).toBe(403);
    const converted = await send('', childBody, 'zhou'); expect(converted.statusCode, converted.body).toBe(200);
    const summary = converted.json().data.parentTask as ManagedTask; w = await workspace();
    expect((await send('/parent-preview', { parentId: summary.id, workstreamId: task.workstreamId, expectedPlanVersion: w.planVersion }, 'chen')).json().data.mode).toBe('summary');
    response = await send('', { ...draft, workstreamId: task.workstreamId, parentId: summary.id, expectedPlanVersion: w.planVersion }, 'chen');
    expect(response.statusCode, response.body).toBe(200); expect(response.json().data.task.parentId).toBe(summary.id);
  });

  test('manager and project administrator may review any submission including self and record actual reviewer separately', async () => {
    const fixture = new Database(dbPath); fixture.prepare("UPDATE project_members SET role='project_admin' WHERE id='lin'").run(); fixture.close();
    for (const actorId of ['zhou', 'lin']) {
      const task = await create({ ownerId: actorId, requiresReview: true, reviewerId: 'chen', acceptanceCriteria: '自审也须提供依据', evidence: '可检查的成果' });
      expect((await transition(task.id, 'start', {}, actorId)).statusCode).toBe(200);
      const submitted = await transition(task.id, 'submit', {}, actorId); expect(submitted.statusCode, submitted.body).toBe(200);
      const submission = submitted.json().data.task.submissions.at(-1);
      expect((await transition(task.id, 'accept', { submissionId: submission.id, reason: '' }, actorId)).json().error.code).toBe('REASON_REQUIRED');
      const accepted = await transition(task.id, 'accept', { submissionId: submission.id, reason: '管理者核对交付，承担自审责任' }, actorId);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().data.task.submissions.at(-1)).toMatchObject({ reviewerId: 'chen', reviewedById: actorId, selfReview: true, status: 'accepted' });
    }
    const task = await create({ requiresReview: true, reviewerId: 'chen', ownerId: 'lin', acceptanceCriteria: '独立成果', evidence: '成果' });
    await transition(task.id, 'start', {}, 'lin'); const submitted = await transition(task.id, 'submit', {}, 'lin');
    const accepted = await transition(task.id, 'accept', { submissionId: submitted.json().data.task.submissions.at(-1).id }, 'zhou');
    expect(accepted.statusCode).toBe(200); expect(accepted.json().data.task.submissions.at(-1)).toMatchObject({ reviewerId: 'chen', reviewedById: 'zhou', selfReview: false });
  });

});
