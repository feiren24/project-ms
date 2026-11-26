import type { FastifyInstance } from 'fastify';
import type { ManagedTask, TaskWorkspace } from '../../shared/src/tasks';

export const taskDatePrefix = '/api/v1/projects/phase-one/tasks';
export async function createDateTask(app: FastifyInstance, name: string, start: string | null, end: string | null, parent?: ManagedTask) {
  const w = (await app.inject(taskDatePrefix)).json().data as TaskWorkspace;
  const r = await app.inject({ method: 'POST', url: taskDatePrefix,
    headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() },
    payload: { expectedPlanVersion: w.planVersion, title: `日期样例${name}`, description: '隔离日期筛选测试', workstreamId: 'system-bottom', parentId: parent?.id ?? null,
      ...(parent ? { confirmParentConversion: true, expectedParentVersion: parent.version } : {}),
      ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start, end } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json().data.task as ManagedTask;
}
export async function seedDateTasks(app: FastifyInstance) {
  const tasks: ManagedTask[] = [];
  for (const [name, start, end] of [
    ['A', '2026-09-10', '2026-09-16'], ['B', '2026-09-18', '2026-09-25'],
    ['C', '2026-09-07', '2026-09-30'], ['D', '2026-09-21', '2026-09-22'],
    ['E', '2026-09-14', '2026-09-14'], ['U', null, null],
  ] as const) tasks.push(await createDateTask(app, name, start, end));
  return tasks;
}
