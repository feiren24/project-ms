import { isExistingDatabase } from '../../db/lifecycle.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PlanNode, PlanSiblingOrder, PlanOrderRequest, PlanOrderResult } from '../../../../shared/src/planning.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readActors, hasTable } from '../settings/store.js';
import { capturePlanHistoryEvent } from '../notifications/events.js';
import { PlanError, requireValue } from './errors.js';

export function initializePlanOrder(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS plan_order_projects (
    project_id TEXT PRIMARY KEY REFERENCES plan_projects(project_id), version INTEGER NOT NULL DEFAULT 1,
    orders_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(orders_json)));
    CREATE TABLE IF NOT EXISTS plan_order_receipts (
    project_id TEXT NOT NULL REFERENCES plan_projects(project_id), actor_id TEXT NOT NULL, request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,response_json TEXT NOT NULL CHECK(json_valid(response_json)),PRIMARY KEY(project_id,actor_id,request_key));`);
  db.transaction(() => {
    for (const row of db.prepare('SELECT project_id,nodes_json FROM plan_projects').all() as {project_id:string;nodes_json:string}[])
      syncPlanOrder(db,row.project_id,JSON.parse(row.nodes_json));
  })();
}
function normalized(nodes: PlanNode[], orders: PlanSiblingOrder[]): PlanSiblingOrder[] {
  const groups = new Map<string,string[]>(), byId = new Map(nodes.map(node=>[node.id,node]));
  for (const node of nodes) if (node.parentId !== null) { const ids=groups.get(node.parentId)??[];ids.push(node.id);groups.set(node.parentId,ids); }
  const old = new Map(orders.map(order=>[order.parentId,order.nodeIds]));
  return [...groups].map(([parentId,ids]) => {
    const seen = new Set<string>(), nodeIds:string[]=[];
    for (const id of old.get(parentId)??[]) if (byId.get(id)?.parentId===parentId && !seen.has(id)) {seen.add(id);nodeIds.push(id);}
    for (const id of ids) if (!seen.has(id)) {seen.add(id);nodeIds.push(id);}
    return {parentId,nodeIds};
  });
}
/** Called with stored nodes, including cancelled records, inside structural writes. */
export function syncPlanOrder(db: Database.Database, projectId:string, nodes:PlanNode[], wrapper?:{originalId:string;wrapperId:string}) {
  const row=db.prepare('SELECT version,orders_json FROM plan_order_projects WHERE project_id=?').get(projectId) as {version:number;orders_json:string}|undefined;
  const orders:PlanSiblingOrder[]=row?JSON.parse(row.orders_json):[];
  if(wrapper) for(const order of orders) order.nodeIds=order.nodeIds.map(id=>id===wrapper.originalId?wrapper.wrapperId:id);
  const json=JSON.stringify(normalized(nodes,orders));
  if(!row) db.prepare('INSERT INTO plan_order_projects(project_id,orders_json) VALUES (?,?)').run(projectId,json);
  else if(json!==row.orders_json) db.prepare('UPDATE plan_order_projects SET orders_json=? WHERE project_id=?').run(json,projectId);
}
export function readPlanOrder(db:Database.Database,projectId:string,nodes:PlanNode[]) {
  const row=db.prepare('SELECT version,orders_json FROM plan_order_projects WHERE project_id=?').get(projectId) as {version:number;orders_json:string}|undefined;
  return {orderVersion:row?.version??1,siblingOrders:normalized(nodes,row?JSON.parse(row.orders_json):[])};
}
export function savePlanOrder(db:Database.Database,projectId:string,request:PlanOrderRequest,key:unknown,actorId:unknown,now:Date,actorName?:string):PlanOrderResult {
  return db.transaction(() => {
    // Authorize inside the transaction, before even looking up a receipt.
    const actor=readActors(db,projectId).find(actor=>actor.id===actorId);
    if(!actor || !isProjectManager(actor.role)) throw new PlanError(403,'MANAGER_REQUIRED','仅项目负责人或管理员可以调整任务顺序。');
    requireValue(typeof key==='string' && /^[\w:.-]{8,128}$/.test(key),'IDEMPOTENCY_KEY_REQUIRED','请提供 8–128 字符的唯一操作标识。');
    requireValue(request && Object.keys(request).every(k=>['expectedOrderVersion','orders'].includes(k)) && Number.isSafeInteger(request.expectedOrderVersion) && request.expectedOrderVersion>0 && Array.isArray(request.orders) && request.orders.length>0,'INVALID_PLAN_ORDER','请提交有效的任务排序。');
    const hash=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous=db.prepare('SELECT request_hash,response_json FROM plan_order_receipts WHERE project_id=? AND actor_id=? AND request_key=?').get(projectId,actor.id,key) as {request_hash:string;response_json:string}|undefined;
    if(previous) {if(previous.request_hash!==hash) throw new PlanError(409,'IDEMPOTENCY_CONFLICT','此操作标识已用于不同请求，请重新保存。');return JSON.parse(previous.response_json);}
    const stored=db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string}|undefined;
    if(!stored) throw new PlanError(404,'PROJECT_NOT_FOUND','未找到此项目。');
    const nodes=JSON.parse(stored.nodes_json) as PlanNode[];
    syncPlanOrder(db,projectId,nodes);
    const state=readPlanOrder(db,projectId,nodes);
    if(state.orderVersion!==request.expectedOrderVersion) throw new PlanError(409,'ORDER_VERSION_CONFLICT','任务顺序已更新，请刷新后重新调整。',{latestOrderVersion:state.orderVersion});
    const cancelled=new Set(hasTable(db,'task_meta')?(db.prepare("SELECT task_id FROM task_meta WHERE project_id=? AND json_extract(meta_json,'$.cancelled')=1").all(projectId) as {task_id:string}[]).map(row=>row.task_id):[]);
    const active=nodes.filter(node=>!cancelled.has(node.id)), byId=new Map(active.map(node=>[node.id,node]));
    const groups=new Map(readPlanOrder(db,projectId,active).siblingOrders.map(order=>[order.parentId,order.nodeIds]));
    const proposed=new Map<string,string[]>();let affectedCount=0;
    for(const order of request.orders) {
      requireValue(order && Object.keys(order).every(k=>['parentId','nodeIds'].includes(k)) && typeof order.parentId==='string' && Array.isArray(order.nodeIds) && order.nodeIds.every(id=>typeof id==='string') && !proposed.has(order.parentId) && new Set(order.nodeIds).size===order.nodeIds.length,'INVALID_PLAN_ORDER','同级集合和任务不能重复。');
      const current=groups.get(order.parentId);
      if(!byId.has(order.parentId) || !current || current.length!==order.nodeIds.length || order.nodeIds.some(id=>byId.get(id)?.parentId!==order.parentId)) throw new PlanError(409,'ORDER_MEMBERSHIP_CONFLICT','同级任务已变化，请刷新后重新调整。');
      const currentPositions=new Map(current.map((id,index)=>[id,index]));
      affectedCount+=order.nodeIds.filter((id,index)=>currentPositions.get(id)!==index).length;
      proposed.set(order.parentId,order.nodeIds);
    }
    // Hidden cancelled nodes retain their slots. Only active sibling slots are permuted.
    const orders=state.siblingOrders.map(order=>{const ids=proposed.get(order.parentId);let i=0;return ids?{parentId:order.parentId,nodeIds:order.nodeIds.map(id=>cancelled.has(id)?id:ids[i++]!)}:order;});
    const result={orderVersion:state.orderVersion+(affectedCount?1:0),affectedCount};
    if(affectedCount) {
      db.prepare('UPDATE plan_order_projects SET version=?,orders_json=? WHERE project_id=?').run(result.orderVersion,JSON.stringify(orders),projectId);
      const event={id:randomUUID(),action:'调整任务顺序',actor:actorName??actor.name,reason:'调整同级任务展示顺序',affectedCount,createdAt:now.toISOString(),orders:[...proposed].map(([parentId,after])=>({parentId,before:groups.get(parentId)!,after}))};
      db.prepare('INSERT INTO plan_history VALUES (?,?,?,?)').run(event.id,projectId,JSON.stringify(event),event.createdAt);
      capturePlanHistoryEvent(db,projectId,now,event.id);
    }
    db.prepare('INSERT INTO plan_order_receipts VALUES (?,?,?,?,?)').run(projectId,actor.id,key,hash,JSON.stringify(result));
    return result;
  }).immediate();
}
