import type { AnalyticsReport } from '../../../../shared/src/analytics';
import { availabilityLabels, personnelMetricLabels, personnelGroupLabels, personnelStateLabels, referenceSourceLabels, personnelNotice } from './personnel';
export type AnalysisView = 'delivery' | 'deviation' | 'capacity' | 'personnel';
export const analysisViewLabels = { delivery: '交付进展', deviation: '计划偏差', capacity: '资源负荷', personnel: '人员任务分析' };
export const deviationLabels = { unchanged: '未变化', delayed: '延期', early: '提前', new: '新增', cancelled: '已取消', missing: '缺少匹配', unplanned: '未排期', deleted:'已删除（基线保留）' };
export const taskStatusLabels: Record<string, string> = { todo: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
const metricLabels = { completion: '任务完成率', weightedProgress: '工时加权进度', estimationCoverage: '估算覆盖率', onTime: '按期完成率', milestoneAchievement: '里程碑达成率' };
export function analyticsCsv(report: AnalyticsReport, view: AnalysisView, deviationState = ''): string {
  const f = report.filters;
  const rows: unknown[][] = [
    ['统计分析', analysisViewLabels[view], report.project.isDemo ? 'DEMO · 示例项目' : '当前项目数据'],
    ['项目', report.project.name], ['指标版本', report.metricVersion], ['执行计划版本', report.planVersion],
    ['生成时间', report.generatedAt], [report.project.isDemo ? '示例快照日' : '统计基准日', report.dataAsOf], ['首次真实采集时间', report.trend.firstCapturedAt],
    ['计划窗口', f.from, f.to],
    ['工作分组', report.options.workstreams.find(item => item.id === f.workstreamId)?.name || '全部工作分组'],
    ['负责人', report.options.owners.find(item => item.id === f.ownerId)?.name || '全部负责人'],
    ['基线', report.options.baselines.find(item => item.id === f.baselineId)?.name || '无基线'],
    ['容量计算方式', report.capacity.label],
    ['口径', '计划区间与窗口重叠；未排期执行任务单列；未知值留空；实际趋势仅本机每日采集，不回填'],
    ...report.warnings.map(warning => ['数据提示', warning]), [],
  ];
  if (view === 'delivery') {
    rows.push(['指标', '数值(%)', '分子', '分母', '缺失数量', '指标说明']);
    for (const [key, metric] of Object.entries(report.metrics)) rows.push([key === 'milestoneAchievement' && report.project.isDemo ? '里程碑示例达成率' : metricLabels[key as keyof typeof metricLabels], metric.value === null ? null : metric.value * 100, metric.numerator, metric.denominator, metric.missing, metric.description]);
    rows.push([], ['WBS', '执行任务', '负责人', '状态', '进度(%)', '开始日期', '结束日期', '估算工时', '实际完成日', '完成时计划结束日']);
    rows.push(...report.tasks.map(t => [t.wbs, t.title, t.owner, taskStatusLabels[t.status], t.progress, t.start, t.end, t.effortHours, t.actualEnd, t.completionPlanEnd]));
    rows.push([], ['里程碑', '负责人', '计划日期', report.project.isDemo ? '示例达成状态' : '里程碑状态', '凭证说明']);
    rows.push(...report.milestones.map(m => [m.title, m.owner, m.date, m.achieved ? (report.project.isDemo ? '示例已达成' : '已达成') : '未达成', '不是正式独立验收凭证']));
    rows.push([], ['日期', '基线计划进度(%)', '实际采集进度(%)', '实际采集时间']);
    rows.push(...report.trend.points.map(p => [p.date, p.planned === null ? null : p.planned * 100, p.actual === null ? null : p.actual * 100, p.capturedAt]));
  } else if (view === 'deviation') {
    rows.push(['偏差状态筛选', deviationState ? deviationLabels[deviationState as keyof typeof deviationLabels] : '全部状态']);
    rows.push(['任务', '负责人', '状态', '基线结束', '当前计划结束', '实际完成', '工作日偏差']);
    rows.push(...report.deviations.filter(d => !deviationState || d.state === deviationState).map(d => [d.title, d.owner, deviationLabels[d.state], d.baselineEnd, d.currentEnd, d.actualEnd, d.deltaDays]));
  } else if (view === 'personnel') {
    rows.push(['人员分析说明', personnelNotice], ['未完成时效', '当前截止日早于统计基准日才算逾期；当天到期不算'], ['已完成时效', '基线条目优先；无条目使用完成时冻结日，缺失日期保持未知'], []);
    rows.push(['负责人ID', '负责人', '成员状态', '任务总数', ...Object.values(personnelGroupLabels)]);
    for (const member of report.personnel.members) rows.push([member.id, member.name, availabilityLabels[member.availability], member.counts.total, ...Object.keys(personnelGroupLabels).map(key => member.counts[key as keyof typeof personnelGroupLabels])]);
    rows.push([], ['范围', '负责人ID', '负责人', '指标', '数值(%)', '分子', '分母', '缺失数量', '指标说明', '分子任务ID', '分母任务ID', '缺失任务ID']);
    const summaries = [{ scope: '项目汇总', id: '', name: report.project.name, ...report.personnel.summary }, ...report.personnel.members.map(m => ({ scope: '人员汇总', ...m }))];
    for (const summary of summaries) for (const [key, metric] of Object.entries(summary.metrics)) rows.push([summary.scope, summary.id, summary.name, personnelMetricLabels[key as keyof typeof personnelMetricLabels], metric.value === null ? null : Number((metric.value * 100).toFixed(1)), metric.numerator, metric.denominator, metric.missing, metric.description, metric.numeratorTaskIds.join(';'), metric.denominatorTaskIds.join(';'), metric.missingTaskIds.join(';')]);
    rows.push([], ['任务ID', 'WBS', '任务', '负责人ID', '当前负责人', '状态', '受阻', '待复核', '计划开始', '当前截止日', '实际完成日', '参照截止日', '参照来源', '时效判定']);
    const timings = new Map(report.personnel.tasks.map(t => [t.taskId, t]));
    for (const task of report.tasks) {
      const timing = timings.get(task.id)!;
      rows.push([task.id, task.wbs, task.title, task.ownerId, task.owner || '未指定负责人', taskStatusLabels[task.status], task.blocked ? '是' : '否', ['submitted','needs_review'].includes(task.reviewStatus) ? '是' : '否', task.start, task.end, task.actualEnd, timing.referenceEnd, referenceSourceLabels[timing.referenceSource], personnelStateLabels[timing.state]]);
    }
  } else {
    rows.push(['容量说明', f.capacityMode === 'configured' ? '按已配置个人容量计算，缺失项不估算；任务按单负责人100%分配' : f.capacityMode === 'calendar' ? '按日历满勤试算，不代表真实个人容量或请假；任务按单负责人100%分配' : '个人容量未知，不计算负荷比；任务按单负责人100%分配']);
    rows.push(['负责人', '周', '周开始日', '分配工时', '可用工时', '参考负荷比(倍数)', '状态', '任务', '任务分摊工时']);
    for (const member of report.capacity.members) for (const cell of member.cells) {
      const week = report.capacity.weeks.find(w => w.start === cell.week);
      const label = { unknown: '容量未知', empty: '无分配', normal: f.capacityMode === 'configured' ? '负荷正常' : '试算正常', overload: f.capacityMode === 'configured' ? '已配置容量超额' : '试算超载', conflict: '零容量冲突' }[cell.status];
      if (!cell.tasks.length) rows.push([member.name, week?.label || cell.week, cell.week, cell.plannedHours, cell.availableHours, cell.ratio, label, '', '']);
      else for (const task of cell.tasks) rows.push([member.name, week?.label || cell.week, cell.week, cell.plannedHours, cell.availableHours, cell.ratio, label, task.title, task.hours]);
    }
    rows.push([], ['未分配任务', '原因']);
    rows.push(...report.capacity.unallocated.map(t => [t.title, t.reason]));
  }
  const escape = (value: unknown) => { let text = String(value ?? ''); if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  return '\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n');
}
