import { beforeEach, afterEach, test, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TaskPage, TaskWorkspace } from '../../shared/src/tasks';
import { buildLegacyApp } from '../helpers/legacy-app';
import { seedDateTasks, createDateTask, taskDatePrefix } from '../helpers/task-date-fixture';
let app: FastifyInstance;
beforeEach(async () => { app = buildLegacyApp({ dbPath: ':memory:', jobIntervalMs: 0 }); await seedDateTasks(app); });
afterEach(async () => { await app.close(); });
const range = { dateMode: 'overlap', dateFrom: '2026-09-14', dateTo: '2026-09-20' };
async function query(extra: Record<string, string> = {}) {
  const r = await app.inject(`${taskDatePrefix}/query?${new URLSearchParams({ query: '日期样例', state: 'all', ...extra })}`);
  expect(r.statusCode, r.body).toBe(200); return r.json().data as TaskPage;
}
const titles = (page: {tasks: {title: string}[]}) => page.tasks.map(t => t.title).sort();
test('plan overlap includes touching and spanning intervals; due mode includes only ends within inclusive bounds', async () => {
  expect(titles(await query(range))).toEqual(['日期样例A', '日期样例B', '日期样例C', '日期样例E']);
  expect(titles(await query({ ...range, dateMode: 'due' }))).toEqual(['日期样例A', '日期样例E']);
  expect(titles(await query({ ...range, dateFrom: '2026-09-16', dateTo: '2026-09-18' }))).toEqual(['日期样例A', '日期样例B', '日期样例C']);
  expect(titles(await query({ ...range, dateMode: 'due', dateTo: '2026-09-14' }))).toEqual(['日期样例E']);
});
test('date filtering preserves scope summaries, combines filters, excludes unplanned and supports clearing', async () => {
  const all = await query(), filtered = await query(range);
  expect(all.total).toBe(6); expect(filtered.total).toBe(4);
  expect(filtered.summary).toEqual(all.summary); expect(filtered.scopeCounts).toEqual(all.scopeCounts);
  expect((await query({ ...range, due: 'unplanned' })).total).toBe(0);
  expect((await query({ ...range, state: 'done' })).total).toBe(0);
  expect((await query({ ...range, ownerId: 'zhou' })).total).toBe(0);
  expect((await query({ ...range, scope: 'mine', actorId: 'chen' })).total).toBe(4);
  expect((await query({ ...range, workstreamId: 'worker' })).total).toBe(0);
  expect(titles(await query({ due: 'unplanned' }))).toEqual(['日期样例U']);
});
test('server applies dates before pagination and board counts', async () => {
  for (let i = 0; i < 21; i++) await createDateTask(app, `分页${i}`, '2026-09-14', '2026-09-15');
  const a = await query({ ...range, pageSize: '20' }), b = await query({ ...range, pageSize: '20', page: '2' });
  expect(a.total).toBe(25); expect(a.tasks).toHaveLength(20); expect(b.tasks).toHaveLength(5);
  expect(new Set([...a.tasks, ...b.tasks].map(t => t.id)).size).toBe(25);
  const board = await query({ ...range, boardState: 'todo', pageSize: '20' });
  expect(board.boardCounts.todo).toBe(25); expect(board.total).toBe(25);
});
test('summary parents match aggregate schedules independently from their children', async () => {
  const parent = await createDateTask(app, '父任务', '2026-09-21', '2026-09-22');
  const child = await createDateTask(app, '子任务', '2026-09-14', '2026-09-16', parent);
  const overlap = await query(range), due = await query({ ...range, dateMode: 'due' });
  expect(child.parentId).toBeTruthy();
  expect(overlap.tasks.map(t => t.id)).toContain(child.parentId);
  expect(overlap.tasks.map(t => t.id)).toContain(child.id);
  expect(due.tasks.map(t => t.id)).not.toContain(child.parentId);
  expect(due.tasks.map(t => t.id)).toContain(child.id);
  const workspace = (await app.inject(taskDatePrefix)).json().data as TaskWorkspace;
  const descendants = workspace.tasks.filter(t => t.parentId === child.parentId);
  const original = descendants.find(t => t.id !== child.id)!;
  expect(original).toBeDefined();
  expect(overlap.tasks.map(t => t.id)).not.toContain(original.id);
});
test('applying a schedule change invalidates cached date results', async () => {
  const before = await query(range), task = before.tasks.find(t => t.title === '日期样例E')!;
  const w = (await app.inject(taskDatePrefix)).json().data;
  const write = (path: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1/projects/phase-one/schedule/${path}`,
    headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() }, payload });
  const preview = await write('preview', { expectedPlanVersion: w.planVersion, reason: '验证日期结果更新', mode: 'push_successors', changes: [{ taskId: task.id, start: '2026-10-01', end: '2026-10-02' }] });
  expect(preview.statusCode, preview.body).toBe(200);
  const applied = await write('apply', { expectedPlanVersion: w.planVersion, previewId: preview.json().data.id });
  expect(applied.statusCode, applied.body).toBe(200);
  expect((await query(range)).tasks.map(t => t.id)).not.toContain(task.id);
  expect((await query({ ...range, dateFrom: '2026-10-01', dateTo: '2026-10-02' })).tasks.map(t => t.id)).toContain(task.id);
});
test('rejects partial or malformed date triples without affecting queries without dates', async () => {
  for (const extra of [
    { dateMode: 'due' }, { dateFrom: '2026-09-14', dateTo: '2026-09-20' },
    { ...range, dateMode: 'created' }, { ...range, dateFrom: '2026-02-30' },
    { ...range, dateFrom: '2026-9-14' }, { ...range, dateFrom: '2026-09-21' }, { ...range, dateTo: '' },
  ] as Record<string, string>[]) expect((await app.inject(`${taskDatePrefix}/query?${new URLSearchParams(extra)}`)).statusCode).toBe(422);
  for (const [dateFrom, dateTo] of [['2028-02-29','2028-03-01'],['2026-12-31','2027-01-01'],['2026-09-19','2026-09-20']]) {
    await query({ dateMode: 'overlap', dateFrom: dateFrom!, dateTo: dateTo! });
  }
  expect((await query()).total).toBe(6);
});
