import type { PersonnelAnalysis, PersonnelMember, PersonnelMetricKey, PersonnelSummary } from '../../../../shared/src/analytics';

export const personnelMetricLabels = { completion: '任务完成率', overdue: '未完成任务逾期率', late: '已完成任务延期率', onTime: '按期完成率' };
export const personnelGroupLabels = { done: '已完成', todo: '待办', inProgress: '进行中', blocked: '受阻', review: '待复核', unplanned: '未排期', missingActual: '已完成缺实际完成日', missingReference: '已完成缺参照截止日' };
export const personnelStateLabels = { on_time: '按期完成', late: '延期完成', unknown_completed: '已完成 · 无法判定时效', overdue: '逾期未完成', not_overdue: '未逾期', unknown_unfinished: '未完成 · 缺截止日' };
export const referenceSourceLabels = { baseline: '选定基线', completion_plan: '完成时冻结计划', current_plan: '当前计划' };
export const availabilityLabels = { active: '当前成员', inactive: '已停用', removed: '已移除', historical: '历史负责人', unassigned: '待分配' };
export const personnelNotice = '按当前任务状态与负责人统计，仅作为工作分析与后续绩效参考；未区分任务难度、贡献价值和延期责任。任务移交后归入新负责人；计划窗口不代表历史月末回放。';
export type PersonnelSort = 'default' | 'total' | 'completion' | 'overdue' | 'late';
export interface PersonnelViewState { sortBy: PersonnelSort; direction: 'asc' | 'desc'; expanded: string[] }
export interface PersonnelSelection {
  /** undefined selects the project summary; null selects unassigned tasks. */
  memberId?: string | null;
  metric?: PersonnelMetricKey;
  part?: 'numerator' | 'denominator' | 'missing';
  group?: keyof PersonnelSummary['groups'];
}
export const formatPersonnelRate = (value: number | null) => value === null ? '暂无可计算数据' : `${Number((value * 100).toFixed(1))}%`;
export function sortedPersonnel(members: PersonnelMember[], state: PersonnelViewState) {
  if (state.sortBy === 'default') return members;
  const key = state.sortBy;
  return members.map((member, index) => ({ member, index })).sort((a, b) => {
    const left = key === 'total' ? a.member.counts.total : a.member.metrics[key].value;
    const right = key === 'total' ? b.member.counts.total : b.member.metrics[key].value;
    if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
    return (state.direction === 'asc' ? left - right : right - left) || a.index - b.index;
  }).map(item => item.member);
}
export function personnelSelectionIds(data: PersonnelAnalysis, selection: PersonnelSelection): string[] {
  const summary = selection.memberId === undefined ? data.summary : data.members.find(m => m.id === selection.memberId);
  if (!summary) return [];
  if (selection.metric) return summary.metrics[selection.metric][`${selection.part ?? 'numerator'}TaskIds`];
  return selection.group ? summary.groups[selection.group] : summary.taskIds;
}
