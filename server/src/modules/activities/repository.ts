import { publicActivitySql } from './privacy.js';
import { isExistingDatabase } from '../../db/lifecycle.js';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ActivityActor, ActivityBackfill, ActivityCategory, ActivityChange, ActivityItem, ActivityItemsPage, ActivityPage, ActivityRange, ActivitySummary, ActivityTarget } from '../../../../shared/src/activities.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { hasTable } from '../settings/store.js';

export interface ActivityInput { projectId: string; sourceKey: string; type: string; category: ActivityCategory; actor: ActivityActor; occurredAt: string; target: ActivityTarget | null; summary: string; changes?: ActivityChange[]; historical?: boolean; groupable?: boolean; forceNewGroup?: boolean; items?: Array<{target:ActivityTarget;summary:string;changes?:ActivityChange[]}> }
interface GroupRow { id:string;project_id:string;type:string;category:ActivityCategory;actor_id:string|null;actor_name:string;occurred_at:string;historical:number;first_seq:number;target_json:string|null;summary:string|null }
interface ItemRow { seq:number;id:string;target_json:string|null;summary:string;occurred_at:string;historical:number;changes_json:string }
interface BackfillRow { status:ActivityBackfill['status'];processed_tasks:number;error:string|null;cutoff:string;lower_bound:string;cursor:number;attempts:number;retry_at:string|null }
interface Cursor { management?:boolean;version:number;project:string;category:string;range:string;lower:string;upper:string;highwater:number;beforeTime?:string;beforeSeq?:number;group?:string;afterSeq?:number }
export function initializeActivities(db:Database.Database,now=new Date()) {
  if (isExistingDatabase(db)) return;
 db.transaction(()=>{
  const migrateProjectProgress = !hasTable(db,'activity_backfill_projects');
  db.exec(`CREATE TABLE IF NOT EXISTS activity_groups(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,type TEXT NOT NULL,category TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,occurred_at TEXT NOT NULL,historical INTEGER NOT NULL,first_seq INTEGER NOT NULL DEFAULT 0,target_json TEXT,summary TEXT);
   CREATE INDEX IF NOT EXISTS activity_group_feed ON activity_groups(project_id,occurred_at DESC,first_seq DESC);
   CREATE INDEX IF NOT EXISTS activity_group_actor ON activity_groups(project_id,actor_id,type,occurred_at DESC);
   CREATE TABLE IF NOT EXISTS activity_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,group_id TEXT NOT NULL REFERENCES activity_groups(id),project_id TEXT NOT NULL,source_key TEXT NOT NULL,target_json TEXT,summary TEXT NOT NULL,occurred_at TEXT NOT NULL,historical INTEGER NOT NULL,changes_json TEXT NOT NULL,UNIQUE(project_id,source_key));
   CREATE INDEX IF NOT EXISTS activity_items_group ON activity_items(group_id,seq);
   CREATE INDEX IF NOT EXISTS activity_items_project ON activity_items(project_id,seq);
   CREATE TABLE IF NOT EXISTS activity_versions(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS activity_config(id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS activity_backfill_projects(project_id TEXT PRIMARY KEY,processed_tasks INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS activity_backfill(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,processed_tasks INTEGER NOT NULL DEFAULT 0,error TEXT,cutoff TEXT NOT NULL,lower_bound TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,retry_at TEXT);`);
  const groupColumns=db.pragma('table_info(activity_groups)') as {name:string}[];
  if(!groupColumns.some(column=>column.name==='target_json'))db.exec('ALTER TABLE activity_groups ADD COLUMN target_json TEXT');
  if(!groupColumns.some(column=>column.name==='summary'))db.exec('ALTER TABLE activity_groups ADD COLUMN summary TEXT');
  db.prepare('INSERT OR IGNORE INTO activity_config VALUES(1,?)').run(randomBytes(32).toString('hex'));
  db.prepare("INSERT OR IGNORE INTO activity_backfill(id,status,cutoff,lower_bound) VALUES(1,'pending',?,?)").run(now.toISOString(),new Date(now.getTime()-168*3600000).toISOString());
  // Upgrade only: recover project ownership of already committed batches once.
  if(migrateProjectProgress && hasTable(db,'task_meta')) db.exec(`INSERT INTO activity_backfill_projects(project_id,processed_tasks) SELECT project_id,COUNT(*) FROM task_meta WHERE rowid<=(SELECT cursor FROM activity_backfill WHERE id=1) GROUP BY project_id`);
 })();
}
export function activityVersion(db:Database.Database,projectId:string,canViewManagement=true) {
 if(!canViewManagement) {
  const visibleItems=hasTable(db,'activity_items') ? (db.prepare(`SELECT COUNT(*) AS count FROM activity_items i JOIN activity_groups g ON g.id=i.group_id WHERE g.project_id=? AND ${publicActivitySql()}`).get(projectId) as {count:number}).count : 0;
  const backfill=hasTable(db,'activity_backfill') ? activityBackfill(db,projectId) : null;
  // Clients use equality, not arithmetic. Keep a stable, safe integer derived only
  // from visible items and the exact project-scoped backfill fields we return.
  return Number.parseInt(createHash('sha256').update(JSON.stringify({visibleItems,backfill})).digest('hex').slice(0,13),16);
 }
 return hasTable(db,'activity_versions') ? (db.prepare('SELECT version FROM activity_versions WHERE project_id=?').get(projectId) as {version:number}|undefined)?.version??0:0;
}
function bump(db:Database.Database,projectId:string) { db.prepare('INSERT INTO activity_versions VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET version=version+1').run(projectId); }
function localDay(time:string) {return new Date(new Date(time).getTime()+8*3600000).toISOString().slice(0,10);}
/** Call at the successful mutation site, inside its existing business transaction. */
export function recordActivity(db:Database.Database,input:ActivityInput):string|null {
 if(!hasTable(db,'activity_items')) return null;
 if(!db.inTransaction) return db.transaction(()=>recordActivity(db,input))();
 input={...input,occurredAt:new Date(input.occurredAt).toISOString()};
 const duplicate=db.prepare('SELECT group_id FROM activity_items WHERE project_id=? AND source_key=?').get(input.projectId,input.sourceKey) as {group_id:string}|undefined;
 if(duplicate) return duplicate.group_id;
 let group:GroupRow|undefined;
 if(input.groupable && !input.forceNewGroup && input.actor.id && !input.historical) {
  const candidate=db.prepare("SELECT * FROM activity_groups WHERE project_id=? AND actor_id=? AND type='task.complete' AND historical=0 AND occurred_at<=? AND occurred_at>? ORDER BY occurred_at DESC,first_seq DESC LIMIT 1").get(input.projectId,input.actor.id,input.occurredAt,new Date(new Date(input.occurredAt).getTime()-600000).toISOString()) as GroupRow|undefined;
  if(candidate && localDay(candidate.occurred_at)===localDay(input.occurredAt) && !db.prepare("SELECT 1 FROM activity_items WHERE group_id=? AND json_extract(target_json,'$.id')=? LIMIT 1").get(candidate.id,input.target?.id??'')) group=candidate;
 }
 const id=group?.id??randomUUID();
 if(!group) db.prepare('INSERT INTO activity_groups(id,project_id,type,category,actor_id,actor_name,occurred_at,historical,target_json,summary) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,input.projectId,input.type,input.category,input.actor.id,input.actor.name,input.occurredAt,Number(Boolean(input.historical)),input.items?.length&&input.target?JSON.stringify(input.target):null,input.items?.length?input.summary:null);
 const children=input.items?.length?input.items:[{target:input.target,summary:input.summary,changes:input.changes}];
 const insert=db.prepare('INSERT INTO activity_items(id,group_id,project_id,source_key,target_json,summary,occurred_at,historical,changes_json) VALUES(?,?,?,?,?,?,?,?,?)');
 for(const [index,item] of children.entries()) {
  const result=insert.run(randomUUID(),id,input.projectId,index===0?input.sourceKey:`${input.sourceKey}:item:${index}`,item.target?JSON.stringify(item.target):null,item.summary,input.occurredAt,Number(Boolean(input.historical)),JSON.stringify(item.changes??[]));
  if(index===0&&!group)db.prepare('UPDATE activity_groups SET first_seq=? WHERE id=?').run(result.lastInsertRowid,id);
 }
 bump(db,input.projectId);return id;
}
export function activityBackfill(db:Database.Database,projectId:string):ActivityBackfill { const row=db.prepare('SELECT status,error FROM activity_backfill WHERE id=1').get() as BackfillRow;const progress=db.prepare('SELECT processed_tasks FROM activity_backfill_projects WHERE project_id=?').get(projectId) as {processed_tasks:number}|undefined;return {status:row.status,processedTasks:progress?.processed_tasks??0,error:row.error}; }
function secret(db:Database.Database) {return (db.prepare('SELECT secret FROM activity_config WHERE id=1').get() as {secret:string}).secret;}
const CURSOR_VERSION='v2';
const CURSOR_AAD=Buffer.from('goodwork:activity-cursor:v2');
const CURSOR_PLAINTEXT_BYTES=2048;
function cursorKey(db:Database.Database) {return createHmac('sha256',secret(db)).update(CURSOR_AAD).digest();}
function encode(db:Database.Database,data:Cursor) {
 const json=Buffer.from(JSON.stringify(data));
 if(json.length>CURSOR_PLAINTEXT_BYTES-2)throw new Error('Activity cursor exceeds its fixed payload size');
 // Fixed padding also hides sequence digit lengths and optional pagination fields.
 const plaintext=Buffer.alloc(CURSOR_PLAINTEXT_BYTES);plaintext.writeUInt16BE(json.length);json.copy(plaintext,2);
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey(db),nonce);
 cipher.setAAD(CURSOR_AAD);
 const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 return `${CURSOR_VERSION}.${Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64url')}`;
}
function decode(db:Database.Database,raw:unknown):Cursor {
 try {
  // Legacy HMAC-only cursors disclose global sequence counters; require refresh.
  if(typeof raw!=='string'||raw.length>4096)throw Error();
  const [version,value,...rest]=raw.split('.');
  if(version!==CURSOR_VERSION||!value||rest.length||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const packed=Buffer.from(value,'base64url');
  if(packed.length!==12+16+CURSOR_PLAINTEXT_BYTES||packed.toString('base64url')!==value)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',cursorKey(db),packed.subarray(0,12));
  decipher.setAAD(CURSOR_AAD);decipher.setAuthTag(packed.subarray(12,28));
  const plaintext=Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]);
  const size=plaintext.readUInt16BE(0);if(size<2||size>CURSOR_PLAINTEXT_BYTES-2)throw Error();
  return JSON.parse(plaintext.subarray(2,2+size).toString());
 }catch{throw new PlanError(422,'ACTIVITY_CURSOR_INVALID','动态分页已失效，请刷新动态后重试。');}
}
function pageLimit(value:unknown) { const limit=value===undefined?20:Number(value);requireValue(Number.isInteger(limit)&&limit>=1&&limit<=50,'INVALID_ACTIVITY_LIMIT','每页动态须为 1–50 条。');return limit; }
function baseCursor(db:Database.Database,projectId:string,query:Record<string,unknown>,now:Date,group?:string,canViewManagement=true):Cursor {
 if(!db.prepare('SELECT 1 FROM homepage_projects WHERE id=?').get(projectId))throw new PlanError(404,'PROJECT_NOT_FOUND','未找到此项目。');
 const category=query.category??'all',range=query.range??'7d';requireValue(['all','task','plan','risk','project','member','workgroup'].includes(String(category))&&['7d','30d','all'].includes(String(range)),'INVALID_ACTIVITY_FILTER','动态筛选条件无效。');
 if(query.cursor){const cursor=decode(db,query.cursor);requireValue(cursor.project===projectId&&cursor.group===group&&(!group?(cursor.category===category&&cursor.range===range):true),'ACTIVITY_CURSOR_MISMATCH','动态分页与当前筛选不一致，请刷新后重试。');return {...cursor,management:canViewManagement,version:(cursor.management??true)===canViewManagement?cursor.version:activityVersion(db,projectId,canViewManagement)};}
 return {management:canViewManagement,version:activityVersion(db,projectId,canViewManagement),project:projectId,category:String(category),range:String(range),lower:range==='all'?'0000':new Date(now.getTime()-(range==='30d'?30:7)*86400000).toISOString(),upper:now.toISOString(),highwater:(db.prepare(`SELECT COALESCE(MAX(i.seq),0) AS seq FROM activity_items i JOIN activity_groups g ON g.id=i.group_id WHERE g.project_id=? AND ${canViewManagement?'1':publicActivitySql()}`).get(projectId) as {seq:number}).seq,...(group?{group}:{})};
}
function available(db:Database.Database,projectId:string,target:ActivityTarget|null):ActivityTarget|null {
 if(!target)return null;let exists=false;
 if(target.kind==='task')exists=Boolean(db.prepare('SELECT 1 FROM homepage_tasks WHERE project_id=? AND id=?').get(projectId,target.id)) || (hasTable(db,'task_recycle') && Boolean(db.prepare('SELECT 1 FROM task_recycle WHERE project_id=? AND task_id=? AND deleted_at IS NOT NULL').get(projectId,target.id)));
 else if(target.kind==='risk'&&hasTable(db,'risk_records'))exists=Boolean(db.prepare('SELECT 1 FROM risk_records WHERE project_id=? AND id=?').get(projectId,target.id));
 else if(target.kind==='member'&&hasTable(db,'project_members'))exists=Boolean(db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND id=? AND removed_at IS NULL').get(projectId,target.id));
 else if(target.kind==='workgroup'&&hasTable(db,'workstreams'))exists=Boolean(db.prepare('SELECT 1 FROM workstreams WHERE project_id=? AND id=?').get(projectId,target.id));
 else if(target.kind==='baseline'&&hasTable(db,'plan_baselines'))exists=Boolean(db.prepare('SELECT 1 FROM plan_baselines WHERE project_id=? AND id=?').get(projectId,target.id));
 else if(target.kind==='plan_history'&&hasTable(db,'plan_history'))exists=Boolean(db.prepare('SELECT 1 FROM plan_history WHERE project_id=? AND id=?').get(projectId,target.id));
 else if(target.kind==='milestone'&&hasTable(db,'plan_projects'))exists=Boolean(db.prepare("SELECT 1 FROM plan_projects,json_each(nodes_json) WHERE project_id=? AND json_extract(value,'$.id')=? AND json_extract(value,'$.kind')='milestone'").get(projectId,target.id));
 else if(target.kind==='project'||target.kind==='plan')exists=Boolean(db.prepare('SELECT 1 FROM homepage_projects WHERE id=?').get(projectId));
 return {...target,available:exists};
}
function item(db:Database.Database,project:string,row:ItemRow):ActivityItem {return {id:row.id,target:available(db,project,row.target_json?JSON.parse(row.target_json):null),summary:row.summary,occurredAt:row.occurred_at,historical:Boolean(row.historical),changes:JSON.parse(row.changes_json)};}
export function readActivities(db:Database.Database,projectId:string,query:Record<string,unknown>,now=new Date(),canViewManagement=true):ActivityPage {
 const limit=pageLimit(query.limit),cursor=baseCursor(db,projectId,query,now,undefined,canViewManagement);
 const rows=db.prepare(`SELECT g.* FROM activity_groups g WHERE g.project_id=? AND ${canViewManagement?'1':publicActivitySql()} AND (?='all' OR category=?) AND first_seq<=? AND (? IS NULL OR occurred_at<? OR (occurred_at=? AND first_seq<?)) AND EXISTS(SELECT 1 FROM activity_items i WHERE i.group_id=g.id AND seq<=? AND occurred_at>=? AND occurred_at<=?) ORDER BY occurred_at DESC,first_seq DESC LIMIT ?`).all(projectId,cursor.category,cursor.category,cursor.highwater,cursor.beforeTime??null,cursor.beforeTime??null,cursor.beforeTime??null,cursor.beforeSeq??0,cursor.highwater,cursor.lower,cursor.upper,limit+1) as GroupRow[];
 const items=rows.slice(0,limit).map((group):ActivitySummary=>{
  const params=[group.id,cursor.highwater,cursor.lower,cursor.upper];
  const stats=db.prepare('SELECT COUNT(*) AS count,MAX(occurred_at) AS last FROM activity_items WHERE group_id=? AND seq<=? AND occurred_at>=? AND occurred_at<=?').get(...params) as {count:number;last:string};
  const children=db.prepare('SELECT * FROM activity_items WHERE group_id=? AND seq<=? AND occurred_at>=? AND occurred_at<=? ORDER BY seq LIMIT 3').all(...params) as ItemRow[];
  const preview=children.map(row=>row.target_json?JSON.parse(row.target_json).name:row.summary);
  const first=children[0]!;
  return {snapshotVersion:cursor.version,id:group.id,type:group.type,category:group.category,actor:{id:group.actor_id,name:group.actor_name},occurredAt:group.occurred_at,lastOccurredAt:stats.last,count:stats.count,preview,historical:Boolean(group.historical),target:group.target_json?available(db,projectId,JSON.parse(group.target_json)):stats.count===1?available(db,projectId,first.target_json?JSON.parse(first.target_json):null):null,summary:group.summary?`${group.summary}（${stats.count} 项）`:stats.count>1?(group.type==='task.complete'?`完成了 ${stats.count} 项任务`:`${first.summary}（共 ${stats.count} 项）`):first.summary,itemsCursor:encode(db,{...cursor,beforeTime:undefined,beforeSeq:undefined,group:group.id,afterSeq:0})};
 });
 const last=rows[limit-1];return {items,nextCursor:rows.length>limit&&last?encode(db,{...cursor,beforeTime:last.occurred_at,beforeSeq:last.first_seq}):null,activityVersion:activityVersion(db,projectId,canViewManagement),backfill:activityBackfill(db,projectId)};
}
export function readActivityItems(db:Database.Database,projectId:string,activityId:string,query:Record<string,unknown>,now=new Date(),canViewManagement=true):ActivityItemsPage {
 const limit=pageLimit(query.limit),cursor=baseCursor(db,projectId,query,now,activityId,canViewManagement);
 if(!db.prepare(`SELECT 1 FROM activity_groups g WHERE id=? AND project_id=? AND first_seq<=? AND ${canViewManagement?'1':publicActivitySql()}`).get(activityId,projectId,cursor.highwater))throw new PlanError(404,'ACTIVITY_NOT_FOUND','未找到此项目动态，请刷新列表。');
 const rows=db.prepare('SELECT * FROM activity_items WHERE group_id=? AND seq<=? AND seq>? AND occurred_at>=? AND occurred_at<=? ORDER BY seq LIMIT ?').all(activityId,cursor.highwater,cursor.afterSeq??0,cursor.lower,cursor.upper,limit+1) as ItemRow[];
 return {items:rows.slice(0,limit).map(row=>item(db,projectId,row)),nextCursor:rows.length>limit?encode(db,{...cursor,afterSeq:rows[limit-1]!.seq}):null,activityVersion:activityVersion(db,projectId,canViewManagement),backfill:activityBackfill(db,projectId)};
}
/** One durable batch per runner turn; reads never trigger historical scans. */
export function advanceActivityBackfill(db:Database.Database,now=new Date()) {
 if(!hasTable(db,'activity_backfill')||!hasTable(db,'task_meta'))return;
 const state=db.prepare('SELECT * FROM activity_backfill WHERE id=1').get() as BackfillRow;
 if(state.status==='complete'||(state.retry_at&&state.retry_at>now.toISOString()))return;
 try {db.transaction(()=>{
  const rows=db.prepare('SELECT m.rowid AS row_id,m.task_id,m.project_id,m.meta_json,h.title FROM task_meta m LEFT JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.rowid>? ORDER BY m.rowid LIMIT 100').all(state.cursor) as {row_id:number;task_id:string;project_id:string;meta_json:string;title:string|null}[];
  for(const row of rows){const meta=JSON.parse(row.meta_json);if(meta.taskKind==='summary'||meta.isContainer)continue;for(const event of meta.events??[]){if(!['complete','accept'].includes(event.action)||!event.id||!event.createdAt||!Number.isFinite(Date.parse(event.createdAt))||Date.parse(event.createdAt)<Date.parse(state.lower_bound)||Date.parse(event.createdAt)>=Date.parse(state.cutoff))continue;
   recordActivity(db,{projectId:row.project_id,sourceKey:`task-event:${event.id}`,type:event.action==='accept'?'task.accept':'task.complete',category:'task',actor:{id:null,name:typeof event.actor==='string'?event.actor:'历史操作者'},occurredAt:event.createdAt,target:{kind:'task',id:row.task_id,name:row.title??'历史任务'},summary:event.action==='accept'?`验收通过「${row.title??'历史任务'}」`:`完成任务「${row.title??'历史任务'}」`,historical:true});
  }}
  const projectCounts = new Map<string,number>();
  for(const row of rows) projectCounts.set(row.project_id,(projectCounts.get(row.project_id)??0)+1);
  const updateProgress=db.prepare('INSERT INTO activity_backfill_projects(project_id,processed_tasks) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET processed_tasks=processed_tasks+excluded.processed_tasks');
  for(const [projectId,count] of projectCounts) updateProgress.run(projectId,count);
  db.prepare("UPDATE activity_backfill SET status=?,processed_tasks=processed_tasks+?,cursor=?,error=NULL,attempts=0,retry_at=NULL WHERE id=1").run(rows.length<100?'complete':'running',rows.length,rows.at(-1)?.row_id??state.cursor);
  // Status changes also reach clients using the existing project revision poll.
  for(const row of db.prepare('SELECT id FROM homepage_projects').all() as {id:string}[])bump(db,row.id);
 })();}catch{db.prepare("UPDATE activity_backfill SET status='failed',error='历史动态整理失败，后台将自动重试；新动态仍可查看。',attempts=attempts+1,retry_at=? WHERE id=1").run(new Date(now.getTime()+Math.min(15,2**state.attempts)*60000).toISOString());for(const row of db.prepare('SELECT id FROM homepage_projects').all() as {id:string}[])bump(db,row.id);}
}
