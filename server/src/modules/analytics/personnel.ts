import type { AnalyticsTask, PersonnelAnalysis, PersonnelMember, PersonnelMetric, PersonnelSummary, PersonnelTaskTiming } from '../../../../shared/src/analytics.js';
import type { PlanBaseline } from '../../../../shared/src/planning.js';
import type { ProjectMember } from '../../../../shared/src/settings.js';
import { completionReference } from './metrics.js';

function ratio(numeratorTaskIds: string[], denominatorTaskIds: string[], missingTaskIds: string[], description: string): PersonnelMetric {
  return { value: denominatorTaskIds.length ? numeratorTaskIds.length / denominatorTaskIds.length : null,
    numerator: numeratorTaskIds.length, denominator: denominatorTaskIds.length, missing: missingTaskIds.length,
    taskIds: denominatorTaskIds, numeratorTaskIds, denominatorTaskIds, missingTaskIds, description };
}

function summarize(tasks: AnalyticsTask[], timings: ReadonlyMap<string, PersonnelTaskTiming>): PersonnelSummary {
  const ids = (filter: (task: AnalyticsTask) => boolean) => tasks.filter(filter).map(t => t.id);
  const all = tasks.map(t => t.id);
  const stateIds = (state: PersonnelTaskTiming['state']) => ids(t => timings.get(t.id)!.state === state);
  const groups = {
    done: ids(t => t.status === 'done'), todo: ids(t => t.status === 'todo'), inProgress: ids(t => t.status === 'in_progress'),
    blocked: ids(t => t.blocked), review: ids(t => ['submitted','needs_review'].includes(t.reviewStatus)),
    unplanned: ids(t => !t.start || !t.end), missingActual: ids(t => t.status === 'done' && !t.actualEnd),
    missingReference: ids(t => t.status === 'done' && !timings.get(t.id)!.referenceEnd),
  };
  const completedEligible = ids(t => t.status === 'done' && !!t.actualEnd && !!timings.get(t.id)!.referenceEnd);
  const unknownCompleted = stateIds('unknown_completed');
  return { taskIds: all, groups,
    counts: { total: all.length, ...Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.length])) } as PersonnelSummary['counts'],
    metrics: {
      completion: ratio(groups.done, all, [], '已完成执行任务数 / 纳入统计的执行任务总数；排除取消、汇总和里程碑。'),
      overdue: ratio(stateIds('overdue'), ids(t => t.status !== 'done' && !!t.end), stateIds('unknown_unfinished'), '当前截止日早于统计基准日且未完成数 / 有当前截止日的未完成任务数；当天到期不算逾期，不受基线切换影响。'),
      late: ratio(stateIds('late'), completedEligible, unknownCompleted, '实际完成日晚于参照截止日数 / 日期完整的已完成任务数；基线条目优先，无条目使用完成时冻结日。'),
      onTime: ratio(stateIds('on_time'), completedEligible, unknownCompleted, '实际完成日不晚于参照截止日数 / 日期完整的已完成任务数；与已完成任务延期率分母相同。'),
    },
  };
}

/** Input is the existing analytics scope: filtered, non-cancelled execution tasks only. */
export function personnelAnalysis(tasks: AnalyticsTask[], members: ProjectMember[], asOf: string, baseline?: PlanBaseline, ownerId = ''): PersonnelAnalysis {
  const entries = baseline ? new Map(baseline.entries.map(e => [e.taskId, e])) : undefined;
  const timings = new Map<string, PersonnelTaskTiming>(tasks.map(task => {
    const reference = task.status === 'done' ? completionReference(task, entries) : { referenceEnd: task.end, referenceSource: 'current_plan' as const };
    const state: PersonnelTaskTiming['state'] = task.status === 'done'
      ? !task.actualEnd || !reference.referenceEnd ? 'unknown_completed' : task.actualEnd > reference.referenceEnd ? 'late' : 'on_time'
      : !task.end ? 'unknown_unfinished' : task.end < asOf ? 'overdue' : 'not_overdue';
    return [task.id, { taskId: task.id, ...reference, state }];
  }));
  const grouped = new Map<string, AnalyticsTask[]>();
  for (const task of tasks) { const group = grouped.get(task.ownerId) ?? []; group.push(task); grouped.set(task.ownerId, group); }
  const rows: PersonnelMember[] = [];
  for (const member of members) {
    if (ownerId && member.id !== ownerId) continue;
    const group = grouped.get(member.id) ?? [];
    const availability = member.removedAt ? 'removed' : !member.active || member.accountActive === false ? 'inactive' : 'active';
    if (availability === 'active' || group.length) rows.push({ id: member.id, name: member.name, availability, ...summarize(group, timings) });
    grouped.delete(member.id);
  }
  for (const [id, group] of grouped) {
    if (!id || (ownerId && id !== ownerId)) continue;
    rows.push({ id, name: group[0]!.owner || '历史负责人', availability: 'historical', ...summarize(group, timings) });
  }
  const unassigned = grouped.get('');
  if (!ownerId && unassigned?.length) rows.push({ id: null, name: '未指定负责人', availability: 'unassigned', ...summarize(unassigned, timings) });
  return { summary: summarize(tasks, timings), members: rows, tasks: [...timings.values()] };
}
