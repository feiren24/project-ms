import type { ProjectPlan } from '../../../../shared/src/planning.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import { addWorkdays, normalizeWorkday, validDate } from './calendar.js';
import { shanghaiDate } from '../analytics/dates.js';
export interface Forecast { end: string; taskIds: string[] }
const executable = (task: ManagedTask) => task.taskKind !== 'summary' && !task.isContainer && task.status !== 'cancelled';
/** One dependency engine for milestone details and risk analysis; no resource balancing. */
export function createMilestoneForecaster(plan: Pick<ProjectPlan,'nodes'|'dependencies'|'calendar'>, tasks: ManagedTask[], today: string): (id: string) => Forecast | null {
  if (!validDate(today) || !plan.calendar.confirmed || (plan.calendar.weekdays.length === 0 && !Object.values(plan.calendar.exceptions).some(Boolean)) || !plan.calendar.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6) || !Number.isFinite(plan.calendar.hoursPerDay) || plan.calendar.hoursPerDay <= 0) return () => null;
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const nodeMap = new Map(plan.nodes.map(node => [node.id, node]));
  const incomingById = new Map<string, typeof plan.dependencies>();
  for (const edge of plan.dependencies) { const edges = incomingById.get(edge.successorId) ?? []; edges.push(edge); incomingById.set(edge.successorId, edges); }
  const memo = new Map<string, Forecast | null>();
  const visiting = new Set<string>();
  const forecast = (id: string): Forecast | null => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return null;
    const node = nodeMap.get(id); const task = taskMap.get(id);
    if (!node || ['cancelled','legacy_achieved'].includes(node.milestoneState ?? '') || !['task', 'milestone'].includes(node.kind) || (task && !executable(task))) return null;
    if (!task && node.status === 'done' && !node.milestoneState) return null;
    const done = task ? task.status === 'done' : node.milestoneState === 'accepted' && Boolean(node.acceptedAt);
    if (done) {
      // PlanNode.end is a promise, never actual completion evidence for a plan-only milestone.
      const end = task ? task.actualEnd : node.acceptedAt ? shanghaiDate(new Date(node.acceptedAt)) : null;
      const value = validDate(end) && end <= today ? { end, taskIds: task ? [id] : [] } : null;
      memo.set(id, value); return value;
    }
    // Dates and duration are separate inputs; never turn missing path data into zero.
    if (!validDate(node.start) || !validDate(node.end) || node.end < node.start || node.durationDays === null
      || !Number.isFinite(node.durationDays) || node.durationDays < 0 || (node.kind === 'task' && node.durationDays === 0)) return null;
    const progress = task?.progress ?? node.progress;
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) return null;
    visiting.add(id);
    try {
      let start = normalizeWorkday(node.start > today ? node.start : today, plan.calendar);
      const taskIds = new Set<string>(task ? [id] : []);
      for (const edge of (incomingById.get(id) ?? [])) {
        if (edge.type !== 'FS' || !Number.isInteger(edge.lagDays) || edge.lagDays < 0 || edge.lagDays > 260) return null;
        const previous = forecast(edge.predecessorId);
        if (!previous) return null;
        const after = addWorkdays(previous.end, edge.lagDays + (node.kind === 'milestone' ? 0 : 1), plan.calendar);
        if (after > start) start = after;
        previous.taskIds.forEach(taskId => taskIds.add(taskId));
      }
      // An unfinished task with 100% reported progress still requires completion; reserve one workday.
      const remaining = node.kind === 'milestone' ? 0 : Math.max(1, Math.ceil(node.durationDays * (1 - progress / 100)));
      const value = { end: addWorkdays(start, Math.max(0, remaining - 1), plan.calendar), taskIds: [...taskIds] };
      memo.set(id, value); return value;
    } finally { visiting.delete(id); }
  };
  return id => { try { return forecast(id); } catch { return null; } };
}
export function forecastMilestone(plan: ProjectPlan, tasks: ManagedTask[], id: string, today: string): Forecast | null {
  return createMilestoneForecaster(plan, tasks, today)(id);
}
