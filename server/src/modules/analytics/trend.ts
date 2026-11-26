import type { AnalyticsFilters, AnalyticsReport } from '../../../../shared/src/analytics.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import type { PlanBaseline, ProjectPlan } from '../../../../shared/src/planning.js';
import type { DailySnapshot } from './snapshots.js';
import { dates, workDates, overlaps } from './dates.js';
import { executable, selected, taskMetrics, validEffort } from './metrics.js';
export function deliveryTrend(snapshots: DailySnapshot[], tasks: ManagedTask[], plan: ProjectPlan, filters: AnalyticsFilters, baseline?: PlanBaseline, owners: Array<{ id: string; name: string }> = []): AnalyticsReport['trend'] {
  const excluded = new Set([...tasks.filter(t => !executable(t)).map(t => t.id), ...plan.nodes.filter(n => n.kind !== 'task').map(n => n.id)]);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const entries = (baseline?.entries ?? []).filter(entry => {
    const task = taskById.get(entry.taskId);
    return !excluded.has(entry.taskId) && (!filters.workstreamId || task?.workstreamId === filters.workstreamId) && (!filters.ownerId || ((task?.ownerId ?? owners.find(a => a.name === entry.owner)?.id) === filters.ownerId)) && overlaps(entry.start, entry.end, filters.from, filters.to);
  });
  const allocated = entries.flatMap(entry => { if (!validEffort(entry.effortHours) || !entry.start || !entry.end || !baseline) return []; const days = workDates(entry.start, entry.end, baseline.calendar); return days.length ? [{ hours: entry.effortHours, days }] : []; });
  const totalHours = allocated.reduce((sum, e) => sum + e.hours, 0);
  const snapshotByDate = new Map(snapshots.map(snapshot => [snapshot.date,snapshot]));
  const plannedDaily = new Map<string,number>();
  let cumulativeHours = 0;
  for (const entry of allocated) for (const day of entry.days) {
    const hours = entry.hours / entry.days.length;
    if (day < filters.from) cumulativeHours += hours;
    else if (day <= filters.to) plannedDaily.set(day,(plannedDaily.get(day) ?? 0) + hours);
  }
  const points = dates(filters.from, filters.to).map(date => {
    cumulativeHours += plannedDaily.get(date) ?? 0;
    const snapshot = snapshotByDate.get(date);
    const snapshotTasks = snapshot?.tasks.filter(t => t.status !== 'cancelled' && selected(t, filters));
    return { date, planned: totalHours > 0 ? Math.min(1,cumulativeHours / totalHours) : null,
      actual: snapshotTasks ? taskMetrics(snapshotTasks).weightedProgress.value : null, capturedAt: snapshot?.capturedAt ?? null };
  });
  return { points, firstCapturedAt: snapshots[0]?.capturedAt ?? null,
    message: `实际趋势按本机 Asia/Shanghai 采集日记录已估算工时加权进度，未采集日保留断点；任务归属、负责人、工时和进度使用当日快照。计划线仅按选定基线工时均摊参考，${entries.length - allocated.length} 项缺日期、估算或可分摊工作日，未计入计划线。` };
}
