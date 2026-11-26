import type { AnalyticsDeviation, AnalyticsFilters } from '../../../../shared/src/analytics.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import type { ProjectPlan, PlanBaseline } from '../../../../shared/src/planning.js';
import { workdaysBetween } from '../planning/calendar.js';
import { executable } from './metrics.js';
import { overlaps } from './dates.js';
export function planDeviations(tasks: ManagedTask[], plan: ProjectPlan, filters: AnalyticsFilters, baseline?: PlanBaseline, owners: Array<{ id: string; name: string }> = [], deletedTasks:ManagedTask[]=[]): AnalyticsDeviation[] {
  if (!baseline) return [];
  const eligible = tasks.filter(executable); const knownNonTasks = new Set([...tasks.filter(t => !executable(t)).map(t => t.id), ...plan.nodes.filter(n => n.kind !== 'task').map(n => n.id)]);
  const ids = new Set([...eligible.map(t => t.id), ...baseline.entries.filter(e => !knownNonTasks.has(e.taskId)).map(e => e.taskId)]);
  const taskById = new Map(eligible.map(task => [task.id, task])), entryById = new Map(baseline.entries.map(entry => [entry.taskId, entry]));
  const deletedById=new Map(deletedTasks.map(t=>[t.id,t]));
  return [...ids].flatMap(id => {
    const task = taskById.get(id); const entry = entryById.get(id);
    const historical=deletedById.get(id);
    const owner = task?.owner ?? historical?.owner ?? entry?.owner ?? ''; const ownerId = task?.ownerId ?? historical?.ownerId ?? owners.find(member => member.name === owner)?.id ?? '';
    if ((filters.workstreamId && (task?.workstreamId??historical?.workstreamId) !== filters.workstreamId) || (filters.ownerId && ownerId !== filters.ownerId)) return [];
    if (!(task && overlaps(task.start, task.end, filters.from, filters.to)) && !(entry && overlaps(entry.start, entry.end, filters.from, filters.to))) return [];
    const target = task?.status === 'done' ? task.actualEnd : task?.end;
    let state: AnalyticsDeviation['state']; let deltaDays: number | null = null;
    if (!task) state = 'missing'; else if (task.status === 'cancelled') state = 'cancelled'; else if (!entry) state = 'new'; else if (!entry.end || !entry.start) state = 'unplanned'; else if (task.status === 'done' && !task.actualEnd) state = 'missing'; else if (task.status !== 'done' && (!task.start || !task.end)) state = 'unplanned'; else if (!target) state = 'missing'; else {
      deltaDays = workdaysBetween(entry.end, target, baseline.calendar); state = deltaDays > 0 ? 'delayed' : deltaDays < 0 ? 'early' : 'unchanged';
    }
    if(!task&&historical)state='deleted';
    return [{ taskId: id, canOpen: Boolean(task||historical), title: task?.title ?? historical?.title ?? `历史任务 ${id}`, owner, workstreamId: task?.workstreamId ?? historical?.workstreamId ?? '', baselineEnd: entry?.end ?? null, currentEnd: task?.end ?? null, actualEnd: task?.actualEnd ?? null, deltaDays, state }];
  });
}
