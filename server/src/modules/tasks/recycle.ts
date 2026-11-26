import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ManagedTask, TaskWorkspace } from '../../../../shared/src/tasks.js';
import type { RecycledTask, RecycleEvent, RecyclePreview, RecycleBlocker, RecyclePage } from '../../../../shared/src/task-recycle.js';
import type { PlanNode, PlanningCalendar } from '../../../../shared/src/planning.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readMembers, hasTable } from '../settings/store.js';
import { readTasks } from './repository.js';
import { canChangeWorkstream } from './workstream-change.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { isWorkday, validDate } from '../planning/calendar.js';
import { syncPlanOrder, readPlanOrder } from '../planning/order.js';
import { readMilestoneRecords } from '../milestones/store.js';
import { recordActivity } from '../activities/repository.js';
import { enqueueJob } from '../../jobs/store.js';

interface Row { snapshot_json: string; deleted_at: string|null; history_json: string }
interface Snapshot { task: ManagedTask; home: Record<string,string|number>; node: PlanNode; siblings: string[] }
function rowFor(db:Database.Database,projectId:string,id:string) { return db.prepare('SELECT snapshot_json,deleted_at,history_json FROM task_recycle WHERE project_id=? AND task_id=?').get(projectId,id) as Row|undefined; }
function member(db:Database.Database,projectId:string,actorId:unknown) {
  // Project membership roles are authoritative here; global-admin elevation is deliberately excluded.
  const actor=readMembers(db,projectId).find(a=>a.id===actorId && a.active && !a.removedAt && a.accountActive!==false);
  if(!actor) throw new PlanError(403,'TASK_FORBIDDEN','需要当前项目有效成员身份。');
  return actor;
}
function allowed(actor:ReturnType<typeof member>,task:ManagedTask,operation:'delete'|'restore'|'read') {
  return isProjectManager(actor.role) || (operation!=='restore' && task.creatorId===actor.id && (operation==='read'||actor.role==='member'));
}
export function taskCapabilities(db:Database.Database,w:TaskWorkspace,actorId:unknown,accountId?:string|null):TaskWorkspace {
  const canChange = canChangeWorkstream(db,w.project.id,actorId,accountId);
  if (!actorId) return {...w,canChangeWorkstream:canChange};
  let actor:ReturnType<typeof member>|undefined;try{actor=member(db,w.project.id,actorId);}catch{/* legacy read without actor */}
  return {...w,canChangeWorkstream:canChange,tasks:w.tasks.map(task=>({...task,canDelete:!!actor&&allowed(actor,task,'delete')}))};
}
export function readRecycledTask(db:Database.Database,projectId:string,id:string,actorId:unknown):RecycledTask {
  const actor=member(db,projectId,actorId),row=rowFor(db,projectId,id);
  if(!row?.deleted_at) throw new PlanError(404,'RECYCLED_TASK_NOT_FOUND','此任务不在回收站，可能已恢复。');
  const {task}=JSON.parse(row.snapshot_json) as Snapshot;
  if(!allowed(actor,task,'read')) throw new PlanError(403,'TASK_FORBIDDEN','任务已删除，当前身份无权查看删除记录。');
  const history=JSON.parse(row.history_json) as RecycleEvent[],last=history.at(-1)!;
  return {task,deletedAt:row.deleted_at,deletedBy:last.actorId,deletedByName:last.actor,reason:last.reason,history,canRestore:isProjectManager(actor.role)};
}
export function readRecyclePage(db:Database.Database,projectId:string,actorId:unknown,query:Record<string,unknown>):RecyclePage {
  const actor=member(db,projectId,actorId);
  requireValue(Object.keys(query).every(k=>['page','pageSize','query','deletedBy','from','to'].includes(k))&&Object.values(query).every(v=>typeof v==='string'),'INVALID_QUERY','回收站筛选参数无效。');
  const page=Number(query.page??1),pageSize=Number(query.pageSize??20),search=String(query.query??'').trim().toLowerCase();
  requireValue(Number.isSafeInteger(page)&&page>0&&[20,50,100].includes(pageSize)&&search.length<=300,'INVALID_QUERY','回收站分页或搜索条件无效。');
  requireValue((!query.from||validDate(query.from))&&(!query.to||validDate(query.to))&&(!query.from||!query.to||String(query.from)<=String(query.to)),'INVALID_QUERY','请选择有效日期范围。');
  const scope=isProjectManager(actor.role)?'':" AND json_extract(snapshot_json,'$.task.creatorId')=?";
  const params=isProjectManager(actor.role)?[projectId]:[projectId,actor.id];
  const rows=db.prepare(`SELECT task_id FROM task_recycle WHERE project_id=? AND deleted_at IS NOT NULL${scope} ORDER BY deleted_at DESC,task_id`).all(...params) as {task_id:string}[];
  const all=rows.map(r=>readRecycledTask(db,projectId,r.task_id,actor.id));
  const deletors=[...new Map(all.map(r=>[r.deletedBy,{id:r.deletedBy,name:r.deletedByName}])).values()];
  const items=all.filter(r=>{
    const day=new Date(new Date(r.deletedAt).getTime()+8*3600000).toISOString().slice(0,10);
    return (!search||`${r.task.title} ${r.task.wbs}`.toLowerCase().includes(search))&&(!query.deletedBy||r.deletedBy===query.deletedBy)&&(!query.from||day>=String(query.from))&&(!query.to||day<=String(query.to));
  });
  const actualPage=Math.min(page,Math.max(1,Math.ceil(items.length/pageSize)));
  return {items:items.slice((actualPage-1)*pageSize,actualPage*pageSize),total:items.length,page:actualPage,pageSize,canRestore:isProjectManager(actor.role),deletors};
}
export function previewRecycle(db:Database.Database,projectId:string,id:string,operation:'delete'|'restore',actorId:unknown,now:Date):RecyclePreview {
  const actor=member(db,projectId,actorId),w=readTasks(db,projectId,'',now),archive=rowFor(db,projectId,id);
  const task=operation==='restore'&&archive?.deleted_at?(JSON.parse(archive.snapshot_json) as Snapshot).task:w.tasks.find(t=>t.id===id);
  if(!task) throw new PlanError(404,'TASK_NOT_FOUND','任务不存在或已被删除/恢复，请刷新。');
  if(!allowed(actor,task,operation))throw new PlanError(403,'TASK_FORBIDDEN',operation==='restore'?'仅项目负责人或管理员可以恢复任务。':'仅项目负责人、管理员或有写权限的创建者可以删除任务。');
  const blockers:RecycleBlocker[]=[];
  let workstreamChange: RecyclePreview['workstreamChange'];
  const add=(kind:RecycleBlocker['kind'],id:string,title:string,message:string)=>blockers.push({kind,id,title,message});
  const milestones=readMilestoneRecords(db,projectId);
  const risks=hasTable(db,'risk_records')?(db.prepare('SELECT snapshot_json FROM risk_records WHERE project_id=?').all(projectId) as {snapshot_json:string}[]).map(r=>JSON.parse(r.snapshot_json)):[];
  if(operation==='delete') {
    for(const child of w.tasks.filter(t=>t.parentId===id))add('child',child.id,child.title,'请先处理子任务，包括已取消子任务。');
    for(const edge of w.dependencies.filter(e=>e.predecessorId===id||e.successorId===id)){
      const other=edge.predecessorId===id?edge.successorId:edge.predecessorId;
      add('dependency',other,w.tasks.find(t=>t.id===other)?.title??milestones.find(m=>m.id===other)?.title??other,'请先到完整计划解除前后置依赖。');
    }
    for(const milestone of milestones.filter(m=>m.criteria.some(c=>c.kind==='task'&&c.taskId===id)))add('milestone',milestone.id,milestone.title,'请先调整当前里程碑验收条件。');
    for(const risk of risks.filter(r=>[...(r.taskIds??[]),...(r.actionTaskIds??[])].includes(id)))add('risk',risk.id,risk.title,'请先解除当前风险关联。');
  } else {
    const liveParent = w.tasks.find(t=>t.id===task.parentId);
    const restoreWorkstreamId = liveParent?.workstreamId ?? task.workstreamId;
    if (restoreWorkstreamId !== task.workstreamId) workstreamChange = {fromId:task.workstreamId,toId:restoreWorkstreamId,fromName:w.workstreams.find(s=>s.id===task.workstreamId)?.name??task.workstreamId,toName:w.workstreams.find(s=>s.id===restoreWorkstreamId)?.name??restoreWorkstreamId};
    if(!w.workstreams.some(s=>s.id===restoreWorkstreamId&&s.active!==false))add('workstream',restoreWorkstreamId,'恢复目标工作分组已停用','请先启用恢复目标工作分组。');
    let parentId=task.parentId;const visited=new Set<string>();
    while(parentId&&!visited.has(parentId)) {visited.add(parentId);const parent=w.tasks.find(t=>t.id===parentId);if(!parent||parent.status==='cancelled'){add('parent',parentId,parent?.title??'原父任务不可用','请先恢复原父任务及其有效状态。');break;}parentId=parent.parentId;}
    for(const [id,label] of [[task.ownerId,'负责人'],...(task.requiresReview?[[task.reviewerId,'验收人']]:[])] as Array<[string|null,string]>) {
      if(!w.actors.some(a=>a.id===id&&a.assignable!==false&&a.role!=='viewer'))add('member',id??'',`原${label}不可用`,`请先恢复原${label}及权限。`);
    }
    if(task.requiresReview&&task.ownerId===task.reviewerId&&!isProjectManager(w.actors.find(a=>a.id===task.ownerId)?.role))add('member',task.ownerId,'原验收资格已变化','请先恢复原独立验收资格。');
    const calendar=JSON.parse((db.prepare('SELECT calendar_json FROM plan_projects WHERE project_id=?').get(projectId) as {calendar_json:string}).calendar_json) as PlanningCalendar;
    if(task.start&&task.end&&(task.start<w.project.start||!isWorkday(task.start,calendar)||!isWorkday(task.end,calendar)))add('calendar',id,'原计划日期不满足当前日历','请先在完整计划修复日历约束。');
  }
  // Bind every input used to judge impact, including role/association changes outside the plan version.
  const previewToken=createHash('sha256').update(JSON.stringify({projectId,id,operation,actor,task,planVersion:w.planVersion,structure:w.structureVersion,actors:w.actors,streams:w.workstreams,milestones,risks,blockers,archive,workstreamChange,parents:w.tasks.filter(t=>t.id===task.parentId)})).digest('hex');
  return {task,operation,previewToken,blockers,...(workstreamChange?{workstreamChange}:{})};
}
export function writeRecycle(db:Database.Database,projectId:string,id:string,operation:'delete'|'restore',actorId:unknown,body:unknown,key:unknown,now:Date,actorName?:string) {
  requireValue(body&&typeof body==='object'&&!Array.isArray(body),'INVALID_REQUEST','请提供删除或恢复内容。');
  const input=body as Record<string,unknown>;
  requireValue(Object.keys(input).every(k=>['previewToken','reason'].includes(k))&&typeof input.previewToken==='string','INVALID_REQUEST','请先检查任务影响。');
  requireValue(typeof input.reason==='string'&&input.reason.trim().length>0&&input.reason.trim().length<=500,'REASON_REQUIRED','请填写 1–500 字的原因。');
  requireValue(typeof key==='string'&&/^[\w:.-]{8,128}$/.test(key),'IDEMPOTENCY_KEY_REQUIRED','请提供唯一操作标识。');
  return db.transaction(()=>{
    const actor=member(db,projectId,actorId),old=rowFor(db,projectId,id);
    const metaRow=db.prepare('SELECT meta_json FROM task_meta WHERE project_id=? AND task_id=?').get(projectId,id) as {meta_json:string}|undefined;
    if(!metaRow)throw new PlanError(404,'TASK_NOT_FOUND','任务不存在。');
    const meta=JSON.parse(metaRow.meta_json);
    if(!allowed(actor,meta,operation))throw new PlanError(403,'TASK_FORBIDDEN','当前身份无权执行此操作。');
    const hash=createHash('sha256').update(JSON.stringify({id,operation,input})).digest('hex');
    const receipt=db.prepare('SELECT request_hash,response_json FROM task_recycle_receipts WHERE project_id=? AND actor_id=? AND request_key=?').get(projectId,actor.id,key) as {request_hash:string;response_json:string}|undefined;
    if(receipt){if(receipt.request_hash!==hash)throw new PlanError(409,'IDEMPOTENCY_CONFLICT','操作标识已用于不同内容。');return JSON.parse(receipt.response_json);}
    const preview=previewRecycle(db,projectId,id,operation,actor.id,now);
    if(preview.previewToken!==input.previewToken)throw new PlanError(409,'RECYCLE_PREVIEW_STALE','任务或关联已变化，请保留原因并重新检查。');
    requireValue(preview.blockers.length===0,'TASK_REFERENCED','请先处理检查中列出的关联或失效条件。');
    const event:RecycleEvent={id:randomUUID(),action:operation,actorId:actor.id,actor:actorName??actor.name,reason:(input.reason as string).trim(),createdAt:now.toISOString()};
    const history:RecycleEvent[]=[...(old?JSON.parse(old.history_json):[]),event];
    const plan=db.prepare('SELECT nodes_json,version FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string;version:number};
    let nodes=JSON.parse(plan.nodes_json) as PlanNode[];
    let snapshot:Snapshot;
    if(operation==='delete') {
      const home=db.prepare('SELECT * FROM homepage_tasks WHERE project_id=? AND id=?').get(projectId,id) as Snapshot['home'];
      const node=nodes.find(n=>n.id===id)!;
      snapshot={task:preview.task,home,node,siblings:readPlanOrder(db,projectId,nodes).siblingOrders.find(s=>s.parentId===node.parentId)?.nodeIds??[]};
      nodes=nodes.filter(n=>n.id!==id);
      db.prepare('DELETE FROM homepage_tasks WHERE project_id=? AND id=?').run(projectId,id);
    } else {
      snapshot=JSON.parse(old!.snapshot_json) as Snapshot;
      const restoreHome = {...snapshot.home};
      const restoreNode = {...snapshot.node};
      if (preview.workstreamChange) {
        restoreHome.workstream_id = preview.workstreamChange.toId;
        restoreNode.workstreamId = preview.workstreamChange.toId;
        restoreNode.color = nodes.find(n=>n.id===`group-${preview.workstreamChange!.toId}`)!.color;
      }
      const columns=['id','project_id','title','workstream_id','owner','initials','status','priority','due','progress','blocked','position'];
      db.prepare(`INSERT INTO homepage_tasks (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>restoreHome[k]));
      nodes.push(restoreNode);
    }
    meta.version=(meta.version??0)+1;meta.updatedAt=event.createdAt;
    const restoreNotice = preview.workstreamChange ? `；跟随父任务调整工作分组：${preview.workstreamChange.fromName} → ${preview.workstreamChange.toName}` : '';
    meta.events.push({id:event.id,taskId:id,actor:event.actor,action:operation,text:event.reason+restoreNotice,createdAt:event.createdAt});
    db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify(meta),projectId,id);
    db.prepare('INSERT INTO task_recycle VALUES(?,?,?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,deleted_at=excluded.deleted_at,history_json=excluded.history_json').run(projectId,id,operation==='restore'?old!.snapshot_json:JSON.stringify(snapshot),operation==='delete'?event.createdAt:null,JSON.stringify(history));
    db.prepare('UPDATE plan_projects SET nodes_json=?,version=version+1 WHERE project_id=?').run(JSON.stringify(nodes),projectId);
    syncPlanOrder(db,projectId,nodes);
    if(operation==='restore') {
      const orders=readPlanOrder(db,projectId,nodes).siblingOrders;
      const siblings=orders.find(o=>o.parentId===snapshot.node.parentId);
      if(siblings){siblings.nodeIds=siblings.nodeIds.filter(n=>n!==id);const pos=snapshot.siblings.indexOf(id);const next=snapshot.siblings.slice(pos+1).find(n=>siblings.nodeIds.includes(n));const previous=snapshot.siblings.slice(0,pos).reverse().find(n=>siblings.nodeIds.includes(n));const at=next?siblings.nodeIds.indexOf(next):previous?siblings.nodeIds.indexOf(previous)+1:siblings.nodeIds.length;siblings.nodeIds.splice(at,0,id);}
      db.prepare('UPDATE plan_order_projects SET orders_json=? WHERE project_id=?').run(JSON.stringify(orders),projectId);
    }
    db.prepare('UPDATE plan_order_projects SET version=version+1 WHERE project_id=?').run(projectId);
    // Refresh ancestor projections after removing/restoring a leaf; preserve historical snapshots.
    const w=readTasks(db,projectId,'',now);
    for(const summary of w.tasks.filter(t=>t.taskKind==='summary')) {
      const status=summary.status==='cancelled'?'todo':summary.status;
      db.prepare('UPDATE homepage_tasks SET status=?,progress=?,blocked=? WHERE project_id=? AND id=?').run(status,summary.progress,Number(summary.blocked),projectId,summary.id);
      const node=nodes.find(n=>n.id===summary.id);if(node)Object.assign(node,{status,progress:summary.progress,blocked:summary.blocked,start:summary.start,end:summary.end,effortHours:summary.effortHours});
    }
    db.prepare('UPDATE plan_projects SET nodes_json=? WHERE project_id=?').run(JSON.stringify(nodes),projectId);
    const title=preview.task.title,verb=operation==='delete'?'删除任务':'恢复任务';
    recordActivity(db,{projectId,sourceKey:`task-recycle:${event.id}`,type:`task.${operation}`,category:'task',actor:{id:actor.id,name:event.actor},occurredAt:event.createdAt,target:{kind:'task',id,name:title},summary:`${verb}「${title}」`,changes:[{field:'reason',before:null,after:event.reason}]});
    const recipients=new Set([preview.task.ownerId,preview.task.creatorId,preview.task.reviewerId,...readMembers(db,projectId).filter(a=>isProjectManager(a.role)).map(a=>a.id)]);
    const active=readMembers(db,projectId).filter(a=>a.active&&!a.removedAt&&a.accountActive!==false&&a.role!=='viewer');
    for(const recipient of active.filter(a=>a.id!==actor.id&&recipients.has(a.id)))enqueueJob(db,{projectId,kind:'notification',dedupeKey:`recycle:${event.id}:${recipient.id}`,dueAt:now,payload:{recipientId:recipient.id,eventKey:`recycle:${event.id}`,kind:`task.${operation}`,title:`${verb} · ${title}`,message:`${event.actor}：${event.reason}`,target:{kind:'task',id}}},now);
    const result={taskId:id,operation,planVersion:plan.version+1};
    db.prepare('INSERT INTO task_recycle_receipts VALUES(?,?,?,?,?)').run(projectId,actor.id,key,hash,JSON.stringify(result));return result;
  }).immediate();
}
