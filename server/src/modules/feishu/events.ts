import { isExistingDatabase } from '../../db/lifecycle.js';
import type Database from 'better-sqlite3';
import type { FeishuRuleDraft } from '../../../../shared/src/feishu.js';
import type { ManagedTask,TaskEvent } from '../../../../shared/src/tasks.js';
import type { ManagedRisk,RiskAlert } from '../../../../shared/src/risks.js';
import { hasTable } from '../settings/store.js';
import { readMilestoneRecords } from '../milestones/store.js';
export interface FeishuEvent {key:string;template:FeishuRuleDraft['template'];action:string;objectId:string;objectType:'task'|'milestone'|'risk'|'plan';title:string;ownerIds:string[];workstreamId:string;level:string;alertType:string;createdAt:string;actor:string}
interface ObjectState { ownerId:string;level:string|null;state?:string }
const levelRank:Record<string,number>={low:1,medium:2,high:3,critical:4};
function source(db:Database.Database,pid:string,taskIds?:string[],planId?:string):{events:FeishuEvent[];states:Array<{key:string;state:ObjectState}>} {
 const events:FeishuEvent[]=[],states:Array<{key:string;state:ObjectState}>=[];
 const add=(base:Omit<FeishuEvent,'key'|'action'|'createdAt'|'actor'>,prefix:string,history:Array<{id:string;action:string;createdAt:string;actor:string}>,mapping:Record<string,string>)=>{for(const event of history){const action=mapping[event.action];if(action)events.push({...base,key:`${prefix}:${event.id}`,action,createdAt:event.createdAt,actor:event.actor});}};
 if(!planId&&hasTable(db,'task_meta')) {
  const rows=db.prepare('SELECT m.task_id,m.meta_json,h.title,h.workstream_id FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.project_id=? AND (? IS NULL OR m.task_id IN (SELECT value FROM json_each(?)))').all(pid,taskIds?JSON.stringify(taskIds):null,taskIds?JSON.stringify(taskIds):null) as Array<{task_id:string;meta_json:string;title:string;workstream_id:string}>;
  for(const row of rows) {
   const task=JSON.parse(row.meta_json) as ManagedTask,key=`task:${row.task_id}`,state={ownerId:task.ownerId,level:null};states.push({key,state});
   if(task.taskKind==='summary')continue;
   const base={template:'task_event' as const,objectType:'task' as const,objectId:row.task_id,title:row.title,ownerIds:[task.ownerId],workstreamId:row.workstream_id,level:'',alertType:''};
   add(base,key,task.events??[],{create:'assign',assign:'assign',complete:'complete',submit:'submit',accept:'accept',reject:'reject',block:'block',unblock:'unblock'});
   const old=db.prepare('SELECT snapshot_json FROM feishu_object_states WHERE project_id=? AND object_key=?').get(pid,key) as {snapshot_json:string}|undefined;
   const latest=task.events?.at(-1);if(old&&JSON.parse(old.snapshot_json).ownerId!==task.ownerId&&latest&&latest.action!=='create')events.push({...base,key:`${key}:${latest.id}:assign`,action:'assign',createdAt:latest.createdAt,actor:latest.actor});
  }
 }
 if(!planId) for(const milestone of readMilestoneRecords(db,pid)) {
  const key=`milestone:${milestone.id}`,base={template:'milestone_event' as const,objectType:'milestone' as const,objectId:milestone.id,title:milestone.title,ownerIds:[milestone.ownerId],workstreamId:milestone.workstreamId,level:'',alertType:''};
  add(base,key,milestone.events,{submit:'submit',accept:'accept',reject:'reject',invalidated:'needs_review',reopen:'needs_review',needs_review:'needs_review'});
  const old=db.prepare('SELECT snapshot_json FROM feishu_object_states WHERE project_id=? AND object_key=?').get(pid,key) as {snapshot_json:string}|undefined,last=milestone.events.at(-1);
  if(old&&JSON.parse(old.snapshot_json).state!=='needs_review'&&milestone.state==='needs_review'&&last&&!['invalidated','reopen','needs_review'].includes(last.action))events.push({...base,key:`${key}:${last.id}:needs_review`,action:'needs_review',createdAt:last.createdAt,actor:last.actor});
  states.push({key,state:{ownerId:milestone.ownerId,level:null,state:milestone.state}});
 }
 if(!taskIds&&!planId) for(const table of ['risk_records','risk_alerts']) {
  if(!hasTable(db,table))continue;
  for(const row of db.prepare(`SELECT snapshot_json FROM ${table} WHERE project_id=?`).all(pid) as {snapshot_json:string}[]) {
   const item=JSON.parse(row.snapshot_json) as ManagedRisk|RiskAlert,isRisk='ownerId' in item,key=`${table}:${item.id}`;
   const owners=isRisk?[item.ownerId]:hasTable(db,'task_meta')?(db.prepare('SELECT meta_json FROM task_meta WHERE project_id=? AND task_id IN (SELECT value FROM json_each(?))').all(pid,JSON.stringify(item.taskIds)) as {meta_json:string}[]).map(row=>JSON.parse(row.meta_json).ownerId as string):[];
   const base={template:'risk_event' as const,objectType:'risk' as const,objectId:item.id,title:item.title,ownerIds:owners,workstreamId:item.workstreamId,level:isRisk?item.level??item.legacyLevel??'':'',alertType:isRisk?'':item.rule};
   add(base,key,item.events,isRisk?{occur:'occur',approve_close:'approve_close',reopen:'reopen'}:{trigger:'trigger',reopen:'trigger',resolved:'resolve'});
   if(isRisk){const state={ownerId:item.ownerId,level:item.level??item.legacyLevel},old=db.prepare('SELECT snapshot_json FROM feishu_object_states WHERE project_id=? AND object_key=?').get(pid,key) as {snapshot_json:string}|undefined;states.push({key,state});const last=item.events.at(-1);if(old&&last&&(levelRank[state.level??'']??0)>(levelRank[JSON.parse(old.snapshot_json).level]??0))events.push({...base,key:`${key}:${last.id}:escalate`,action:'escalate',actor:last.actor,createdAt:last.createdAt});}
  }
 }
 if(!taskIds&&hasTable(db,'plan_history'))for(const row of db.prepare('SELECT snapshot_json FROM plan_history WHERE project_id=? AND (? IS NULL OR id=?)').all(pid,planId??null,planId??null) as {snapshot_json:string}[])add({template:'plan_event',objectType:'plan',objectId:pid,title:'项目计划',ownerIds:[],workstreamId:'',level:'',alertType:''},'plan_history',[JSON.parse(row.snapshot_json) as TaskEvent],{'应用计划调整':'schedule','发布计划基线':'baseline',schedule:'schedule',publish:'baseline'});
 return {events,states};
}
export function initializeFeishuEvents(db:Database.Database){
  if (isExistingDatabase(db)) return;db.exec(`CREATE TABLE IF NOT EXISTS feishu_events(project_id TEXT NOT NULL,event_key TEXT NOT NULL,snapshot_json TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,event_key)); CREATE INDEX IF NOT EXISTS feishu_events_pending ON feishu_events(processed); CREATE TABLE IF NOT EXISTS feishu_object_states(project_id TEXT NOT NULL,object_key TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(project_id,object_key)); CREATE TABLE IF NOT EXISTS feishu_event_state(key TEXT PRIMARY KEY);`);db.transaction(()=>{if(db.prepare("SELECT 1 FROM feishu_event_state WHERE key='initialized'").get())return;for(const {id} of db.prepare('SELECT id FROM homepage_projects').all() as {id:string}[]){const input=source(db,id);for(const event of input.events)db.prepare('INSERT OR IGNORE INTO feishu_events VALUES(?,?,?,1)').run(id,event.key,JSON.stringify(event));saveStates(db,id,input.states);}db.prepare("INSERT INTO feishu_event_state VALUES('initialized')").run();})();}
function saveStates(db:Database.Database,pid:string,states:Array<{key:string;state:ObjectState}>){for(const {key,state} of states)db.prepare('INSERT INTO feishu_object_states VALUES(?,?,?) ON CONFLICT(project_id,object_key) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(pid,key,JSON.stringify(state));}
/** This inbox is the canonical durable queue; capture and business writes commit or roll back together. */
export function captureFeishuEvents(db:Database.Database,pid:string,_now:Date,taskIds?:string[],planId?:string){if(!hasTable(db,'feishu_events'))return;const run=()=>{const input=source(db,pid,taskIds,planId);for(const event of input.events)db.prepare('INSERT OR IGNORE INTO feishu_events VALUES(?,?,?,0)').run(pid,event.key,JSON.stringify(event));saveStates(db,pid,input.states);};if(db.inTransaction)run();else db.transaction(run)();}
export function eventMatches(event:FeishuEvent,rule:FeishuRuleDraft):boolean{return event.template===rule.template&&rule.actions.includes(event.action)&&(!rule.workstreamIds.length||rule.workstreamIds.includes(event.workstreamId))&&(!rule.ownerIds.length||event.ownerIds.some(id=>rule.ownerIds.includes(id)))&&(!rule.riskLevels.length||Boolean(event.alertType)||rule.riskLevels.includes(event.level))&&(!rule.alertTypes.length||!event.alertType||rule.alertTypes.includes(event.alertType));}
