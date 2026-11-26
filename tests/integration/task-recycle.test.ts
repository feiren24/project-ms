import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {readSchema} from '../../server/src/db/schema.js';
import {validateExistingDatabase} from '../../server/src/db/existing.js';
import {migrateTaskRecycle} from '../../server/src/modules/tasks/recycle-store.js';
import {captureProjectEvents} from '../../server/src/modules/notifications/events.js';
import {deliverNotification} from '../../server/src/modules/notifications/repository.js';
import {applyRiskEvaluation} from '../../server/src/modules/risks/service.js';
import {listAlerts,saveAlert} from '../../server/src/modules/risks/repository.js';
import {readMilestoneRecords,saveMilestoneRecord} from '../../server/src/modules/milestones/store.js';
import { beforeEach, afterEach, test, expect } from 'vitest';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import {buildApp as buildRealApp} from '../../server/src/app.js';
import {createInitialAdmin,issueSession,COOKIE_NAME} from '../../server/src/modules/auth/store.js';

let app: ReturnType<typeof buildLegacyApp>, directory: string, dbPath: string;
const base = '/api/v1/projects/phase-one/tasks';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'task-recycle-')); dbPath = join(directory, 'test.sqlite'); app = buildLegacyApp({dbPath,jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0}); });
afterEach(async () => { await app.close(); await rm(directory,{recursive:true,force:true}); });
async function workspace() { return (await app.inject(base)).json().data; }
async function post(path: string, payload: object = {}, actor = 'chen', key = randomUUID()) {
  const w = await workspace();
  return app.inject({method:'POST',url:base+path,headers:{'x-demo-actor':actor,'x-preview-token':w.writeToken,'idempotency-key':key},payload});
}
async function create(actor = 'chen') {
  const w = await workspace();
  const r = await post('',{title:'回收站测试任务',description:'虚构任务',workstreamId:w.workstreams[0].id,parentId:null,ownerId:'lin',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion},actor);
  expect(r.statusCode,r.body).toBe(200); return r.json().data.task;
}
async function preview(id: string, restore=false, actor='chen') {
  const r=await post(restore?`/deleted/${id}/restore-preview`:`/${id}/delete-preview`,{},actor);
  expect(r.statusCode,r.body).toBe(200);return r.json().data;
}
async function remove(id:string,actor='chen') { const p=await preview(id,false,actor);return post(`/${id}/delete`,{previewToken:p.previewToken,reason:'重复创建'},actor); }

test('creator deletes with required reason; current projections disappear and manager restores original task',async()=>{
  const task=await create();expect(task.creatorId).toBe('chen');
  const p=await preview(task.id);expect(p.blockers).toEqual([]);
  expect((await post(`/${task.id}/delete`,{previewToken:p.previewToken,reason:'  '})).statusCode).toBe(422);
  const deleted=await remove(task.id);expect(deleted.statusCode,deleted.body).toBe(200);
  expect((await workspace()).tasks.some((t:any)=>t.id===task.id)).toBe(false);
  const plan=(await app.inject('/api/v1/projects/phase-one/gantt')).json().data;
  expect(plan.nodes.some((t:any)=>t.id===task.id)).toBe(false);
  const record=await app.inject({url:`${base}/deleted/${task.id}`,headers:{'x-demo-actor':'chen'}});
  expect(record.statusCode,record.body).toBe(200);expect(record.json().data.task.title).toBe(task.title);
  expect((await post(`/deleted/${task.id}/restore-preview`)).statusCode).toBe(403);
  const restore=await preview(task.id,true,'zhou');
  const result=await post(`/deleted/${task.id}/restore`,{previewToken:restore.previewToken,reason:'误删恢复'},'zhou');
  expect(result.statusCode,result.body).toBe(200);
  expect((await workspace()).tasks.find((t:any)=>t.id===task.id)).toMatchObject({id:task.id,wbs:task.wbs,creatorId:'chen',ownerId:'lin',status:'todo'});
});

test('owner cannot delete another creator task; read-only creator loses delete permission and legacy creator is unknown',async()=>{
  const task=await create();expect((await post(`/${task.id}/delete-preview`,{},'lin')).statusCode).toBe(403);
  expect((await post('/task-001/delete-preview')).statusCode).toBe(403);
  const db=new Database(dbPath);db.prepare("UPDATE project_members SET role='viewer' WHERE id='chen'").run();db.close();
  expect((await post(`/${task.id}/delete-preview`)).statusCode).toBe(403);
});

test('dependencies block deletion and a new dependency invalidates an earlier preview',async()=>{
  const task=await create(),other=await create();const p=await preview(task.id);
  const db=new Database(dbPath);const row=db.prepare('SELECT dependencies_json FROM plan_projects WHERE project_id=?').get('phase-one') as any;
  db.prepare('UPDATE plan_projects SET dependencies_json=? WHERE project_id=?').run(JSON.stringify([...JSON.parse(row.dependencies_json),{predecessorId:task.id,successorId:other.id,type:'FS',lagDays:0}]),'phase-one');db.close();
  expect((await post(`/${task.id}/delete`,{previewToken:p.previewToken,reason:'重复任务'})).statusCode).toBe(409);
  expect((await preview(task.id)).blockers.some((b:any)=>b.kind==='dependency')).toBe(true);
});

test('recycle list is scoped to creator and delete replay is durable without duplicating history',async()=>{
  const task=await create(),p=await preview(task.id),key=randomUUID();const body={previewToken:p.previewToken,reason:'重复任务'};
  const first=await post(`/${task.id}/delete`,body,'chen',key);expect(first.statusCode,first.body).toBe(200);
  await app.close();app=buildLegacyApp({dbPath});
  expect((await post(`/${task.id}/delete`,body,'chen',key)).json()).toEqual(first.json());
  const list=(actor:string)=>app.inject({url:base+'/deleted',headers:{'x-demo-actor':actor}});
  expect((await list('chen')).json().data.total).toBe(1);expect((await list('lin')).json().data.total).toBe(0);
  expect((await app.inject({url:`${base}/deleted/${task.id}`,headers:{'x-demo-actor':'lin'}})).statusCode).toBe(403);
});

test('delete and restore notify related active members once, omit actor, and preserve audit',async()=>{
 const task=await create();expect((await remove(task.id)).statusCode).toBe(200);
 const p=await preview(task.id,true,'zhou');expect((await post(`/deleted/${task.id}/restore`,{previewToken:p.previewToken,reason:'误删恢复'},'zhou')).statusCode).toBe(200);
 const db=new Database(dbPath);captureProjectEvents(db,'phase-one',new Date());captureProjectEvents(db,'phase-one',new Date());
 const payloads=(db.prepare("SELECT payload_json FROM background_jobs WHERE kind='notification'").all() as any[]).map(r=>JSON.parse(r.payload_json)).filter(p=>['task.delete','task.restore'].includes(p.kind));
 expect(payloads.filter(p=>p.kind==='task.delete').map(p=>p.recipientId).sort()).toEqual(['lin','zhou']);
 expect(payloads.filter(p=>p.kind==='task.restore').map(p=>p.recipientId).sort()).toEqual(['chen','lin']);
 expect(db.prepare("SELECT count(*) n FROM activity_groups WHERE type IN ('task.delete','task.restore')").get()).toEqual({n:2});db.close();
});

test('deleted task pending reminders skip delivery and historical baseline/snapshot bytes survive',async()=>{
 const task=await create();const db=new Database(dbPath);
 const before=db.prepare('SELECT snapshot_json FROM plan_baselines ORDER BY id').all();
 const snapshots=db.prepare('SELECT snapshot_json FROM analytics_daily_snapshots').all();
 expect((await remove(task.id)).statusCode).toBe(200);
 expect(deliverNotification(db,'phase-one',{recipientId:'lin',eventKey:'old-reminder',kind:'task.review_reminder',title:'验收提醒',message:'等待验收',target:{kind:'task',id:task.id}},new Date()).delivered).toBe(false);
 expect(db.prepare('SELECT snapshot_json FROM plan_baselines ORDER BY id').all()).toEqual(before);expect(db.prepare('SELECT snapshot_json FROM analytics_daily_snapshots').all()).toEqual(snapshots);db.close();
});

test('milestone and risk references block deletion, including cancelled child history',async()=>{
 const task=await create();const db=new Database(dbPath);const m=readMilestoneRecords(db,'phase-one')[0]!;
 saveMilestoneRecord(db,'phase-one',{...m,criteria:[{id:'test-criterion',kind:'task',title:'必要交付',taskId:task.id}]});
 expect((await preview(task.id)).blockers.some((b:any)=>b.kind==='milestone')).toBe(true);
 saveMilestoneRecord(db,'phase-one',m);const r=db.prepare('SELECT id,snapshot_json FROM risk_records LIMIT 1').get() as any;const risk=JSON.parse(r.snapshot_json);
 db.prepare('UPDATE risk_records SET snapshot_json=? WHERE id=?').run(JSON.stringify({...risk,actionTaskIds:[task.id]}),r.id);
 expect((await preview(task.id)).blockers.some((b:any)=>b.kind==='risk')).toBe(true);
 db.prepare('UPDATE risk_records SET snapshot_json=? WHERE id=?').run(r.snapshot_json,r.id);db.close();
 const w=await workspace();const response=await post('',{title:'二级任务',description:'',workstreamId:task.workstreamId,parentId:task.id,ownerId:'lin',priority:'P1',effortHours:1,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion,confirmParentConversion:true,expectedParentVersion:task.version},'zhou');
 expect(response.statusCode,response.body).toBe(200);const parent=response.json().data.parentTask;
 expect((await preview(parent.id,false,'zhou')).blockers.some((b:any)=>b.kind==='child')).toBe(true);
});

test('all states retain exact execution and acceptance data on restore; WBS is not reused',async()=>{
 for(const state of ['todo','in_progress','submitted','done','cancelled']){
  const t=await create();const db=new Database(dbPath);
  const row=db.prepare('SELECT meta_json FROM task_meta WHERE task_id=?').get(t.id) as any;const meta=JSON.parse(row.meta_json);
  Object.assign(meta,{cancelled:state==='cancelled',reviewStatus:state==='submitted'?'submitted':state==='done'?'accepted':'none',requiresReview:state==='submitted'||state==='done',reviewerId:state==='submitted'||state==='done'?'zhou':null,evidence:'保留的交付成果',actualEnd:state==='done'?'2026-09-10':null});
  db.prepare('UPDATE task_meta SET meta_json=? WHERE task_id=?').run(JSON.stringify(meta),t.id);
  db.prepare('UPDATE homepage_tasks SET status=?,progress=? WHERE id=?').run(state==='done'?'done':state==='todo'||state==='cancelled'?'todo':'in_progress',state==='done'?100:state==='todo'||state==='cancelled'?0:70,t.id);db.close();
  const p=await preview(t.id);expect((await post(`/${t.id}/delete`,{previewToken:p.previewToken,reason:'重复任务'})).statusCode).toBe(200);
  const other=await create();expect(other.wbs).not.toBe(t.wbs);
  const rp=await preview(t.id,true,'zhou');expect(rp.blockers).toEqual([]);
  expect((await post(`/deleted/${t.id}/restore`,{previewToken:rp.previewToken,reason:'误删恢复'},'zhou')).statusCode).toBe(200);
  const actual=(await workspace()).tasks.find((x:any)=>x.id===t.id);
  for(const field of ['id','wbs','status','progress','actualStart','actualEnd','evidence','reviewStatus','submissions','creatorId'])expect(actual[field]).toEqual(p.task[field]);
 }
});

test('restoration requires original member and parent; late storage failure rolls back removal atomically',async()=>{
 const task=await create(),p=await preview(task.id),db=new Database(dbPath);
 db.exec("CREATE TRIGGER fail_recycle BEFORE INSERT ON task_recycle_receipts BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;");
 const w=await workspace();expect((await post(`/${task.id}/delete`,{previewToken:p.previewToken,reason:'删除测试'})).statusCode).toBe(500);expect(await workspace()).toEqual(w);
 expect(db.prepare('SELECT count(*) n FROM task_recycle').get()).toEqual({n:0});db.exec('DROP TRIGGER fail_recycle');
 expect((await remove(task.id)).statusCode).toBe(200);
 db.prepare("UPDATE project_members SET active=0 WHERE id='lin'").run();expect((await preview(task.id,true,'zhou')).blockers.some((b:any)=>b.kind==='member')).toBe(true);
 db.prepare("UPDATE project_members SET active=1 WHERE id='lin'").run();expect((await preview(task.id,true,'zhou')).blockers).toEqual([]);db.close();
});

test('existing-only startup requires explicit idempotent recycle migration and preserves business bytes',async()=>{
 await create();await app.close();const real=buildRealApp({dbPath});await real.close();const db=new Database(dbPath);const before=db.prepare('SELECT meta_json FROM task_meta ORDER BY task_id').all();
 db.exec('DROP TABLE task_recycle;DROP TABLE task_recycle_receipts;DROP TABLE task_recycle_schema_migrations;');
 expect(()=>validateExistingDatabase(db)).toThrow();validateExistingDatabase(db,true);migrateTaskRecycle(db);migrateTaskRecycle(db);validateExistingDatabase(db);
 expect(readSchema(db).migrations.task_recycle_schema_migrations).toEqual([1]);expect(db.prepare('SELECT meta_json FROM task_meta ORDER BY task_id').all()).toEqual(before);db.close();
 app=buildLegacyApp({dbPath,databaseMode:'existing-only'});expect((await workspace()).tasks).toHaveLength(49);
});

test('preview reads never modify snapshots, task history or business audit',async()=>{
 const t=await create(),db=new Database(dbPath);const state=()=>['task_meta','plan_projects','analytics_daily_snapshots','activity_groups','task_recycle','task_recycle_receipts'].map(table=>db.prepare(`SELECT * FROM ${table}`).all());
 const before=state();await preview(t.id);await preview(t.id);expect(state()).toEqual(before);db.close();
});

test('real session overrides spoofed actor; global administration alone grants no deletion power',async()=>{
 const t=await create();await app.close();app=buildRealApp({dbPath,jobIntervalMs:0,riskIntervalMs:0,snapshotIntervalMs:0});const db=new Database(dbPath);
 const user=await createInitialAdmin(db,{username:'recycleadmin',name:'回收测试管理员',password:'Recycle-Test-123456!'});const session=issueSession(db,user,new Date());
 const headers={cookie:`${COOKIE_NAME}=${session.token}`,'x-csrf-token':session.record.csrfToken,'x-demo-actor':'zhou'};
 expect((await app.inject({method:'POST',url:`${base}/${t.id}/delete-preview`,headers,payload:{}})).statusCode).toBe(403);
 db.prepare('INSERT INTO project_user_links(project_id,user_id,member_id) VALUES(?,?,?)').run('phase-one',user.id,'zhou');
 expect((await app.inject({method:'POST',url:`${base}/${t.id}/delete-preview`,headers,payload:{}})).statusCode).toBe(200);db.close();
});

test('baseline deviation retains deleted task identity and current metrics exclude it',async()=>{
 const task=await create(),db=new Database(dbPath);const plan=(await app.inject('/api/v1/projects/phase-one/gantt')).json().data;
 const baseline={id:'recycle-baseline',name:'删除前承诺',createdAt:new Date().toISOString(),actor:'测试',reason:'隔离验收',entries:[{taskId:task.id,start:plan.project.start,end:plan.project.end,effortHours:8,owner:task.owner}],dependencies:[],calendar:plan.calendar,excludedIds:[]};
 db.prepare('INSERT INTO plan_baselines VALUES(?,?,?,?)').run(baseline.id,'phase-one',JSON.stringify(baseline),baseline.createdAt);
 expect((await remove(task.id)).statusCode).toBe(200);
 const report=(await app.inject('/api/v1/projects/phase-one/analytics?baselineId=recycle-baseline')).json().data;
 expect(report.tasks.some((t:any)=>t.id===task.id)).toBe(false);expect(report.deviations.find((d:any)=>d.taskId===task.id)).toMatchObject({title:task.title,state:'deleted'});
 expect(JSON.parse((db.prepare('SELECT snapshot_json FROM plan_baselines WHERE id=?').get(baseline.id) as any).snapshot_json)).toEqual(baseline);db.close();
});

test('deleting a source task preserves an unresolved alert until evidence is evaluated after restoration',async()=>{
 const task=await create(),db=new Database(dbPath),original=listAlerts(db,'phase-one')[0]!;
 const alert={...original,id:'recycle-alert',objectId:task.id,taskIds:[task.id],status:'open' as const,events:[],linkedRiskId:null};saveAlert(db,'phase-one',alert);
 expect((await remove(task.id)).statusCode).toBe(200);
 const evaluation={candidates:[],unknown:[],rules:[{key:alert.rule,name:'测试规则',status:'evaluated' as const,message:'当前未命中',triggered:0}]};
 applyRiskEvaluation(db,'phase-one',evaluation,new Date());
 expect(listAlerts(db,'phase-one').find(a=>a.id===alert.id)).toMatchObject({status:'open',sourceDeleted:true});
 const rp=await preview(task.id,true,'zhou');expect((await post(`/deleted/${task.id}/restore`,{previewToken:rp.previewToken,reason:'恢复核对'},'zhou')).statusCode).toBe(200);
 expect(listAlerts(db,'phase-one').find(a=>a.id===alert.id)?.sourceDeleted).toBeUndefined();
 applyRiskEvaluation(db,'phase-one',evaluation,new Date());expect(listAlerts(db,'phase-one').find(a=>a.id===alert.id)?.status).toBe('resolved');db.close();
});

test('deleted parent blocks child restoration; restoring original hierarchy preserves summary kind',async()=>{
 const task=await create(),w=await workspace();
 const response=await post('',{title:'层级恢复子任务',description:'',workstreamId:task.workstreamId,parentId:task.id,ownerId:'lin',priority:'P1',effortHours:1,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion,confirmParentConversion:true,expectedParentVersion:task.version},'zhou');
 expect(response.statusCode,response.body).toBe(200);const parent=response.json().data.parentTask,child=response.json().data.task;
 expect((await remove(child.id,'zhou')).statusCode).toBe(200);expect((await remove(task.id,'zhou')).statusCode).toBe(200);expect((await remove(parent.id,'zhou')).statusCode).toBe(200);
 expect((await preview(child.id,true,'zhou')).blockers).toEqual(expect.arrayContaining([expect.objectContaining({kind:'parent',id:parent.id})]));
 const rp=await preview(parent.id,true,'zhou');expect((await post(`/deleted/${parent.id}/restore`,{previewToken:rp.previewToken,reason:'恢复原层级'},'zhou')).statusCode).toBe(200);
 expect((await workspace()).tasks.find((t:any)=>t.id===parent.id).taskKind).toBe('summary');expect((await preview(child.id,true,'zhou')).blockers).toEqual([]);
});
