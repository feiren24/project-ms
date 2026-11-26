import type { AnalyticsFilters, AnalyticsMetric, AnalyticsReport, AnalyticsTask } from '../../../../shared/src/analytics.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import type { PlanBaseline } from '../../../../shared/src/planning.js';
import { overlaps } from './dates.js';
export const executable = (task: ManagedTask) => task.taskKind !== 'summary' && !task.isContainer;
export const selected = (task: Pick<AnalyticsTask, 'workstreamId'|'ownerId'|'start'|'end'>, filters: AnalyticsFilters) => (!filters.workstreamId || task.workstreamId === filters.workstreamId) && (!filters.ownerId || task.ownerId === filters.ownerId) && overlaps(task.start, task.end, filters.from, filters.to);
export const validEffort = (hours: number | null): hours is number => typeof hours === 'number' && Number.isFinite(hours) && hours > 0;
/** A matching baseline without an end date remains unknown; never substitute today's plan. */
export function completionReference(task: AnalyticsTask, entries?: ReadonlyMap<string, PlanBaseline['entries'][number]>) {
  const entry = entries?.get(task.id);
  return { referenceEnd: entry ? entry.end : task.completionPlanEnd, referenceSource: entry ? 'baseline' as const : 'completion_plan' as const };
}
export function metric(numerator: number, denominator: number, missing: number, taskIds: string[], description: string): AnalyticsMetric { return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator, missing, taskIds, description }; }
export function taskMetrics(tasks: AnalyticsTask[], baseline?: PlanBaseline): Pick<AnalyticsReport['metrics'], 'completion'|'weightedProgress'|'estimationCoverage'|'onTime'> {
  const done = tasks.filter(t => t.status === 'done'); const estimated = tasks.filter(t => validEffort(t.effortHours));
  const entries = baseline ? new Map(baseline.entries.map(e => [e.taskId, e])) : undefined;
  const eligible = done.flatMap(task => { const { referenceEnd: end } = completionReference(task, entries); return task.actualEnd && end ? [{ task, end }] : []; });
  return {
    completion: metric(done.length, tasks.length, 0, tasks.map(t => t.id), '完成执行任务数 / 当前执行任务数；排除取消、汇总节点和里程碑。'),
    weightedProgress: metric(estimated.reduce((sum, t) => sum + t.effortHours! * t.progress / 100, 0), estimated.reduce((sum, t) => sum + t.effortHours!, 0), tasks.length - estimated.length, estimated.map(t => t.id), '已估算任务的进度折算工时 / 已估算总工时；未估算不作零。'),
    estimationCoverage: metric(estimated.length, tasks.length, tasks.length - estimated.length, tasks.map(t => t.id), '有工时估算的执行任务数 / 当前执行任务数；仅有限正工时算已估算，零或无效值不计入。'),
    onTime: metric(eligible.filter(e => e.task.actualEnd! <= e.end).length, eligible.length, done.length - eligible.length, eligible.map(e => e.task.id), '已完成且真实完成日不晚于参照结束日 / 有真实完成日及参照日的已完成任务；选定基线优先，基线外使用完成时冻结计划结束日。'),
  };
}

export function analyticsTask(task: ManagedTask): AnalyticsTask {
  const {id,wbs,title,workstreamId,ownerId,owner,status,progress,start,end,effortHours,blocked,requiresReview,reviewStatus,actualEnd,parentId} = task;
  return {id,wbs,title,workstreamId,ownerId,owner,status,progress,start,end,effortHours,blocked,requiresReview,reviewStatus,actualEnd,parentId,completionPlanEnd:task.completionPlanEnd ?? null};
}
