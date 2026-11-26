import type { TaskActor } from './tasks';
export type FeishuTemplate = 'task_event'|'milestone_event'|'risk_event'|'plan_event'|'due_reminder'|'overdue_reminder'|'review_reminder'|'blocked_reminder'|'daily_report'|'weekly_report';
export interface FeishuTemplateInfo { id:FeishuTemplate; name:string; category:'event'|'reminder'|'report'; actions:Array<{id:string;name:string}> }
export const feishuTemplates:FeishuTemplateInfo[] = [
 {id:'task_event',name:'任务事件',category:'event',actions:[{id:'assign',name:'分派／转交'},{id:'complete',name:'完成'},{id:'submit',name:'提交验收'},{id:'accept',name:'验收通过'},{id:'reject',name:'验收退回'},{id:'block',name:'阻塞'},{id:'unblock',name:'解除阻塞'}]},
 {id:'milestone_event',name:'里程碑事件',category:'event',actions:[{id:'submit',name:'提交验收'},{id:'accept',name:'验收通过'},{id:'reject',name:'验收退回'},{id:'needs_review',name:'需复核'}]},
 {id:'risk_event',name:'风险事件',category:'event',actions:[{id:'trigger',name:'预警触发'},{id:'resolve',name:'预警恢复'},{id:'escalate',name:'风险升级'},{id:'occur',name:'风险发生'},{id:'approve_close',name:'风险关闭'},{id:'reopen',name:'风险重开'}]},
 {id:'plan_event',name:'计划事件',category:'event',actions:[{id:'schedule',name:'日期／依赖调整'},{id:'baseline',name:'基线发布'}]},
 {id:'due_reminder',name:'即将到期提醒',category:'reminder',actions:[]},
 {id:'overdue_reminder',name:'逾期提醒',category:'reminder',actions:[]},
 {id:'review_reminder',name:'待验收提醒',category:'reminder',actions:[]},
 {id:'blocked_reminder',name:'持续阻塞提醒',category:'reminder',actions:[]},
 {id:'daily_report',name:'项目日报',category:'report',actions:[]},
 {id:'weekly_report',name:'项目周报',category:'report',actions:[]},
];
export interface FeishuBot { id:string;version:number;name:string;groupName:string;maskedWebhook:string;signatureEnabled:boolean;hasSecret:boolean;keyword:string;enabled:boolean;testedAt:string|null;confirmedAt:string|null;lastError:string|null;createdAt:string;updatedAt:string }
export interface FeishuBotDraft { name:string;groupName:string;webhook?:string;signatureEnabled:boolean;secret?:string;keyword:string }
export interface FeishuRuleDraft { name:string;template:FeishuTemplate;actions:string[];objectType:'task'|'milestone';workstreamIds:string[];ownerIds:string[];riskLevels:string[];alertTypes:string[];days:number;schedule:{mode:'workdays'|'weekdays';weekdays:number[];time:string};deliveryMode:'merged'|'immediate';bypassQuiet:boolean;mentionAll:boolean;botIds:string[];skipEmpty:boolean }
export interface NotificationRule extends FeishuRuleDraft { id:string;version:number;status:'draft'|'enabled'|'paused'|'archived';enabledAt:string|null;createdAt:string;updatedAt:string;nextRunAt:string|null }
export interface NotificationPreferences { version:number;quietEnabled:boolean;quietStart:string;quietEnd:string;timezone:'Asia/Shanghai' }
export interface FeishuMessage { title:string;projectName:string;lines:string[];total:number;url:string|null;linkLabel:string;mentionAll:boolean;generatedAt:string;periodStart?:string;periodEnd?:string;isDemo:boolean }
export type FeishuDeliveryStatus = 'pending'|'sending'|'accepted'|'failed'|'unknown'|'cancelled'|'skipped'|'missed';
export interface FeishuAttempt { at:string;outcome:string;message:string }
export interface FeishuDelivery { id:string;version:number;botId:string;botName:string;groupName:string;ruleIds:string[];ruleName:string;kind:'event'|'scheduled'|'test';status:FeishuDeliveryStatus;message:FeishuMessage;dueAt:string;createdAt:string;finishedAt:string|null;attempts:FeishuAttempt[];error:string|null;audit:Array<{at:string;actor:string;action:string}> }
export interface FeishuDeliveryFilter { status?:string;botId?:string;ruleId?:string;days?:number;page?:number;pageSize?:number }
export interface FeishuWorkspace { project:{id:string;name:string;isDemo:boolean};version:number;writeToken:string;available:boolean;unavailableReason:string|null;publicBaseUrl:string|null;bots:FeishuBot[];rules:NotificationRule[];preferences:NotificationPreferences;templates:FeishuTemplateInfo[];actors:TaskActor[];workstreams:Array<{id:string;name:string}>;calendarConfirmed:boolean;audit:Array<{id:string;at:string;actor:string;action:string}> }
export function defaultFeishuRule(template:FeishuTemplate='overdue_reminder'):FeishuRuleDraft {
 const info=feishuTemplates.find(t=>t.id===template)!;
 return {name:info.name,template,actions:info.actions.map(a=>a.id),objectType:'task',workstreamIds:[],ownerIds:[],riskLevels:[],alertTypes:[],days:template==='due_reminder'?3:template==='blocked_reminder'?2:1,schedule:{mode:template==='weekly_report'?'weekdays':'workdays',weekdays:template==='weekly_report'?[5]:[1,2,3,4,5],time:info.category==='report'?'18:00':'09:00'},deliveryMode:'merged',bypassQuiet:false,mentionAll:false,botIds:[],skipEmpty:info.category!=='report'};
}
