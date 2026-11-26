import type { ModuleCapabilities } from './permissions';
import type { TaskActor } from './tasks';
export interface ProjectNotification { id:string; recipientId:string; kind:string; title:string; message:string; createdAt:string; readAt:string|null; target:{kind:'task'|'milestone'|'risk'|'plan'|'settings'|'workstreams';id?:string} }
export interface BackgroundJob { id:string; kind:'notification'|'risk_evaluate'|'snapshot'|'backup'|'feishu_delivery'; status:'pending'|'running'|'succeeded'|'failed'|'missed'; attempts:number; dueAt:string; createdAt:string; finishedAt:string|null; error:string|null; summary:string }
export interface NotificationWorkspace { mode:'demo' | 'standard'; project:{isDemo:boolean;id:string;name:string}; actorId:string; actors:TaskActor[]; writeToken:string; unread:number; notifications:ProjectNotification[]; jobs:BackgroundJob[]; canManageJobs:boolean }
export interface ProjectRevision { capabilities:ModuleCapabilities; revision:string; unread:number; actorId:string; actors:TaskActor[] }
