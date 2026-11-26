import { isProjectManager } from './permissions.js';

export type ReasonPolicy = 'hidden' | 'optional' | 'required';
export interface ReasonContext {
  domain: 'task' | 'risk' | 'settings' | 'membership' | 'workstream' | 'project' | 'schedule' | 'baseline';
  action: string;
  selfReview?: boolean;
  previousRole?: string;
  role?: string;
  previousActive?: boolean;
  active?: boolean;
  legacy?: boolean;
}
/** Shared classification. Servers derive this context from persisted state, never from client policy flags. */
export function operationReasonPolicy(context: ReasonContext): ReasonPolicy {
  const { domain, action } = context;
  if (domain === 'baseline') return 'required';
  if (domain === 'task') {
    if (['cancel','reopen','batch','delete','restore'].includes(action) || (context.selfReview && ['accept','reject'].includes(action))) return 'required';
    return ['block','unblock','reject'].includes(action) ? 'optional' : 'hidden';
  }
  if (domain === 'risk') {
    if (['accept','submit_close','approve_close','snooze'].includes(action) || (action === 'reject_close' && context.selfReview)) return 'required';
    return action === 'reject_close' ? 'optional' : 'hidden';
  }
  if (domain === 'membership' || (domain === 'settings' && action.startsWith('member_'))) {
    if (action === 'remove' || context.legacy) return 'required';
    if (action === 'member_update') return (context.previousRole !== context.role || (context.previousActive === true && context.active === false)) ? 'required' : 'hidden';
    return isProjectManager(context.role) ? 'required' : 'hidden';
  }
  return 'hidden';
}
export function taskOperationSummary(action: string, previousProgress?: number, progress?: number): string {
  if (action === 'progress') return `进度由 ${previousProgress}% 更新为 ${progress}%`;
  return ({start:'开始任务',complete:'标记任务完成',block:'标记任务阻塞',unblock:'解除任务阻塞',submit:'提交任务验收',accept:'验收通过',reject:'验收退回',cancel:'取消任务',reopen:'重开任务'} as Record<string,string>)[action] ?? '更新任务';
}
export function riskOperationSummary(action: string): string {
  return ({assess:'完成风险评估',mitigate:'启动风险应对',monitor:'进入风险监控',occur:'标记风险已发生',reopen:'重开风险',reject_close:'退回风险关闭申请',update:'更新风险资料',link:'关联应对任务',remove:'移除应对任务关联'} as Record<string,string>)[action] ?? '更新风险';
}
