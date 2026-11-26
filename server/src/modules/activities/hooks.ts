import type Database from 'better-sqlite3';
import type { ActivityActor, ActivityChange } from '../../../../shared/src/activities.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import type { ManagedRisk } from '../../../../shared/src/risks.js';
import { recordActivity } from './repository.js';
function canonical(value:unknown):unknown { if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)]));return value??null; }
function scalar(value:unknown):ActivityChange['before'] {return value==null?null:typeof value==='string'||typeof value==='number'||typeof value==='boolean'?value:JSON.stringify(canonical(value));}
/** Only fields explicitly selected by the mutation site can enter the feed. */
export function activityChanges(before:object|undefined,after:object,fields:string[]):ActivityChange[] {return fields.flatMap(field=>{const a=scalar((before as Record<string,unknown>|undefined)?.[field]),b=scalar((after as Record<string,unknown>)[field]);return a===b?[]:[{field,before:a,after:b}];});}
export function captureTaskActivity(db:Database.Database,projectId:string,actor:ActivityActor,before:ManagedTask[],changed:ManagedTask[],operation:string,invalidatedMilestones:string[]=[]) {
 const primary=changed[0];if(!primary)return;
 for(const task of operation==='batch'?changed:[primary]){
  const prior=before.find(item=>item.id===task.id),event=task.events.at(-1);if(!prior||!event||task.taskKind==='summary'||task.isContainer)continue;
  let type=event.action;let changes:ActivityChange[]=[];let summary='';
  if(['complete','submit','accept','reject'].includes(type)) {
   if(type==='complete'&&(task.requiresReview||prior.status===task.status))continue;
   if(type!=='complete'&&!task.requiresReview)continue;
   if(type==='submit'&&prior.reviewStatus===task.reviewStatus)continue;
   changes=activityChanges(prior,task,['status','reviewStatus']);summary=({complete:'完成任务',submit:'提交关键成果验收',accept:'验收通过',reject:'验收退回'} as Record<string,string>)[type]!;
  }else if(['block','unblock'].includes(type)){changes=activityChanges(prior,task,['blocked']);summary=type==='block'?'任务遇到阻塞':'解除任务阻塞';}
  else if(['cancel','reopen'].includes(type)){changes=activityChanges(prior,task,['status']);summary=type==='cancel'?'取消任务':'重开任务';if(type==='reopen'){
   const invalidated=changed.filter(item=>item.id!==task.id&&item.events.at(-1)?.action==='needs_review').map(item=>item.title).concat(invalidatedMilestones);
   if(invalidated.length)changes.push({field:'invalidatedTargets',before:null,after:invalidated.join('、')});
  }}else if(['update','batch'].includes(type)&&(prior.requiresReview||task.requiresReview)){changes=activityChanges(prior,task,['ownerId','owner']);type='owner';summary='变更关键成果负责人';}else continue;
  if(!changes.length)continue;
  recordActivity(db,{projectId,sourceKey:`task-event:${event.id}`,type:`task.${type}`,category:'task',actor,occurredAt:event.createdAt,target:{kind:'task',id:task.id,name:task.title},summary:`${summary}「${task.title}」`,changes,groupable:type==='complete',forceNewGroup:type==='complete'&&prior.events.some(event=>['complete','accept','reopen'].includes(event.action))});
 }
}
export function captureRiskActivity(db:Database.Database,projectId:string,actor:ActivityActor,before:ManagedRisk|undefined,after:ManagedRisk,operation:string) {
 const event=after.events.at(-1);if(!event)return;const important=(risk:ManagedRisk|undefined)=>Boolean(risk&&(risk.occurred||['high','critical'].includes(risk.level??'')));
 let summary='';const action=event.action;
 if(operation==='create'&&important(after))summary='登记重要风险';
 else if(operation==='update'&&before?.level!==after.level&&(['high','critical'].includes(before?.level??'')||['high','critical'].includes(after.level??'')))summary='调整重要风险等级';
 else if(action==='occur'&&!before?.occurred&&after.occurred)summary='风险已发生';
 else if(['approve_close','reopen'].includes(action)&&(important(before)||important(after))&&before?.status!==after.status)summary=action==='approve_close'?'关闭重要风险':'重开重要风险';
 if(summary)recordActivity(db,{projectId,sourceKey:`risk-event:${event.id}`,type:`risk.${action}`,category:'risk',actor,occurredAt:event.createdAt,target:{kind:'risk',id:after.id,name:after.title},summary:`${summary}「${after.title}」`,changes:activityChanges(before,after,['level','status','occurred'])});
}
