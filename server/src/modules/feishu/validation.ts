import type Database from 'better-sqlite3';
import { feishuTemplates, type FeishuBotDraft, type FeishuRuleDraft } from '../../../../shared/src/feishu.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { readActors } from '../settings/store.js';
import { readProjectSnapshot } from '../projects/context.js';
import { validFeishuWebhook } from './store.js';
export function object(value:unknown,keys?:string[]):asserts value is Record<string,unknown>{requireValue(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_REQUEST','请提供有效配置。');if(keys)requireValue(Object.keys(value).every(k=>keys.includes(k)),'UNKNOWN_FIELD','配置包含不支持的字段，请刷新并保留草稿。');}
function text(value:unknown,max:number,label:string,empty=false):string{requireValue(typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0),'INVALID_FIELD',`${label}${empty?'':'必填，'}最多${max}字。`);return value.trim();}
function bool(value:unknown,label:string):boolean{requireValue(typeof value==='boolean','INVALID_FIELD',`请明确${label}。`);return value;}
function strings(value:unknown,label:string,max=100):string[]{requireValue(Array.isArray(value)&&value.length<=max&&value.every(x=>typeof x==='string'&&x.length>0&&x.length<=200)&&new Set(value).size===value.length,'INVALID_FIELD',`${label}格式不正确。`);return value as string[];}
export function validTime(value:unknown):value is string{return typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);}
export function botDraft(value:unknown,isNew:boolean):FeishuBotDraft {
 object(value,['name','groupName','webhook','signatureEnabled','secret','keyword']);
 const draft:FeishuBotDraft={name:text(value.name,80,'机器人名称'),groupName:text(value.groupName,100,'目标群备注'),signatureEnabled:bool(value.signatureEnabled,'签名校验'),keyword:text(value.keyword,40,'消息关键词',true)};
 if(isNew||value.webhook!==undefined){requireValue(validFeishuWebhook(value.webhook),'INVALID_WEBHOOK','请填写飞书官方 HTTPS 群机器人 Webhook 地址。');draft.webhook=value.webhook;}
 if(value.secret!==undefined)draft.secret=text(value.secret,256,'签名密钥',true);
 if(isNew&&draft.signatureEnabled)requireValue(draft.secret,'SIGNATURE_REQUIRED','开启签名校验时需要签名密钥。');
 return draft;
}
export function ruleDraft(db:Database.Database,pid:string,value:unknown):FeishuRuleDraft {
 object(value,['name','template','actions','objectType','workstreamIds','ownerIds','riskLevels','alertTypes','days','schedule','deliveryMode','bypassQuiet','mentionAll','botIds','skipEmpty']);
 const template=feishuTemplates.find(t=>t.id===value.template);requireValue(template,'INVALID_TEMPLATE','请选择有效通知模板。');
 const actions=strings(value.actions,'事件种类',20);requireValue(actions.every(a=>template.actions.some(t=>t.id===a))&&(template.category!=='event'||actions.length>0),'INVALID_ACTION','请选择该模板支持的事件种类。');
 const workstreamIds=strings(value.workstreamIds,'工作分组'),ownerIds=strings(value.ownerIds,'负责人');
 const snapshot=readProjectSnapshot(db,pid);if(!snapshot)throw new PlanError(404,'PROJECT_NOT_FOUND','未找到项目。');
 requireValue(workstreamIds.every(id=>snapshot.workstreams.some(w=>w.id===id)),'INVALID_WORKSTREAM','所选工作分组不属于当前项目。');
 requireValue(ownerIds.every(id=>readActors(db,pid).some(a=>a.id===id&&a.assignable!==false)),'INVALID_OWNER','所选负责人不属于当前有效项目成员。');
 const riskLevels=strings(value.riskLevels,'风险等级',4),alertTypes=strings(value.alertTypes,'预警类型',6);
 requireValue(riskLevels.every(l=>['low','medium','high','critical'].includes(l)),'INVALID_LEVEL','请选择有效风险等级。');
 requireValue(alertTypes.every(t=>['overdue','dependency_blocked','blocked_2_days','milestone_forecast_late','capacity_overload','commitment_incomplete'].includes(t)),'INVALID_ALERT','请选择有效预警类型。');
 requireValue(Number.isInteger(value.days)&&(value.days as number)>=0&&(value.days as number)<=365,'INVALID_DAYS','天数须为0至365的整数。');
 requireValue(value.objectType==='task'||value.objectType==='milestone','INVALID_OBJECT','请选择任务或里程碑。');
 requireValue(value.template!=='blocked_reminder'||value.objectType==='task','INVALID_OBJECT','持续阻塞提醒仅适用于任务。');
 object(value.schedule,['mode','weekdays','time']);requireValue(value.schedule.mode==='workdays'||value.schedule.mode==='weekdays','INVALID_SCHEDULE','请选择发送日期安排。');
 const weekdays=value.schedule.weekdays;requireValue(Array.isArray(weekdays)&&weekdays.length>0&&weekdays.length<=7&&new Set(weekdays).size===weekdays.length&&weekdays.every(d=>Number.isInteger(d)&&d>=0&&d<=6),'INVALID_WEEKDAYS','至少选择一个发送星期且不可重复。');
 requireValue(validTime(value.schedule.time),'INVALID_TIME','发送时间须为有效的时:分。');requireValue(value.deliveryMode==='merged'||value.deliveryMode==='immediate','INVALID_MODE','请选择合并或即时发送。');
 const botIds=strings(value.botIds,'目标机器人',20);
 return {name:text(value.name,100,'规则名称'),template:template.id,actions,objectType:value.objectType,workstreamIds,ownerIds,riskLevels,alertTypes,days:value.days as number,schedule:{mode:value.schedule.mode,weekdays:weekdays as number[],time:value.schedule.time},deliveryMode:value.deliveryMode,bypassQuiet:bool(value.bypassQuiet,'免打扰例外'),mentionAll:bool(value.mentionAll,'@所有人'),botIds,skipEmpty:bool(value.skipEmpty,'无事项时是否不发送')};
}
