import { readOperationReason } from '../../operation-reasons.js';
import type { PlanDependency, PlanEditRequest, PlanIssue, PlanNode, PlanPreview, ProjectPlan } from '../../../../shared/src/planning.js';
import { addWorkdays, calendarDay, duration, isWorkday, validDate, workdaysBetween, workweek } from './calendar.js';
import { requireValue } from './errors.js';

function edgeIndex(dependencies: PlanDependency[], field: 'predecessorId' | 'successorId') {
  const result = new Map<string, PlanDependency[]>();
  for (const edge of dependencies) { const list = result.get(edge[field]) ?? []; list.push(edge); result.set(edge[field], list); }
  return result;
}
export const isLeaf = (node: PlanNode) => node.kind === 'task' || node.kind === 'milestone';
export function validateDependencies(nodes: PlanNode[], dependencies: PlanDependency[]): string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  requireValue(dependencies.length <= 20000, 'DEPENDENCY_LIMIT', '依赖数量超过系统支持上限。');
  const seen = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const degrees = new Map(nodes.filter(isLeaf).map(node => [node.id, 0]));
  for (const edge of dependencies) {
    const from = byId.get(edge.predecessorId); const to = byId.get(edge.successorId);
    requireValue(from && to && isLeaf(from) && isLeaf(to), 'INVALID_DEPENDENCY_TARGET', '依赖只能连接当前项目的执行任务或里程碑。');
    requireValue(from.id !== to.id, 'SELF_DEPENDENCY', '任务不能依赖自己。');
    requireValue(edge.type === 'FS' && Number.isInteger(edge.lagDays) && edge.lagDays >= 0 && edge.lagDays <= 260, 'INVALID_DEPENDENCY', '仅支持 FS 依赖，间隔必须为 0–260 的整数工作日。');
    const key = `${from.id}:${to.id}`;
    requireValue(!seen.has(key), 'DUPLICATE_DEPENDENCY', '同一对任务不能重复建立依赖。');
    seen.add(key);
    outgoing.set(from.id, [...(outgoing.get(from.id) ?? []), to.id]);
    degrees.set(to.id, degrees.get(to.id)! + 1);
  }
  const queue = [...degrees].filter(([, count]) => !count).map(([id]) => id);
  const ordered: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!; ordered.push(id);
    for (const successor of outgoing.get(id) ?? []) {
      degrees.set(successor, degrees.get(successor)! - 1);
      if (!degrees.get(successor)) queue.push(successor);
    }
  }
  requireValue(ordered.length === degrees.size, 'DEPENDENCY_CYCLE', '这些依赖会形成循环，请移除其中一条。');
  return ordered;
}

function issue(code: string, node: PlanNode, description: string, severity: 'warning' | 'error' = 'warning'): PlanIssue {
  return { id: `${code}:${node.id}`, code, objectId: node.id, title: node.title, description, severity };
}
export function analyzePlan(plan: Pick<ProjectPlan, 'nodes' | 'dependencies' | 'calendar' | 'baselines' | 'project'>) {
  const issues: PlanIssue[] = [];
  const nodes = plan.nodes.filter(isLeaf);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ordered = validateDependencies(plan.nodes, plan.dependencies);
  const incoming = edgeIndex(plan.dependencies, 'successorId'), outgoing = edgeIndex(plan.dependencies, 'predecessorId');
  const weekly = new Map<string, { hours: number; owner: string; week: string; node: PlanNode }>();
  for (const node of plan.nodes) {
    if (node.kind === 'group' || node.milestoneState === 'cancelled') continue;
    if (!node.start || !node.end) { issues.push(issue('UNSCHEDULED', node, '范围尚未排期，无法纳入关键路径与资源测算；需要先细化范围。')); continue; }
    if (validDate(node.start) && validDate(node.end) && (!isWorkday(node.start, plan.calendar) || !isWorkday(node.end, plan.calendar) || (node.kind === 'task' && !duration(node.start, node.end, plan.calendar)))) {
      issues.push(issue('CALENDAR_DATE_CONFLICT', node, '当前日历下任务起止含休息日或区间无工作日；原日期已保留，请核对日历或重新预览排期。'));
    }
    if (!node.owner) issues.push(issue('MISSING_OWNER', node, '尚未指定负责人。'));
    if (node.end > plan.project.end) issues.push(issue('PROJECT_DEADLINE', node, `结束日期 ${node.end} 晚于项目目标 ${plan.project.end}。`));
    if (node.kind !== 'task') continue;
    if (!node.effortHours || node.effortHours <= 0) { issues.push(issue('MISSING_EFFORT', node, '缺少正工时估算，未计入资源负荷。')); continue; }
    const days = duration(node.start, node.end, plan.calendar);
    if (!days) continue;
    for (let date = node.start; date <= node.end; date = calendarDay(date, 1)) {
      if (!isWorkday(date, plan.calendar)) continue;
      const week = workweek(date); const key = `${node.owner}:${week}`;
      const load = weekly.get(key) ?? { hours: 0, owner: node.owner, week, node };
      load.hours += node.effortHours / days; weekly.set(key, load);
    }
  }
  for (const [key, load] of weekly) if (load.hours > 40 + 0.001) {
    issues.push({ ...issue('RESOURCE_OVERLOAD', load.node, `${load.owner} 在 ${load.week} 起的一周分配约 ${load.hours.toFixed(1)} 小时，超过固定 40 小时试算参考；不代表已配置个人容量，未进行自动资源平衡。`), id: `RESOURCE_OVERLOAD:${key}`, title: `${load.owner} · 周负荷试算超额` });
  }
  const baseline = plan.baselines[plan.baselines.length - 1];
  for (const entry of baseline?.entries ?? []) {
    const node = byId.get(entry.taskId);
    if (node?.kind === 'milestone' && node.milestoneState !== 'cancelled' && entry.end && node.end && node.end > entry.end) {
      issues.push(issue('BASELINE_MILESTONE_LATE', node, `当前 ${node.end} 晚于「${baseline!.name}」承诺 ${entry.end}。`));
    }
  }
  if (!plan.calendar.confirmed) issues.push({ id: 'CALENDAR_UNCONFIRMED', code: 'CALENDAR_UNCONFIRMED', objectId: plan.project.id, title: '项目日历待确认', description: '默认周一至周五、每天 8 小时，未导入官方调休；发布基线前需要明确确认。', severity: 'warning' });
  // Forward/backward passes retain current planned starts as explicit lower bounds.
  const earliest = new Map<string, { start: string; end: string }>();
  for (const id of ordered) {
    const node = byId.get(id)!;
    if (node.milestoneState === 'cancelled' || !node.start || !node.end || node.durationDays === null) continue;
    if ((incoming.get(id) ?? []).some(edge => !earliest.has(edge.predecessorId))) continue;
    let start = node.start;
    for (const edge of incoming.get(id) ?? []) {
      const previous = earliest.get(edge.predecessorId);
      if (previous) start = [start, addWorkdays(previous.end, edge.lagDays + (node.kind === 'milestone' ? 0 : 1), plan.calendar)].sort().at(-1)!;
    }
    earliest.set(id, { start, end: addWorkdays(start, Math.max(0, node.durationDays - 1), plan.calendar) });
  }
  const latest = new Map<string, string>(); const criticalIds: string[] = [];
  for (const id of [...ordered].reverse()) {
    const node = byId.get(id)!; const early = earliest.get(id);
    if (!early || node.durationDays === null) continue;
    let end = plan.project.end;
    for (const edge of outgoing.get(id) ?? []) {
      const nextStart = latest.get(edge.successorId); const next = byId.get(edge.successorId)!;
      if (nextStart) end = [end, addWorkdays(nextStart, -(edge.lagDays + (next.kind === 'milestone' ? 0 : 1)), plan.calendar)].sort()[0]!;
    }
    const start = addWorkdays(end, -Math.max(0, node.durationDays - 1), plan.calendar);
    latest.set(id, start);
    if (workdaysBetween(early.start, start, plan.calendar) <= 0) criticalIds.push(id);
  }
  const missing = plan.nodes.filter(node => node.kind !== 'group' && node.milestoneState !== 'cancelled' && (!node.start || !node.end || node.durationDays === null || (isLeaf(node) && !earliest.has(node.id)))).length;
  return { issues, criticalIds, criticalCoverage: { complete: missing === 0, message: missing ? `关键路径仅覆盖 ${earliest.size} 个已排期执行任务/里程碑；${missing} 个范围缺口未纳入。按当前日期约束与项目目标结束日测算，未做资源平衡。` : '已覆盖全部执行任务与里程碑；按当前日期约束与项目目标结束日测算，未做资源平衡。' } };
}

/** All downstream nodes, even when dates are absent or no date would move. */
export function affectedDependencyIds(dependencies: PlanDependency[], targetIds: string[]): string[] {
  const outgoing = edgeIndex(dependencies, 'predecessorId');
  const affected = new Set(targetIds), queue = [...affected];
  for (let i = 0; i < queue.length; i++) for (const edge of outgoing.get(queue[i]!) ?? []) {
    if (!affected.has(edge.successorId)) { affected.add(edge.successorId); queue.push(edge.successorId); }
  }
  return [...affected];
}

export function createPreview(plan: ProjectPlan, request: PlanEditRequest, id: string, now: Date): { preview: PlanPreview; nodes: PlanNode[] } {
  requireValue(request && typeof request === 'object', 'INVALID_REQUEST', '请填写计划调整内容。');
  const calculation = request.calculation ?? 'schedule';
  requireValue(calculation === 'schedule' || calculation === 'relationships_only', 'INVALID_CALCULATION', '请选择日期排期或仅调整关系。');
  const relationshipsOnly = calculation === 'relationships_only';
  const reason = readOperationReason(request.reason, { domain: 'schedule', action: 'preview' }, 500);
  requireValue(request.mode === 'push_successors' || request.mode === 'earliest_start', 'INVALID_MODE', '请选择顺延后续或按最早日期重排。');
  requireValue(Array.isArray(request.changes) && request.changes.length <= 100, 'INVALID_CHANGES', '单次最多调整 100 个任务。');
  requireValue(!relationshipsOnly || (request.changes.length === 0 && typeof request.dependencyTargetId === 'string' && Array.isArray(request.incomingDependencies)), 'INVALID_RELATIONSHIP_EDIT', '仅调整关系时必须指定一个依赖目标和前置依赖，日期调整必须为空。');
  const nodes = structuredClone(plan.nodes); const byId = new Map(nodes.map(node => [node.id, node]));
  const direct = new Set<string>(); const errors: PlanIssue[] = [];
  for (const change of request.changes) {
    requireValue(change && typeof change === 'object', 'INVALID_CHANGES', '日期调整内容无效。');
    const node = byId.get(change.taskId);
    requireValue(node && isLeaf(node), 'INVALID_TASK', '仅能调整当前项目执行任务或里程碑，范围缺口需要先细化。');
    requireValue(!direct.has(node.id), 'DUPLICATE_CHANGE', '同一任务不能重复调整。');
    requireValue(node.milestoneState !== 'cancelled', 'MILESTONE_CANCELLED', '里程碑已取消，请先恢复再调整排期。');
    requireValue(node.milestoneState !== 'submitted', 'REVIEW_PENDING', '里程碑已提交验收，请先撤回或退回再调整排期。');
    requireValue(node.status !== 'done', 'DONE_IMMUTABLE', '已完成记录的日期不能修改。');
    requireValue(validDate(change.start) && validDate(change.end) && change.end >= change.start && change.start >= plan.project.start, 'INVALID_DATE', '日期必须有效，结束不能早于开始，开始不能早于项目开始。');
    requireValue(workdaysBetween(change.start, change.end, plan.calendar) <= 2600, 'DATE_LIMIT', '单项任务不能超过 2600 个工作日。');
    requireValue(node.kind !== 'milestone' || change.start === change.end, 'MILESTONE_DURATION', '里程碑必须在同一天达成。');
    if (!isWorkday(change.start, plan.calendar) || !isWorkday(change.end, plan.calendar)) errors.push(issue('NON_WORKING_DATE', node, '所选日期包含非工作日，请修改为工作日后重新预览；系统未自动改写输入。', 'error'));
    node.start = change.start; node.end = change.end;
    node.durationDays = node.kind === 'milestone' ? 0 : duration(change.start, change.end, plan.calendar);
    direct.add(node.id);
  }
  let dependencies = structuredClone(plan.dependencies);
  const hasDependencyEdit = request.dependencyTargetId !== undefined || request.incomingDependencies !== undefined;
  if (hasDependencyEdit) {
    const target = byId.get(request.dependencyTargetId ?? '');
    requireValue(target && isLeaf(target), 'INVALID_DEPENDENCY_TARGET', '请选择当前项目中的依赖目标。');
    requireValue(target.milestoneState !== 'cancelled', 'MILESTONE_CANCELLED', '里程碑已取消，请先恢复再调整依赖。');
    requireValue(target.milestoneState !== 'submitted', 'REVIEW_PENDING', '里程碑已提交验收，请先撤回或退回再调整依赖。');
    requireValue(target.status !== 'done', 'DONE_IMMUTABLE', '已完成记录的依赖不能修改。');
    requireValue(Array.isArray(request.incomingDependencies) && request.incomingDependencies.length <= 100, 'INVALID_DEPENDENCIES', '单项最多设置 100 条前置依赖。');
    requireValue(request.incomingDependencies.every(edge => edge && typeof edge === 'object'), 'INVALID_DEPENDENCIES', '前置依赖内容无效。');
    for (const edge of request.incomingDependencies) {
      requireValue(!('type' in edge) || edge.type === 'FS', 'INVALID_DEPENDENCY', '仅支持 FS 依赖。');
      const predecessor = byId.get(edge.predecessorId);
      const existing = plan.dependencies.some(original => original.predecessorId === edge.predecessorId && original.successorId === target.id);
      requireValue(predecessor?.milestoneState !== 'cancelled' || existing, 'CANCELLED_PREDECESSOR', '已取消里程碑不能作为新的前置依赖。');
    }
    dependencies = [...dependencies.filter(edge => edge.successorId !== target.id), ...request.incomingDependencies.map(edge => ({ predecessorId: edge.predecessorId, successorId: target.id, type: 'FS' as const, lagDays: edge.lagDays }))];
  }
  const ordered = validateDependencies(nodes, dependencies);
  const incomingById = edgeIndex(dependencies, 'successorId');
  if (relationshipsOnly) {
    const affected = new Set(affectedDependencyIds(dependencies, [request.dependencyTargetId!]));
    const issues: PlanIssue[] = [];
    for (const id of affected) {
      const node = byId.get(id)!;
      if (node.milestoneState === 'cancelled') issues.push(issue('MILESTONE_CANCELLED', node, '受影响里程碑已取消，请先恢复或处理依赖。', 'error'));
      if (!node.start || !node.end || node.durationDays === null) issues.push(issue('UNSCHEDULED_DEPENDENT', node, '受影响任务尚未完整排期；本次仅保存关系，日期保持不变。'));
      for (const edge of incomingById.get(id) ?? []) {
        const previous = byId.get(edge.predecessorId)!;
        if (previous.milestoneState === 'cancelled') { issues.push(issue('CANCELLED_PREDECESSOR', node, '前置里程碑已取消，请先处理依赖。', 'error')); continue; }
        if (!validDate(previous.end)) { issues.push(issue('UNSCHEDULED_PREDECESSOR', node, '前置任务尚未排期；本次未计算或修改日期。')); continue; }
        const minimum = addWorkdays(previous.end, edge.lagDays + (node.kind === 'milestone' ? 0 : 1), plan.calendar);
        if (validDate(node.start) && node.start < minimum) issues.push(node.status === 'done'
          ? issue('DONE_DEPENDENCY_CONFLICT', node, '依赖与已完成记录的日期冲突，不能应用。', 'error')
          : issue('DEPENDENCY_DATE_CONFLICT', node, `当前开始日早于依赖允许的 ${minimum}；本次保留日期，请后续调整排期。`));
      }
    }
    const sortedEdges = (edges: PlanDependency[]) => JSON.stringify([...edges].sort((a,b) => `${a.predecessorId}:${a.successorId}`.localeCompare(`${b.predecessorId}:${b.successorId}`)));
    const dependencyChanged = sortedEdges(dependencies) !== sortedEdges(plan.dependencies);
    return { nodes, preview: {
      id, calculation, basePlanVersion: plan.planVersion, expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), reason: reason || '仅调整任务依赖关系',
      changes: [], issues: [...issues, ...analyzePlan({ ...plan, dependencies }).issues], dependencies, dependencyChanged,
      canApply: dependencyChanged && !issues.some(item => item.severity === 'error'),
      affectedMilestoneIds: nodes.filter(node => node.kind === 'milestone' && affected.has(node.id)).map(node => node.id),
    } };
  }
  // Scheduling requires complete dates across the proposed connected component,
  // including upstream and sibling branches which a downstream pass never visits.
  const connected = new Set(affectedDependencyIds([
    ...dependencies, ...dependencies.map(edge => ({ ...edge, predecessorId: edge.successorId, successorId: edge.predecessorId })),
  ], [...direct, ...(request.dependencyTargetId ? [request.dependencyTargetId] : [])]));
  for (const node of nodes.filter(node => connected.has(node.id) && isLeaf(node))) {
    if (!validDate(node.start) || !validDate(node.end) || node.durationDays === null || (node.kind === 'task' && node.durationDays <= 0)) {
      errors.push(issue('UNSCHEDULED_CHAIN', node, '关联依赖链中仍有任务缺少有效日期或工期；请补齐排期，或仅保存依赖关系。', 'error'));
    }
  }
  const previousById = new Map(plan.nodes.map(node => [node.id, node]));
  const touched = new Set([...direct, ...(request.dependencyTargetId ? [request.dependencyTargetId] : [])]);
  for (const id of ordered) {
    const node = byId.get(id)!;
    const incoming = incomingById.get(id) ?? [];
    const affected = touched.has(id) || incoming.some(edge => touched.has(edge.predecessorId));
    if (!affected) continue;
    touched.add(id);
    if (node.milestoneState === 'cancelled') { errors.push(issue('MILESTONE_CANCELLED', node, '受影响里程碑已取消，请先恢复或处理依赖。', 'error')); continue; }
    if (!node.start || !node.end || node.durationDays === null) { errors.push(issue('UNSCHEDULED_DEPENDENT', node, '受影响任务缺日期或工期，无法自动计算。', 'error')); continue; }
    let minimum = plan.project.start;
    for (const edge of incoming) {
      const previous = byId.get(edge.predecessorId)!;
      if (previous.milestoneState === 'cancelled') { errors.push(issue('CANCELLED_PREDECESSOR', node, '前置里程碑已取消，不能作为完成依据，请先处理依赖。', 'error')); continue; }
      if (!previous.end) { errors.push(issue('UNSCHEDULED_PREDECESSOR', node, '前置任务尚未排期，无法自动计算。', 'error')); continue; }
      minimum = [minimum, addWorkdays(previous.end, edge.lagDays + (node.kind === 'milestone' ? 0 : 1), plan.calendar)].sort().at(-1)!;
    }
    if (node.status === 'done') {
      if (node.start < minimum) errors.push(issue('DONE_DEPENDENCY_CONFLICT', node, '顺延会与已完成的实际日期冲突，不能应用，请调整依赖或前置日期。', 'error'));
      continue;
    }
    if (direct.has(id)) {
      if (node.start < minimum) errors.push(issue('EXPLICIT_DATE_CONFLICT', node, `指定开始日早于依赖允许的 ${minimum}，请修改日期或依赖。`, 'error'));
      continue;
    }
    if (node.start < minimum || request.mode === 'earliest_start') {
      node.start = minimum;
      node.end = addWorkdays(minimum, Math.max(0, node.durationDays - 1), plan.calendar);
    }
  }
  for (const node of nodes.filter(node => touched.has(node.id) && isLeaf(node))) {
    if (node.status !== 'done' && validDate(node.start) && validDate(node.end)
      && (!isWorkday(node.start, plan.calendar) || !isWorkday(node.end, plan.calendar) || (node.kind === 'task' && !duration(node.start, node.end, plan.calendar)))) {
      errors.push(issue('CALENDAR_DATE_CONFLICT', node, '受影响任务在当前日历下存在非工作日端点或无工作日区间，请修复后重新预览。', 'error'));
    }
    if (node.start && node.end && (!validDate(node.start) || !validDate(node.end))) {
      errors.push(issue('DATE_LIMIT', node, '连锁调整后的日期超出系统支持的 2000–2099 年，请缩短调整范围。', 'error'));
    }
  }
  const changes = nodes.filter(node => isLeaf(node) && node.start && node.end).flatMap(node => {
    const previous = previousById.get(node.id)!;
    return previous.start === node.start && previous.end === node.end ? [] : [{ taskId: node.id, title: node.title, kind: node.kind as 'task' | 'milestone', previousStart: previous.start, previousEnd: previous.end, start: node.start!, end: node.end!, shiftDays: previous.start ? workdaysBetween(previous.start, node.start!, plan.calendar) : 0, direct: direct.has(node.id) }];
  });
  const sortedEdges = (edges: PlanDependency[]) => JSON.stringify([...edges].sort((a, b) => `${a.predecessorId}:${a.successorId}`.localeCompare(`${b.predecessorId}:${b.successorId}`)));
  const dependencyChanged = sortedEdges(dependencies) !== sortedEdges(plan.dependencies);
  const analysis = analyzePlan({ ...plan, nodes, dependencies });
  return { nodes, preview: {
    id, calculation, basePlanVersion: plan.planVersion, expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), reason: reason || '调整任务日期与依赖',
    changes, issues: [...errors, ...analysis.issues], dependencies, dependencyChanged,
    canApply: !errors.length && (changes.length > 0 || dependencyChanged), affectedMilestoneIds: changes.filter(change => change.kind === 'milestone').map(change => change.taskId),
  } };
}
