import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Milestone, MilestoneDraft, MilestoneWorkspace, MilestoneWriteResult } from '../../../../shared/src/milestones.js';
import { canReviewTask, isProjectManager } from '../../../../shared/src/permissions.js';
import type { TaskActor } from '../../../../shared/src/tasks.js';
import type { PlanNode } from '../../../../shared/src/planning.js';
import { captureBusinessJobs } from '../../job-integration.js';
import { readActors, readPeople } from '../settings/store.js';
import { readTasks } from '../tasks/repository.js';
import { invalidateTasksForMilestone } from '../tasks/milestone-invalidation.js';
import { readPlan } from '../planning/repository.js';
import { syncPlanOrder } from '../planning/order.js';
import { validDate, isWorkday } from '../planning/calendar.js';
import { createMilestoneForecaster } from '../planning/forecast.js';
import { shanghaiDate } from '../analytics/dates.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { appendMilestoneEvent, emptyDelivery, milestonePlanStatus, milestonePrerequisiteIssues, reconcileMilestones, readMilestoneRecords, readMilestoneTaskFacts, saveMilestoneRecord, type MilestoneRecord } from './store.js';
import { strict, textValue, validateDelivery, validateDraft, validateResponsibilities } from './schema.js';
import { assertMilestoneAcceptanceGraph } from './dependencies.js';

const draftKeys=['title','description','workstreamId','ownerId','reviewerId','date','criteria'];
type Operation='create'|'update'|'draft'|'transition';

export function readMilestones(db: Database.Database, projectId: string, token: string, now: Date): MilestoneWorkspace {
 const workspace=readTasks(db,projectId,token,now),plan=readPlan(db,projectId,token,now),records=readMilestoneRecords(db,projectId),facts=readMilestoneTaskFacts(db,projectId);
 const people=readPeople(db,projectId,records.flatMap(m=>[m.ownerId,m.reviewerId,...m.submissions.map(s=>s.submitterId)]));
 const forecast=createMilestoneForecaster(plan,workspace.tasks,shanghaiDate(now));
 const name=(id:string)=>people.find(p=>p.id===id)?.name || workspace.actors.find(a=>a.id===id)?.name || (id?'历史成员':'待指定');
 const milestones=records.map(record=>{
  const readiness=record.criteria.map(c=>{
   if(c.kind==='task'){const fact=facts.get(c.taskId!);return {criterionId:c.id,ready:fact?.ready??false,reason:fact?.reason??'关联任务已失效，请重新选择'};}
   const evidence=record.delivery.evidence.find(e=>e.criterionId===c.id),ready=Boolean(evidence?.declared && evidence.description.trim() && evidence.links.length);
   return {criterionId:c.id,ready,reason:ready?'证据已准备，仍需验收人核查':'请补充证据说明和链接，并确认已核查'};
  });
  const missing:string[]=[];
  if(!record.criteria.length)missing.push('请定义必要交付条件');
  for(const item of readiness.filter(c=>!c.ready))missing.push(`${record.criteria.find(c=>c.id===item.criterionId)!.title}：${item.reason}`);
  for(const id of milestonePrerequisiteIssues(record.id,plan.dependencies,records,facts))missing.push(`前置「${plan.nodes.find(n=>n.id===id)?.title??id}」尚未形成有效交付`);
  if(!record.date)missing.push('请先完成排期');
  else if(!validDate(record.date)||!isWorkday(record.date,plan.calendar))missing.push('计划日期不在当前工作日历内，请调整排期');
  try{validateResponsibilities(record.ownerId,record.reviewerId,workspace.actors);}catch{missing.push('请指定有效的负责人和验收人');}
  if(!record.description.trim())missing.push('请补充交付目标');
  if(!record.delivery.summary.trim())missing.push('请补充本次成果摘要');
  if(!record.delivery.links.length && !record.delivery.evidence.some(e=>e.links.length))missing.push('请提供至少一项成果证据链接');
  const estimate=forecast(record.id);
  return {...record,owner:name(record.ownerId),reviewer:name(record.reviewerId),readiness,missing,canSubmit:['draft','rejected','needs_review','legacy_achieved'].includes(record.state)&&missing.length===0,
   forecast:{date:estimate?.end??null,explanation:estimate?`按 ${shanghaiDate(now)} 的剩余工期、进度和 FS 依赖测算，未做资源平衡；证据核查耗时未估算。`:'工作日历未确认、路径数据不足或历史验收凭证缺失，暂时无法预测；未做资源平衡。',taskIds:estimate?.taskIds??[]}} as Milestone;
 });
 return {project:workspace.project,planVersion:plan.planVersion,writeToken:token,actors:workspace.actors,milestones,workstreams:workspace.workstreams,tasks:workspace.tasks,dependencies:plan.dependencies,baselines:plan.baselines,calendar:plan.calendar};
}

function assertAllowed(operation:Operation,action:unknown,actor:TaskActor,record?:MilestoneRecord) {
 const manager=isProjectManager(actor.role);
 if(['create','update'].includes(operation) || (operation==='transition'&&['cancel','restore','reopen'].includes(String(action)))) {
  if(!manager)throw new PlanError(403,'MILESTONE_MANAGER_REQUIRED','仅项目负责人或管理员可以维护里程碑及其交付门槛。');return;
 }
 if(operation==='transition'&&['accept','reject'].includes(String(action))) {
  const s=record?.submissions.at(-1);
  if(!record||!canReviewTask(actor.role,actor.id,record.ownerId,s?.submitterId??record.ownerId,record.reviewerId))throw new PlanError(403,'MILESTONE_REVIEW_FORBIDDEN','仅指定验收人或管理人员可以验收；普通成员不能验收自己负责或提交的成果。');
 }else if(!manager && record?.ownerId!==actor.id)throw new PlanError(403,'MILESTONE_OWNER_REQUIRED','仅里程碑负责人或管理人员可以维护和提交成果。');
}
function requireVersion(expected:unknown,actual:number,label:string) {
 requireValue(Number.isSafeInteger(expected)&&Number(expected)>0,'VERSION_REQUIRED',`请提供有效的${label}版本。`);
 if(expected!==actual)throw new PlanError(409,'MILESTONE_VERSION_CONFLICT',`${label}已更新。填写内容会保留，请读取最新数据并重新核对。`);
}
function invalidate(record:MilestoneRecord,now:Date) {const last=record.submissions.at(-1);if(last&&!last.invalidatedAt)last.invalidatedAt=now.toISOString();record.acceptedAt=null;}
function reviewedIds(value:unknown,allowed:string[],label:string):string[] {
 requireValue(Array.isArray(value)&&value.every(id=>typeof id==='string'&&allowed.includes(id))&&new Set(value).size===value.length,'INVALID_REVIEW',`请核对${label}对应的当前条件。`);return value as string[];
}

export function writeMilestone(db:Database.Database,projectId:string,operation:Operation,id:string|undefined,body:unknown,actorId:unknown,key:unknown,now:Date,actorName?:string):MilestoneWriteResult {
 return db.transaction(()=>{
  const storedActor=readActors(db,projectId).find(a=>a.id===actorId);
  if(!storedActor||storedActor.role==='viewer')throw new PlanError(403,'MILESTONE_FORBIDDEN','当前身份没有里程碑操作权限。');
  const actor=actorName?{...storedActor,name:actorName}:storedActor;
  let record=id?readMilestoneRecords(db,projectId).find(m=>m.id===id):undefined;
  const previousState=record?.state;
  if(id&&!record)throw new PlanError(404,'MILESTONE_NOT_FOUND','里程碑不存在或不属于当前项目。');
  assertAllowed(operation,(body as {action?:unknown})?.action,actor,record);
  const allowed=operation==='create'?[...draftKeys,'expectedPlanVersion']:operation==='update'?[...draftKeys,'expectedPlanVersion','expectedVersion','reason']:operation==='draft'?['summary','links','evidence','expectedPlanVersion','expectedVersion']:['expectedVersion','expectedPlanVersion','action','reason','submissionId','checkedCriterionIds','failedCriterionIds'];
  strict(body,allowed);
  requireValue(typeof key==='string'&&/^[\w:.-]{8,128}$/.test(key),'IDEMPOTENCY_KEY_REQUIRED','请提供有效的唯一操作标识。');
  const hash=createHash('sha256').update(JSON.stringify({operation,id,body})).digest('hex');
  const receipt=db.prepare('SELECT request_hash,response_json FROM milestone_receipts WHERE project_id=? AND actor_id=? AND request_key=?').get(projectId,actor.id,key) as {request_hash:string;response_json:string}|undefined;
  if(receipt){if(receipt.request_hash!==hash)throw new PlanError(409,'IDEMPOTENCY_CONFLICT','操作标识已用于不同内容，请重新核对后保存。');return JSON.parse(receipt.response_json);}
  const workspace=readMilestones(db,projectId,'',now),plan=readPlan(db,projectId,'',now);
  requireVersion(body.expectedPlanVersion,plan.planVersion,'计划');if(record)requireVersion(body.expectedVersion,record.version,'里程碑');
  const row=db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string};
  const nodes=JSON.parse(row.nodes_json) as PlanNode[];
  const reason=body.reason===undefined?'':textValue(body.reason,'操作依据',3000);
  let eventText='',eventAction:string=operation;
  if(operation==='create'||operation==='update') {
   if(record)requireValue(record.state!=='submitted','MILESTONE_LOCKED','请先撤回待验收成果，再修改交付定义。');
   const draft=validateDraft(body,workspace.actors,workspace.tasks,workspace.workstreams,record?.workstreamId);
   if(operation==='create' && draft.date!==null)requireValue(validDate(draft.date)&&draft.date>=plan.project.start&&draft.date<=plan.project.end&&isWorkday(draft.date,plan.calendar),'INVALID_DATE','请选择项目周期内的工作日；非工作日请明确修改后再保存。');
   if(record)requireValue(draft.date===record.date,'SCHEDULE_PREVIEW_REQUIRED','已有里程碑日期请通过计划调整预览修改。');
   const parent=nodes.find(n=>n.kind==='group'&&!n.parentId&&n.workstreamId===draft.workstreamId);requireValue(parent,'INVALID_WORKSTREAM','工作分组计划节点不存在，请刷新后重试。');
   if(!record) {
    const prefix=`${parent!.wbs}.M`;
    const used=nodes.filter(n=>n.wbs.startsWith(prefix)&&/^\d+$/.test(n.wbs.slice(prefix.length))).map(n=>Number(n.wbs.slice(prefix.length)));
    const id=randomUUID(),wbs=`${prefix}${Math.max(0,...used)+1}`;
    record={...draft,id,wbs,version:0,state:'draft',delivery:emptyDelivery(),acceptedAt:null,legacyStatus:null,createdAt:now.toISOString(),updatedAt:now.toISOString(),submissions:[],events:[]};
    nodes.push({id,wbs,parentId:parent!.id,workstreamId:draft.workstreamId,kind:'milestone',title:draft.title,description:draft.description,owner:workspace.actors.find(a=>a.id===draft.ownerId)!.name,color:parent!.color,status:'todo',start:draft.date,end:draft.date,durationDays:0,effortHours:null,progress:0,blocked:false});
    eventText='创建里程碑，明确目标、责任和必要交付条件。';
   }else {
    const changedScope=record.title!==draft.title||record.description!==draft.description||JSON.stringify(record.criteria)!==JSON.stringify(draft.criteria);
    if(record.state==='accepted'&&changedScope){requireValue(Boolean(reason),'REASON_REQUIRED','改变已验收交付范围前请填写依据并确认复核。');invalidate(record,now);record.state='needs_review';}
    const oldCriteria=record.criteria;
    record={...record,...draft,delivery:{...record.delivery,evidence:record.delivery.evidence.filter(e=>draft.criteria.some(c=>c.id===e.criterionId&&c.kind==='evidence')).map(e=>({...e,declared:e.declared&&JSON.stringify(oldCriteria.find(c=>c.id===e.criterionId))===JSON.stringify(draft.criteria.find(c=>c.id===e.criterionId))}))}};
    if(record.state==='legacy_achieved')record.state='draft';
    const node=nodes.find(n=>n.id===record!.id)!;Object.assign(node,{title:draft.title,description:draft.description,workstreamId:draft.workstreamId,parentId:parent!.id,color:parent!.color,owner:workspace.actors.find(a=>a.id===draft.ownerId)!.name});
    eventText=`更新里程碑定义及责任。${reason}`;
   }
  }else if(operation==='draft') {
   requireValue(record&&!['submitted','accepted','cancelled'].includes(record.state),'MILESTONE_LOCKED','当前成果已提交、已验收或已取消，请先撤回或重开。');
   record!.delivery=validateDelivery(body,record!.criteria);eventText='保存成果草稿。';
  }else {
   const current=workspace.milestones.find(m=>m.id===id)!,action=String(body.action);eventAction=action;
   requireValue(['submit','withdraw','accept','reject','cancel','restore','reopen'].includes(action),'INVALID_ACTION','里程碑必须按提交与验收流程操作，不能直接完成。');
   if(action==='submit') {
    requireValue(current.canSubmit,'MILESTONE_NOT_READY',current.missing.length?current.missing.join('；'):'当前状态不能提交验收。');
    const taskFacts=readMilestoneTaskFacts(db,projectId);
    const snapshot:MilestoneDraft={title:record!.title,description:record!.description,ownerId:record!.ownerId,reviewerId:record!.reviewerId,workstreamId:record!.workstreamId,date:record!.date,criteria:structuredClone(record!.criteria)};
    const requiredTaskIds=new Set([...record!.criteria.filter(c=>c.kind==='task').map(c=>c.taskId!),...plan.dependencies.filter(edge=>edge.successorId===record!.id&&taskFacts.has(edge.predecessorId)).map(edge=>edge.predecessorId)]);
    record!.submissions.push({id:randomUUID(),submitterId:actor.id,createdAt:now.toISOString(),snapshot:{...snapshot,...structuredClone(record!.delivery)},taskVersions:Object.fromEntries([...requiredTaskIds].map(id=>[id,taskFacts.get(id)!.fingerprint])),invalidatedAt:null,reviews:[]});
    record!.state='submitted';eventText=`提交第${record!.submissions.length}次验收，接收人：${current.reviewer}。`;
   }else if(action==='withdraw') {
    requireValue(record!.state==='submitted','INVALID_TRANSITION','仅待验收成果可以撤回。');invalidate(record!,now);record!.state='draft';eventText='撤回本次提交，保留快照和成果草稿。';
   }else if(action==='accept'||action==='reject') {
    const s=record!.submissions.at(-1);
    if(record!.state!=='submitted'||!s||s.id!==body.submissionId||s.invalidatedAt||s.reviews.length)throw new PlanError(409,'SUBMISSION_CONFLICT','本次提交已变化或已被处理，请核对最新成果。');
    validateResponsibilities(record!.ownerId,record!.reviewerId,workspace.actors);
    const selfReview=actor.id===record!.ownerId||actor.id===s.submitterId;
    if(selfReview)requireValue(isProjectManager(actor.role)&&Boolean(reason),'SELF_REVIEW_REASON_REQUIRED','管理人员自审必须填写核查依据并明确确认。');
    let checked:string[]=[],failed:string[]=[];
    if(action==='accept') {
     const required=record!.criteria.filter(c=>c.kind==='evidence').map(c=>c.id);
     checked=reviewedIds(body.checkedCriterionIds??[],record!.criteria.map(c=>c.id),'已核查条件');
     requireValue(required.every(id=>checked.includes(id)),'UNCHECKED_CRITERIA','所有证据条件核查通过后才能验收。');
     const facts=readMilestoneTaskFacts(db,projectId);
     if(record!.criteria.some(c=>c.kind==='task'&&(!facts.get(c.taskId!)?.ready||s.taskVersions[c.taskId!]!==facts.get(c.taskId!)?.fingerprint)))throw new PlanError(409,'SUBMISSION_CONFLICT','必要任务成果已变化，请重新提交。');
     requireValue(current.missing.length===0,'MILESTONE_NOT_READY',current.missing.join('；'));
     record!.state='accepted';record!.acceptedAt=now.toISOString();
    }else {failed=reviewedIds(body.failedCriterionIds??[],record!.criteria.map(c=>c.id),'未通过条件');requireValue(failed.length>0,'FAILED_CRITERIA_REQUIRED','请指出至少一项未通过的必要条件。');record!.state='rejected';for(const e of record!.delivery.evidence)if(failed.includes(e.criterionId))e.declared=false;}
    s.reviews.push({id:randomUUID(),actorId:actor.id,actor:actor.name,decision:action,comment:reason,failedCriterionIds:failed,checkedCriterionIds:checked,selfReview,createdAt:now.toISOString()});
    eventText=`${action==='accept'?'通过验收':'退回修改'}${selfReview?'（管理人员自审）':''}。${reason}`;
   }else {
    requireValue(Boolean(reason),'REASON_REQUIRED','请填写操作依据，并核对影响范围。');
    if(action==='cancel') {requireValue(record!.state!=='cancelled','INVALID_TRANSITION','里程碑已取消。');invalidate(record!,now);record!.state='cancelled';eventText=`取消里程碑，后续依赖不会自动满足。${reason}`;}
    if(action==='restore') {requireValue(record!.state==='cancelled','INVALID_TRANSITION','仅已取消节点可以恢复。');validateResponsibilities(record!.ownerId,record!.reviewerId,workspace.actors);record!.state='draft';eventText=`恢复里程碑，重新检查条件与排期。${reason}`;}
    if(action==='reopen') {requireValue(['accepted','legacy_achieved'].includes(record!.state),'INVALID_TRANSITION','仅已验收或历史达成节点可以重开。');validateResponsibilities(record!.ownerId,record!.reviewerId,workspace.actors);invalidate(record!,now);record!.state='needs_review';eventText=`重开里程碑，原验收记录保留。${reason}`;}
   }
  }
  if(operation==='create'||operation==='update')assertMilestoneAcceptanceGraph([...readMilestoneRecords(db,projectId).filter(m=>m.id!==record!.id),record!],plan.dependencies);
  appendMilestoneEvent(record!,eventAction,actor.id,actor.name,eventText,now);
  saveMilestoneRecord(db,projectId,record!);
  const node=nodes.find(n=>n.id===record!.id)!;node.status=milestonePlanStatus(record!.state);node.progress=record!.state==='accepted'?100:0;Object.assign(node,{milestoneState:record!.state,acceptedAt:record!.acceptedAt});
  db.prepare('UPDATE plan_projects SET nodes_json=?,version=version+1 WHERE project_id=?').run(JSON.stringify(nodes),projectId);
  syncPlanOrder(db,projectId,nodes);
  const changedTaskIds=previousState!==record!.state&&['cancelled','needs_review'].includes(record!.state)?invalidateTasksForMilestone(db,projectId,record!.id,now,actor.name):[];
  changedTaskIds.push(...reconcileMilestones(db,projectId,now,actor.name));
  // Only the changed node is projected: untouched legacy physical rows retain their historical state.
  const history={id:randomUUID(),action:`里程碑：${eventAction}`,actor:actor.name,reason:`${record!.title}：${eventText}`,createdAt:now.toISOString(),affectedCount:1};
  db.prepare('INSERT INTO plan_history VALUES(?,?,?,?)').run(history.id,projectId,JSON.stringify(history),history.createdAt);
  captureBusinessJobs(db,projectId,now,[...new Set(changedTaskIds)]);
  const updated=readMilestones(db,projectId,'',now),result={milestone:updated.milestones.find(m=>m.id===record!.id)!,planVersion:updated.planVersion};
  db.prepare('INSERT INTO milestone_receipts VALUES(?,?,?,?,?)').run(projectId,actor.id,key,hash,JSON.stringify(result));
  return result;
 })();
}
