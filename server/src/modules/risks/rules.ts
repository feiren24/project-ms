import { createMilestoneForecaster, type Forecast } from '../planning/forecast.js';
import type { PlanningCalendar } from '../../../../shared/src/planning.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import type { AlertCandidate, RiskEvaluation, RiskLevel, RiskRuleInput, RiskRuleKey } from '../../../../shared/src/risks.js';
import { validDate, workdaysBetween } from '../planning/calendar.js';
import { shanghaiDate } from '../analytics/dates.js';

export function scoreRisk(probability: number | null, impact: number | null): { score: number | null; level: RiskLevel | null } {
  if (probability === null && impact === null) return { score: null, level: null };
  if (![probability, impact].every(value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5)) {
    throw new Error('概率与影响必须同时填写 1–5 的整数，或同时留空。');
  }
  const score = probability! * impact!;
  return { score, level: score <= 4 ? 'low' : score <= 9 ? 'medium' : score <= 16 ? 'high' : 'critical' };
}

const names: Record<RiskRuleKey, string> = {
  overdue: '任务逾期', dependency_blocked: '到期开工前置未完成', blocked_2_days: '人工阻塞超过 2 工作日',
  milestone_forecast_late: '里程碑剩余路径预测延迟', capacity_overload: '个人周负荷超过 100%', commitment_incomplete: '基线承诺完整性',
};
const executable = (task: ManagedTask) => task.taskKind !== 'summary' && !task.isContainer && task.status !== 'cancelled';
const active = (task: ManagedTask) => executable(task) && task.status !== 'done';
const positive = (value: number | null) => typeof value === 'number' && Number.isFinite(value) && value > 0;
function calendarKnown(calendar: PlanningCalendar): boolean {
  return calendar.confirmed && calendar.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
    && (calendar.weekdays.length > 0 || Object.values(calendar.exceptions).some(Boolean)) && positive(calendar.hoursPerDay);
}

/** Pure evaluation: no DB, clock reads, mutations or inferred personal capacity. */
export function evaluateRiskRules(input: RiskRuleInput): RiskEvaluation {
  const { tasks, plan, today } = input;
  if (!validDate(today)) throw new Error('风险观察日必须为有效 YYYY-MM-DD 日期。');
  const result: RiskEvaluation = { candidates: [], unknown: [], rules: [] };
  const known = new Map<RiskRuleKey, Set<string>>();
  const unknownIds = new Map<RiskRuleKey, Set<string|null>>(), candidateIds = new Map<RiskRuleKey, Set<string>>();
  const unknown = (rule: RiskRuleKey, objectId: string | null) => {
    const ids=unknownIds.get(rule) ?? new Set<string|null>(); unknownIds.set(rule,ids);
    if (!ids.has(objectId)) { ids.add(objectId); result.unknown.push({rule,objectId}); }
  };
  const checked = (rule: RiskRuleKey, id: string) => {
    if (!known.has(rule)) known.set(rule, new Set());
    known.get(rule)!.add(id);
  };
  const emit = (candidate: AlertCandidate) => {
    checked(candidate.rule, candidate.objectId);
    const ids=candidateIds.get(candidate.rule) ?? new Set<string>(); candidateIds.set(candidate.rule,ids);
    if (!ids.has(candidate.objectId)) { ids.add(candidate.objectId); result.candidates.push(candidate); }
  };
  const taskAlert = (rule: RiskRuleKey, task: ManagedTask, evidence: string, taskIds = [task.id]) => emit({ rule, objectId: task.id, title: `${task.title} · ${names[rule]}`, evidence, workstreamId: task.workstreamId, taskIds });
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const nodeMap = new Map(plan.nodes.map(node => [node.id, node]));
  const incomingById = new Map<string, typeof plan.dependencies>();
  for (const edge of plan.dependencies) { const edges=incomingById.get(edge.successorId) ?? []; edges.push(edge); incomingById.set(edge.successorId,edges); }
  const latestBaseline = plan.baselines.at(-1);
  const calendarReady = calendarKnown(plan.calendar);

  for (const task of tasks.filter(active)) {
    if (!validDate(task.end)) unknown('overdue', task.id);
    else {
      checked('overdue', task.id);
      if (task.end < today) taskAlert('overdue', task, `截至 ${today} 尚未完成，计划结束 ${task.end}。`);
    }
    const incoming = (incomingById.get(task.id) ?? []);
    if (!incoming.length) checked('dependency_blocked', task.id);
    else if (!validDate(task.start)) unknown('dependency_blocked', task.id);
    else if (task.start > today) checked('dependency_blocked', task.id);
    else {
      const unfinished: string[] = [];
      let missing = false;
      for (const edge of incoming) {
        const predecessor = taskMap.get(edge.predecessorId);
        const node = nodeMap.get(edge.predecessorId);
        if (predecessor) {
          if (!executable(predecessor)) missing = true;
          else if (predecessor.status !== 'done') unfinished.push(predecessor.id);
        } else if (node?.kind === 'milestone') {
          if (node.milestoneState !== 'accepted' || !node.acceptedAt) unfinished.push(node.id);
        } else missing = true;
      }
      if (missing) unknown('dependency_blocked', task.id);
      else checked('dependency_blocked', task.id);
      if (unfinished.length) taskAlert('dependency_blocked', task, `计划 ${task.start} 开工；前置尚未完成：${unfinished.map(id => taskMap.get(id)?.title ?? nodeMap.get(id)?.title ?? id).join('、')}。`, [task.id, ...new Set(unfinished.filter(id => { const predecessor = taskMap.get(id); return predecessor && executable(predecessor); }))]);
    }
    if (!task.blocked) { checked('blocked_2_days', task.id); continue; }
    // updatedAt and seed flags are not evidence of when a block began.
    const events = task.events.filter(event => event.action === 'block' || event.action === 'unblock');
    const invalidEvent = events.some(event => !Number.isFinite(Date.parse(event.createdAt)));
    const latest = [...events].reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const blockedOn = latest && !invalidEvent ? shanghaiDate(new Date(latest.createdAt)) : null;
    if (!calendarReady || latest?.action !== 'block' || !blockedOn || blockedOn > today) unknown('blocked_2_days', task.id);
    else {
      const days = workdaysBetween(blockedOn, today, plan.calendar);
      checked('blocked_2_days', task.id);
      if (days > 2) taskAlert('blocked_2_days', task, `最近人工阻塞始于 ${blockedOn}（Asia/Shanghai），截至 ${today} 已过 ${days} 个工作日。${task.blockReason ? `原因：${task.blockReason}` : ''}`);
    }
  }

  const forecast = createMilestoneForecaster(plan, tasks, today);
  for (const milestone of plan.nodes.filter(node => node.kind === 'milestone')) {
    const task = taskMap.get(milestone.id);
    if (milestone.milestoneState === 'cancelled' || (task ? !active(task) : milestone.milestoneState === 'accepted' && Boolean(milestone.acceptedAt))) continue;
    const baselineEntry = latestBaseline?.entries.find(entry => entry.taskId === milestone.id);
    const promise = baselineEntry ? baselineEntry.end : milestone.end;
    let estimate: Forecast | null = null;
    if (calendarReady && validDate(promise)) {
      try { estimate = forecast(milestone.id); } catch { estimate = null; }
    }
    if (!estimate || !validDate(promise)) { unknown('milestone_forecast_late', milestone.id); continue; }
    checked('milestone_forecast_late', milestone.id);
    if (estimate.end > promise) emit({ rule: 'milestone_forecast_late', objectId: milestone.id, title: `${milestone.title} · 预测晚于承诺`,
      evidence: `参考预测 ${estimate.end}，晚于${baselineEntry ? `「${latestBaseline!.name}」` : '当前计划'}承诺 ${promise}；按 ${today} 的剩余工期、进度和 FS 依赖计算，未做资源平衡。`,
      workstreamId: milestone.workstreamId, taskIds: estimate.taskIds });
  }

  if (!input.capacity?.length) unknown('capacity_overload', null);
  for (const cell of input.capacity ?? []) {
    const id = `${cell.ownerId}:${cell.week}`;
    // Aggregate hours cannot be apportioned safely when their source includes excluded or missing tasks.
    const invalidScope = cell.taskIds.some(taskId => { const task = taskMap.get(taskId); return !task || !executable(task); });
    if (invalidScope) { unknown('capacity_overload', id); continue; }
    if (!cell.ownerId.trim() || !Number.isFinite(cell.plannedHours) || cell.plannedHours < 0 || cell.availableHours === null
      || !Number.isFinite(cell.availableHours) || cell.availableHours < 0) { unknown('capacity_overload', id); continue; }
    checked('capacity_overload', id);
    if (cell.plannedHours > cell.availableHours) {
      const taskIds = [...new Set(cell.taskIds)].filter(taskId => { const task = taskMap.get(taskId); return task && executable(task); });
      emit({ rule: 'capacity_overload', objectId: id, title: `${cell.owner} · ${cell.week} 周负荷超额`,
        evidence: `${cell.week} 周已分配 ${cell.plannedHours} 小时，已确认个人容量 ${cell.availableHours} 小时${cell.availableHours > 0 ? `，负荷 ${(cell.plannedHours / cell.availableHours * 100).toFixed(1)}%` : '；零容量仍分配工作'}。`,
        workstreamId: taskIds.length ? taskMap.get(taskIds[0]!)!.workstreamId : '', taskIds });
    }
  }

  if (!latestBaseline) unknown('commitment_incomplete', null);
  for (const entry of latestBaseline?.entries ?? []) {
    const task = taskMap.get(entry.taskId); const node = nodeMap.get(entry.taskId);
    if ((task && !executable(task)) || node?.kind === 'group' || latestBaseline!.excludedIds.includes(entry.taskId)) continue;
    if (!task && !node) { unknown('commitment_incomplete', entry.taskId); continue; }
    const current = task ?? node!;
    const reasons: string[] = [];
    if (!(task ? task.ownerId.trim() && task.owner.trim() : node!.owner.trim()) || !entry.owner.trim()) reasons.push('缺负责人');
    if (!validDate(current.start) || !validDate(current.end) || current.end < current.start
      || !validDate(entry.start) || !validDate(entry.end) || entry.end < entry.start) reasons.push('缺有效日期');
    if (node?.kind !== 'milestone' && (!positive(current.effortHours) || !positive(entry.effortHours))) reasons.push('缺正工时估算');
    checked('commitment_incomplete', entry.taskId);
    if (reasons.length) emit({ rule: 'commitment_incomplete', objectId: entry.taskId, title: `${current.title} · 基线承诺不完整`,
      evidence: `已纳入「${latestBaseline!.name}」承诺：${reasons.join('、')}。请补全当前任务并核对基线承诺。`, workstreamId: current.workstreamId, taskIds: task ? [task.id] : [] });
  }
  checked('commitment_incomplete', `${plan.project.id}:calendar`);
  if (!calendarReady) emit({ rule: 'commitment_incomplete', objectId: `${plan.project.id}:calendar`, title: '项目工作日历待确认',
    evidence: '项目工作日历尚未确认或缺有效工作日/每日工时；请确认工作周与例外日期后核对承诺。', workstreamId: '', taskIds: [] });

  for (const key of Object.keys(names) as RiskRuleKey[]) {
    const missing = result.unknown.filter(item => item.rule === key);
    const count = known.get(key)?.size ?? 0;
    const triggered = result.candidates.filter(item => item.rule === key).length;
    result.rules.push({ key, name: names[key], status: missing.length ? count ? 'partial' : 'unknown' : 'evaluated', triggered,
      message: key === 'capacity_overload' && !input.capacity?.length ? '个人真实容量未配置，无法判断；未使用满勤试算。'
        : missing.length ? `已判断 ${count} 个对象；${missing.some(item => item.objectId === null) ? '部分范围' : `${missing.length} 个对象`}输入不足，无法判断，既有预警不会自动恢复。`
          : `已判断 ${count} 个对象，命中 ${triggered} 条。` });
  }
  return result;
}
