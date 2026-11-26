import { describe, expect, test } from 'vitest';
import type { PlanNode, ProjectPlan } from '../../shared/src/planning.js';
import { defaultCalendar } from '../../server/src/modules/planning/calendar.js';
import { analyzePlan, createPreview } from '../../server/src/modules/planning/scheduler.js';

function task(id: string, start: string, end: string, extra: Partial<PlanNode> = {}): PlanNode {
  return { id, parentId: null, workstreamId: 'stream', wbs: id, kind: 'task', title: id, description: 'DEMO', owner: '示例负责人', color: 'blue', status: 'todo', start, end, durationDays: 2, effortHours: 16, progress: 0, blocked: false, ...extra };
}
function project(nodes: PlanNode[], end = '2026-09-24'): ProjectPlan {
  return { mode: 'demo', project: { isDemo: true, id: 'demo', name: 'DEMO', start: '2026-09-21', end, asOf: '2026-09-21' }, planVersion: 1, writeToken: '', nodes, calendar: structuredClone(defaultCalendar), dependencies: [{ predecessorId: 'a', successorId: 'b', type: 'FS', lagDays: 0 }], baselines: [], issues: [], criticalIds: [], criticalCoverage: { complete: true, message: '' }, history: [] };
}
describe('planning topology and calculation boundaries', () => {
  test('critical path identifies zero/negative total float against project deadline and reports missing scope coverage', () => {
    const nodes = [task('a', '2026-09-21', '2026-09-22'), task('b', '2026-09-23', '2026-09-24')];
    expect(analyzePlan(project(nodes)).criticalIds.sort()).toEqual(['a', 'b']);
    expect(analyzePlan(project(nodes, '2026-09-23')).criticalIds.sort()).toEqual(['a', 'b']);
    expect(analyzePlan(project(nodes, '2026-09-25')).criticalIds).toEqual([]);
    const missing = task('gap', '', '', { kind: 'gap', start: null, end: null, durationDays: null });
    const analysis = analyzePlan(project([...nodes, missing]));
    expect(analysis.criticalCoverage.complete).toBe(false);
    expect(analysis.criticalCoverage.message).toContain('1 个范围缺口');
  });
  test('milestone FS zero lag may finish the same day, with a following ordinary task starting next workday', () => {
    const nodes = [task('a', '2026-09-21', '2026-09-22'), task('b', '2026-09-22', '2026-09-22', { kind: 'milestone', durationDays: 0, effortHours: null }), task('c', '2026-09-23', '2026-09-24')];
    const plan = project(nodes);
    plan.dependencies.push({ predecessorId: 'b', successorId: 'c', type: 'FS', lagDays: 0 });
    const result = createPreview(plan, { expectedPlanVersion: 1, reason: '调整', mode: 'push_successors', changes: [{ taskId: 'a', start: '2026-09-24', end: '2026-09-25' }] }, 'test', new Date('2026-09-21T00:00:00Z'));
    expect(result.preview.canApply).toBe(true);
    expect(result.nodes.find(node => node.id === 'b')).toMatchObject({ start: '2026-09-25', end: '2026-09-25' });
    expect(result.nodes.find(node => node.id === 'c')).toMatchObject({ start: '2026-09-28', end: '2026-09-29' });
  });
  test('completed successor is never moved and makes conflicting preview non-applicable', () => {
    const nodes = [task('a', '2026-09-21', '2026-09-22'), task('b', '2026-09-23', '2026-09-24', { status: 'done', progress: 100 })];
    const result = createPreview(project(nodes), { expectedPlanVersion: 1, reason: '调整', mode: 'push_successors', changes: [{ taskId: 'a', start: '2026-09-24', end: '2026-09-25' }] }, 'test', new Date('2026-09-21T00:00:00Z'));
    expect(result.preview.canApply).toBe(false);
    expect(result.preview.issues.some(issue => issue.code === 'DONE_DEPENDENCY_CONFLICT')).toBe(true);
    expect(result.nodes.find(node => node.id === 'b')).toEqual(nodes[1]);
  });
  test('a successor shifted beyond the supported calendar range cannot be applied', () => {
    const nodes = [task('a', '2026-09-21', '2026-09-22'), task('b', '2026-09-23', '2026-09-24')];
    const result = createPreview(project(nodes), { expectedPlanVersion: 1, reason: '边界验证', mode: 'push_successors', changes: [{ taskId: 'a', start: '2099-12-31', end: '2099-12-31' }] }, 'test', new Date('2026-09-21T00:00:00Z'));
    expect(result.preview.canApply).toBe(false);
    expect(result.preview.issues.some(issue => issue.code === 'DATE_LIMIT' && issue.objectId === 'b')).toBe(true);
  });
  test('work is evenly spread across working days and overload is grouped by owner/week', () => {
    const nodes = [task('a', '2026-09-21', '2026-09-22', { effortHours: 32 }), task('b', '2026-09-23', '2026-09-24', { effortHours: 24 })];
    const overload = analyzePlan(project(nodes)).issues.filter(issue => issue.code === 'RESOURCE_OVERLOAD');
    expect(overload).toHaveLength(1); expect(overload[0]!.description).toContain('56.0 小时');
    const separateWeeks = project([nodes[0]!, task('b', '2026-09-28', '2026-09-29', { effortHours: 24 })]);
    expect(analyzePlan(separateWeeks).issues.some(issue => issue.code === 'RESOURCE_OVERLOAD')).toBe(false);
  });
});
