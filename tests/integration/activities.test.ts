import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeActivities, recordActivity, readActivities, readActivityItems, advanceActivityBackfill } from '../../server/src/modules/activities/repository.js';
function fixture() { const db = new Database(':memory:'); db.exec(`CREATE TABLE homepage_projects(id TEXT PRIMARY KEY,snapshot_json TEXT); INSERT INTO homepage_projects VALUES('p','{}'); CREATE TABLE task_meta(task_id TEXT PRIMARY KEY,project_id TEXT,meta_json TEXT); CREATE TABLE homepage_tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT);`); initializeActivities(db,new Date('2026-09-08T02:00:00Z')); return db; }
function add(db: Database.Database,id: string,time='2026-09-08T02:00:00Z',actorId:string|null='actor') { return recordActivity(db,{ projectId:'p',sourceKey:id,type:'task.complete',category:'task',actor:{id:actorId,name:'张三'},occurredAt:time,target:{kind:'task',id,name:id},summary:`完成任务「${id}」`,groupable:true }); }
const now = new Date('2026-09-08T03:00:00Z');
describe('selected activities storage',()=>{
 it('groups by fixed first-event ten minutes, stable identity and Shanghai day, never duplicate target',()=>{const db=fixture(); add(db,'a');add(db,'b','2026-09-08T02:09:00Z');add(db,'c','2026-09-08T02:11:00Z'); expect(readActivities(db,'p',{range:'all'},now).items.map(x=>x.count)).toEqual([1,2]); add(db,'d','2026-09-08T15:59:00Z');add(db,'e','2026-09-08T16:01:00Z');add(db,'legacy1','2026-09-08T02:01:00Z',null);add(db,'legacy2','2026-09-08T02:02:00Z',null);expect(readActivities(db,'p',{range:'all'},new Date('2026-09-09')).items).toHaveLength(6);db.close();});
 it('deduplicates sources and rolls activity back with its business transaction',()=>{const db=fixture();add(db,'a');add(db,'a');expect(readActivities(db,'p',{},now).items[0]?.count).toBe(1);expect(()=>db.transaction(()=>{add(db,'b');throw Error('rollback');})()).toThrow();expect(readActivities(db,'p',{},now).items[0]?.count).toBe(1);db.close();});
 it('binds filters, project, highwater and detail counts through merges',()=>{const db=fixture();add(db,'a');add(db,'b','2026-09-08T02:11:00Z');let page=readActivities(db,'p',{limit:'1',range:'all'},now);add(db,'c','2026-09-08T02:12:00Z');expect(readActivityItems(db,'p',page.items[0]!.id,{cursor:page.items[0]!.itemsCursor},now).items).toHaveLength(1);expect(readActivities(db,'p',{limit:'1',range:'all',cursor:page.nextCursor!},now).items[0]?.preview).toEqual(['a']);expect(()=>readActivities(db,'p',{category:'risk',range:'all',cursor:page.nextCursor!},now)).toThrow();db.close();});
 it('backfills only explicit recent completion events with a durable fixed cutoff',()=>{const db=fixture();db.prepare('INSERT INTO task_meta VALUES(?,?,?)').run('a','p',JSON.stringify({events:[{id:'old',action:'complete',actor:'张三',createdAt:'2026-08-01T00:00:00Z'},{id:'recent',action:'complete',actor:'张三',createdAt:'2026-09-08T01:00:00Z'},{id:'noise',action:'progress',createdAt:'2026-09-08T01:01:00Z'}]}));db.prepare('INSERT INTO homepage_tasks VALUES(?,?,?)').run('a','p','真实标题');advanceActivityBackfill(db,now);const page=readActivities(db,'p',{range:'all'},now);expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({historical:true,actor:{id:null,name:'张三'},preview:['真实标题']});advanceActivityBackfill(db,new Date('2026-10-01'));expect(readActivities(db,'p',{range:'all'},new Date('2026-10-01')).items).toHaveLength(1);db.close();});
});

import { captureTaskActivity, captureRiskActivity } from '../../server/src/modules/activities/hooks.js';
import type { ManagedTask } from '../../shared/src/tasks.js';
import type { ManagedRisk } from '../../shared/src/risks.js';
const actor = {id:'actor',name:'实名用户'};
function task(extra:Partial<ManagedTask>={}):ManagedTask {return {id:'task',title:'交付成果',taskKind:'execution',requiresReview:false,status:'in_progress',reviewStatus:'none',ownerId:'old',owner:'原负责人',blocked:false,events:[],...extra} as ManagedTask;}
function afterTask(before:ManagedTask,action:string,extra:Partial<ManagedTask>={}):ManagedTask {return {...before,...extra,events:[...before.events,{id:`event-${Math.random()}`,taskId:before.id,action,actor:actor.name,text:'不应复制的完整审计内容',createdAt:now.toISOString()}]};}
describe('activity business selection and snapshots',()=>{
 it('emits ordinary completion and three key review actions independently, accept only once',()=>{const db=fixture();const before=task();const done=afterTask(before,'complete',{status:'done'});captureTaskActivity(db,'p',actor,[before],[done],'transition');captureTaskActivity(db,'p',actor,[before],[done],'transition');let key=task({id:'key',requiresReview:true});for(const action of ['submit','reject','submit','accept']){const next=afterTask(key,action,{reviewStatus:action==='submit'?'submitted':action==='reject'?'rejected':'accepted',status:action==='accept'?'done':'in_progress'});captureTaskActivity(db,'p',actor,[key],[next],'transition');key=next;}const rows=readActivities(db,'p',{range:'all'},now).items;expect(rows.map(row=>row.type).sort()).toEqual(['task.accept','task.complete','task.reject','task.submit','task.submit']);expect(JSON.stringify(rows)).not.toContain('完整审计');db.close();});
 it('suppresses noops, noise and derived summaries, keeps key owner and actual blocker transitions',()=>{const db=fixture(),before=task();for(const action of ['create','start','progress','comment','block','unblock','update'])captureTaskActivity(db,'p',actor,[before],[afterTask(before,action)],action==='update'?'update':'transition');const summary=task({taskKind:'summary'});captureTaskActivity(db,'p',actor,[summary],[afterTask(summary,'complete',{status:'done'})],'transition');expect(readActivities(db,'p',{},now).items).toHaveLength(0);const blocked=afterTask(before,'block',{blocked:true});captureTaskActivity(db,'p',actor,[before],[blocked],'transition');const key=task({requiresReview:true});captureTaskActivity(db,'p',actor,[key],[afterTask(key,'update',{ownerId:'new',owner:'新负责人'})],'update');expect(readActivities(db,'p',{},now).items.map(row=>row.type).sort()).toEqual(['task.block','task.owner']);db.close();});
 it('recompletion of a previously grouped task begins a new group and reopen summarizes affected commitments',()=>{const db=fixture(),before=task();const done=afterTask(before,'complete',{status:'done'});captureTaskActivity(db,'p',actor,[before],[done],'transition');const reopened=afterTask(done,'reopen',{status:'in_progress'});const invalid=afterTask(task({id:'dependent',requiresReview:true}),'needs_review');captureTaskActivity(db,'p',actor,[done],[reopened,invalid],'transition',['发布里程碑']);captureTaskActivity(db,'p',actor,[reopened],[afterTask(reopened,'complete',{status:'done'})],'transition');const rows=readActivities(db,'p',{},now).items;expect(rows.filter(row=>row.type==='task.complete')).toHaveLength(2);const row=rows.find(row=>row.type==='task.reopen')!;expect(readActivityItems(db,'p',row.id,{cursor:row.itemsCursor},now).items[0]?.changes.find(x=>x.field==='invalidatedTargets')?.after).toContain('发布里程碑');db.close();});
 it('important risk selection uses before and after importance; occurrence always visible',()=>{const db=fixture();let seq=0;const risk=(level:ManagedRisk['level'],extra:Partial<ManagedRisk>={}):ManagedRisk=>({id:'risk',title:'交付风险',level,status:'identified',occurred:false,events:[{id:`risk-${seq++}`,action:'create',actor:actor.name,text:'隐私正文',createdAt:now.toISOString()}],...extra} as ManagedRisk);captureRiskActivity(db,'p',actor,undefined,risk('low'),'create');captureRiskActivity(db,'p',actor,undefined,risk('high'),'create');const high=risk('high');captureRiskActivity(db,'p',actor,high,risk('low',{events:[{...high.events[0]!,id:`risk-${seq++}`,action:'update'}]}),'update');const low=risk('low');captureRiskActivity(db,'p',actor,low,risk('low',{occurred:true,events:[{...low.events[0]!,id:`risk-${seq++}`,action:'occur'}]}),'transition');expect(readActivities(db,'p',{category:'risk'},now).items.map(x=>x.type).sort()).toEqual(['risk.create','risk.occur','risk.update']);db.close();});
 it('range-filtered aggregates include only matching children, cursor survives later inserts and rejects tampering',()=>{const db=fixture();add(db,'a','2026-09-01T02:59:00Z');add(db,'b','2026-09-01T03:01:00Z');const page=readActivities(db,'p',{},now);expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({count:1,preview:['b']});const cursor=page.items[0]!.itemsCursor;expect(readActivityItems(db,'p',page.items[0]!.id,{cursor},now).items).toHaveLength(1);expect(()=>readActivityItems(db,'p',page.items[0]!.id,{cursor:cursor+'x'},now)).toThrow();db.close();});
 it('backfill resumes batches, excludes cut-off/future/summary logs, exposes failure and retries without losing live events',()=>{const db=fixture();const insert=db.prepare('INSERT INTO task_meta VALUES(?,?,?)');for(let i=0;i<101;i++)insert.run('row'+i,'p',JSON.stringify({events:[{id:'past'+i,action:'complete',actor:'历史人',createdAt:'2026-09-08T01:00:00Z'},{id:'cutoff'+i,action:'complete',actor:'历史人',createdAt:'2026-09-08T02:00:00Z'}]}));insert.run('summary','p',JSON.stringify({taskKind:'summary',events:[{id:'summary',action:'complete',createdAt:'2026-09-08T01:00:00Z'}]}));db.exec("CREATE TRIGGER fail_backfill BEFORE INSERT ON activity_items WHEN NEW.historical=1 BEGIN SELECT RAISE(ABORT,'failure');END");advanceActivityBackfill(db,now);expect(readActivities(db,'p',{},now).backfill.status).toBe('failed');add(db,'live');db.exec('DROP TRIGGER fail_backfill');advanceActivityBackfill(db,new Date(now.getTime()+61000));expect(readActivities(db,'p',{},now).backfill).toMatchObject({status:'running',processedTasks:100});initializeActivities(db,new Date('2026-10-01'));advanceActivityBackfill(db,new Date(now.getTime()+62000));expect(readActivities(db,'p',{},now).backfill).toMatchObject({status:'complete',processedTasks:102});expect((db.prepare('SELECT COUNT(*) AS count FROM activity_items').get() as {count:number}).count).toBe(102);db.close();});
});

import { openHomepageDatabase } from '../../server/src/db/connection.js';
import { initializePlanning, readPlan, previewSchedule, applySchedule, publishBaseline } from '../../server/src/modules/planning/repository.js';
import { initializeSettings } from '../../server/src/modules/settings/store.js';
import { readSettings, writeSettings } from '../../server/src/modules/settings/repository.js';
import { initializeTasks, readTasks, writeTask } from '../../server/src/modules/tasks/repository.js';
import { initializeWorkstreams, readWorkstreams, writeWorkstream } from '../../server/src/modules/workstreams/repository.js';
import { initializeRisks } from '../../server/src/modules/risks/repository.js';
import { configureMilestoneBaselineFixture } from '../helpers/milestone-fixtures.js';
import { readMilestoneRecords, readMilestoneTaskFacts, saveMilestoneRecord } from '../../server/src/modules/milestones/store.js';
function businessFixture() {const db=openHomepageDatabase(':memory:');initializePlanning(db);initializeSettings(db);initializeTasks(db);initializeWorkstreams(db);configureMilestoneBaselineFixture(db,now);initializeRisks(db);initializeActivities(db,now);return db;}
describe('activity hooks in real business transactions',()=>{
 it('task mutation receipts dedupe, completion activity rolls back when the final business receipt fails',()=>{const db=businessFixture(),p='phase-one';let w=readTasks(db,p,'',now);const created=writeTask(db,p,'create',undefined,{expectedPlanVersion:w.planVersion,title:'实际执行',description:'',workstreamId:w.workstreams[0]!.id,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:null,end:null},'zhou','create-real',now).task as ManagedTask;expect(readActivities(db,p,{},now).items).toHaveLength(0);w=readTasks(db,p,'',now);const body={expectedVersion:created.version,expectedPlanVersion:w.planVersion,action:'complete'};db.exec("CREATE TRIGGER final_receipt_failure BEFORE INSERT ON task_idempotency WHEN NEW.request_key='complete-fail' BEGIN SELECT RAISE(ABORT,'test rollback');END");expect(()=>writeTask(db,p,'transition',created.id,body,'chen','complete-fail',now)).toThrow();expect(readActivities(db,p,{},now).items).toHaveLength(0);expect(readTasks(db,p,'',now).tasks.find(x=>x.id===created.id)?.status).toBe('todo');writeTask(db,p,'transition',created.id,body,'chen','complete-real',now);writeTask(db,p,'transition',created.id,body,'chen','complete-real',now);expect(readActivities(db,p,{},now).items).toMatchObject([{type:'task.complete',actor:{id:'chen',name:'陈知远'}}]);db.close();});
 it('calendar/member/workgroup root operations emit once, noops/text/order/capacity remain silent',()=>{const db=businessFixture(),p='phase-one';let n=0;const setting=(op:Parameters<typeof writeSettings>[2],extra:object)=>{const w=readSettings(db,p,'');return writeSettings(db,p,op,{expectedVersion:w.version,expectedPlanVersion:w.planVersion,reason:'已核对',...extra},'zhou','settings-'+n++,now);};const before=readSettings(db,p,'');setting('calendar',{calendar:before.calendar});setting('capacity',{capacity:{memberId:'chen',hoursPerDay:8,exceptions:{}}});expect(readActivities(db,p,{},now).items).toHaveLength(0);setting('calendar',{calendar:{...before.calendar,hoursPerDay:7}});const result=setting('member_create',{member:{name:'新成员',role:'member',active:true}});const member=result.members.find(x=>x.name==='新成员')!;setting('member_update',{member:{id:member.id,name:member.name,role:member.role,active:true}});setting('member_update',{member:{id:member.id,name:member.name,role:member.role,active:false}});let groups=readWorkstreams(db,p,'','zhou');let saved=writeWorkstream(db,p,'create',undefined,{expectedVersion:groups.version,expectedPlanVersion:groups.planVersion,workstream:{name:'新增分组',description:'',ownerId:null,color:'blue'}},'zhou','group-create',now,'');const group=saved.workstreams.find(x=>x.name==='新增分组')!;saved=writeWorkstream(db,p,'update',group.id,{expectedVersion:saved.version,expectedPlanVersion:saved.planVersion,workstream:{name:'改名分组',description:'只改文案',ownerId:null,color:'blue'}},'zhou','group-text',now,'');writeWorkstream(db,p,'update',group.id,{expectedVersion:saved.version,expectedPlanVersion:saved.planVersion,workstream:{name:'改名分组',description:'只改文案',ownerId:'chen',color:'blue'}},'zhou','group-owner',now,'');expect(readActivities(db,p,{},now).items.map(x=>x.type).sort()).toEqual(['member.join','member.update','project.calendar','workgroup.create','workgroup.update']);db.close();});
 it('plan previews do not emit, actual schedule batches once and baseline receipts do not duplicate',()=>{const db=businessFixture(),p='phase-one';let plan=readPlan(db,p,'',now);const preview=previewSchedule(db,p,{expectedPlanVersion:plan.planVersion,reason:'调整',changes:[{taskId:'task-006',start:'2026-10-01',end:'2026-10-05'}],mode:'push_successors'},now);expect(readActivities(db,p,{},now).items).toHaveLength(0);const request={previewId:preview.id,expectedPlanVersion:preview.basePlanVersion};applySchedule(db,p,request,'schedule-real',now,'周亦安','zhou');applySchedule(db,p,request,'schedule-real',now,'周亦安','zhou');let feed=readActivities(db,p,{},now);expect(feed.items).toHaveLength(1);expect(feed.items[0]).toMatchObject({type:'plan.schedule',actor:{id:'zhou'}});expect(feed.items[0]!.count).toBeGreaterThan(1);plan=readPlan(db,p,'',now);const body={expectedPlanVersion:plan.planVersion,name:'正式基线',reason:'已核对',calendarConfirmed:true,excludedIds:['gap-operations'],exclusionReason:'后续确认'};publishBaseline(db,p,body,now,'周亦安','zhou');publishBaseline(db,p,body,now,'周亦安','zhou');feed=readActivities(db,p,{},now);expect(feed.items.filter(x=>x.type==='plan.baseline')).toHaveLength(1);db.close();});
});

it('every reopened completion begins a new group even after another task or actor completes',()=>{const db=fixture();let a=task({id:'a'}),b=task({id:'b'});const complete=(prior:ManagedTask,who=actor)=>{const next=afterTask(prior,'complete',{status:'done'});captureTaskActivity(db,'p',who,[prior],[next],'transition');return next;};const reopen=(prior:ManagedTask)=>afterTask(prior,'reopen',{status:'in_progress'});a=complete(a);b=complete(b);b=complete(reopen(b));a=complete(reopen(a));a=complete(reopen(a),{id:'another',name:'另一操作者'});expect(readActivities(db,'p',{},now).items.filter(x=>x.type==='task.complete').map(x=>x.count)).toEqual([1,1,1,2]);db.close();});

it('reports only current-project backfill counts and migrates durable progress once after restart',()=>{
 const db=fixture();db.prepare('INSERT INTO homepage_projects VALUES(?,?)').run('other','{}');
 const insert=db.prepare('INSERT INTO task_meta VALUES(?,?,?)');
 for(let index=0;index<156;index++)insert.run(`progress-${index}`,index<101?'p':'other','{"events":[]}');
 advanceActivityBackfill(db,now);
 expect(readActivities(db,'p',{},now).backfill.processedTasks).toBe(100);
 expect(readActivities(db,'other',{},now).backfill.processedTasks).toBe(0);
 // Simulate upgrade from the global-count-only schema after a committed first batch.
 db.exec('DROP TABLE activity_backfill_projects');initializeActivities(db,now);
 expect(readActivities(db,'p',{},now).backfill.processedTasks).toBe(100);
 expect(readActivities(db,'other',{},now).backfill.processedTasks).toBe(0);
 advanceActivityBackfill(db,now);initializeActivities(db,now);
 expect(readActivities(db,'p',{},now).backfill).toMatchObject({status:'complete',processedTasks:101});
 expect(readActivities(db,'other',{},now).backfill).toMatchObject({status:'complete',processedTasks:55});
 db.close();
});


import { createJobRunner } from '../../server/src/jobs/runner.js';
import { enqueueJob } from '../../server/src/jobs/store.js';
it('advances bounded history batches during a long job drain with a frozen business clock',async()=>{
 const db=businessFixture();
 for(let index=0;index<200;index++)db.prepare('INSERT INTO task_meta VALUES(?,?,?)').run(`drain-${index}`,'phase-one','{"events":[]}');
 let wall=100000;const seen:number[]=[];
 const wallClock=vi.spyOn(Date,'now').mockImplementation(()=>wall);
 const runner=createJobRunner(db,{clock:()=>now,intervalMs:0,handlers:{notification:()=>{seen.push(readActivities(db,'phase-one',{},now).backfill.processedTasks);wall+=600;}}});
 try {
  for(let index=0;index<5;index++)enqueueJob(db,{projectId:'phase-one',kind:'notification',dedupeKey:`drain-${index}`,payload:{},dueAt:now},now);
  expect((await runner.runDueJobs(now,5)).processed).toBe(5);
  expect(readActivities(db,'phase-one',{},now).backfill).toMatchObject({status:'complete',processedTasks:248});
  expect(seen.slice(0,4)).toEqual([100,100,200,200]);
 } finally {await runner.stop();wallClock.mockRestore();db.close();}
});

it('splits at exactly ten minutes and keeps identical names in different identities/projects separate',()=>{
 const db=fixture();db.prepare('INSERT INTO homepage_projects VALUES(?,?)').run('other','{}');
 const emit=(projectId:string,sourceKey:string,actorId:string,time:string)=>recordActivity(db,{projectId,sourceKey,type:'task.complete',category:'task',actor:{id:actorId,name:'同名成员'},occurredAt:time,target:{kind:'task',id:sourceKey,name:sourceKey},summary:'完成任务',groupable:true});
 emit('p','at-zero','actor-one','2026-09-08T02:00:00.000Z');emit('p','before-ten','actor-one','2026-09-08T02:09:59.999Z');emit('p','exact-ten','actor-one','2026-09-08T02:10:00.000Z');
 emit('p','same-name','actor-two','2026-09-08T02:01:00.000Z');emit('other','same-actor','actor-one','2026-09-08T02:01:00.000Z');
 expect(readActivities(db,'p',{range:'all'},now).items.map(row=>row.count).sort()).toEqual([1,1,2]);expect(readActivities(db,'other',{range:'all'},now).items).toHaveLength(1);db.close();
});


it('execution mutation materializes tasks once while returning complete readback fields; batch skips response materialization',()=>{
 const db=businessFixture(),p='phase-one';
 const before=readTasks(db,p,'',now),task=before.tasks.find(t=>t.taskKind==='execution'&&t.status==='in_progress'&&!t.requiresReview&&!t.blocked&&before.dependencies.filter(e=>e.successorId===t.id).every(e=>before.tasks.find(parent=>parent.id===e.predecessorId)?.status==='done'))!;
 const prepare=db.prepare.bind(db);let materializations=0;
 const spy=vi.spyOn(db,'prepare').mockImplementation(((sql:string)=>{if(sql==='SELECT * FROM task_meta WHERE project_id = ?')materializations++;return prepare(sql);}) as typeof db.prepare);
 try {
  const result=writeTask(db,p,'transition',task.id,{expectedVersion:task.version,expectedPlanVersion:before.planVersion,action:'complete'},'zhou','bounded-complete',now);
  expect(materializations).toBe(1);expect(result.task).toEqual(readTasks(db,p,'',now).tasks.find(t=>t.id===task.id));
  const current=readTasks(db,p,'',now),selected=current.tasks.find(t=>t.taskKind==='execution'&&t.status==='in_progress'&&!t.requiresReview)!;materializations=0;
  const batch=writeTask(db,p,'batch',undefined,{expectedPlanVersion:current.planVersion,items:[{id:selected.id,expectedVersion:selected.version}],patch:{priority:'P2'},reason:'验证批量回读'},'zhou','bounded-batch',now);
  expect(materializations).toBe(1);expect(batch).toEqual({affectedCount:1,planVersion:current.planVersion+1});
 } finally {spy.mockRestore();db.close();}
});


it('task reopen summarizes milestone-criterion and downstream review invalidation once, atomically with parent rollup',()=>{
 const db=businessFixture(),p='phase-one';
 try {
  const initial=readTasks(db,p,'',now);
  const [source,downstream,parent]=initial.tasks.filter(task=>task.taskKind==='execution'&&task.status==='done'&&!task.requiresReview).slice(0,3);
  expect(source).toBeDefined();expect(downstream).toBeDefined();expect(parent).toBeDefined();
  const readMeta=(id:string)=>JSON.parse((db.prepare('SELECT meta_json FROM task_meta WHERE project_id=? AND task_id=?').get(p,id) as {meta_json:string}).meta_json);
  const saveMeta=(id:string,meta:object)=>db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify(meta),p,id);
  saveMeta(source!.id,{...readMeta(source!.id),parentId:parent!.id});
  saveMeta(parent!.id,{...readMeta(parent!.id),taskKind:'summary',isContainer:true});
  const acceptedTaskSubmission={id:'cascade-task-accepted',taskId:downstream!.id,version:downstream!.version,submitterId:'chen',reviewerId:'lin',evidence:'保留已验收成果',status:'accepted',comment:'已核对验收标准',createdAt:now.toISOString(),reviewedAt:now.toISOString()};
  saveMeta(downstream!.id,{...readMeta(downstream!.id),requiresReview:true,ownerId:'chen',reviewerId:'lin',reviewStatus:'accepted',acceptanceCriteria:'核对交付',evidence:'保留已验收成果',submissions:[acceptedTaskSubmission]});
  const milestone=readMilestoneRecords(db,p)[0]!;
  const criteria=[{id:'source-delivery',kind:'task' as const,title:'必要交付成果',taskId:source!.id}];
  const fingerprint=readMilestoneTaskFacts(db,p).get(source!.id)!.fingerprint;
  const submission={id:'cascade-milestone-accepted',submitterId:'zhou',createdAt:now.toISOString(),snapshot:{...milestone,...milestone.delivery,criteria},taskVersions:{[source!.id]:fingerprint},invalidatedAt:null,reviews:[]};
  saveMilestoneRecord(db,p,{...milestone,state:'accepted',acceptedAt:now.toISOString(),criteria,submissions:[submission]});
  // A -> M is a delivery criterion, deliberately not a scheduling edge. This
  // exercises reconciliation's extra cascade beyond the ordinary task traversal.
  db.prepare('UPDATE plan_projects SET dependencies_json=?,version=version+1 WHERE project_id=?').run(JSON.stringify([{predecessorId:milestone.id,successorId:downstream!.id,type:'FS',lagDays:0}]),p);
  const before=readTasks(db,p,'',now),beforeMilestones=readMilestoneRecords(db,p);
  const body={expectedPlanVersion:before.planVersion,expectedVersion:source!.version,action:'reopen',progress:40,reason:'必要成果修订'};
  db.exec("CREATE TRIGGER activity_cascade_receipt_failure BEFORE INSERT ON task_idempotency BEGIN SELECT RAISE(ABORT,'cascade receipt unavailable'); END;");
  expect(()=>writeTask(db,p,'transition',source!.id,body,'zhou','activity-cascade-reopen',now,'实名管理者')).toThrow(/cascade receipt/);
  expect(readTasks(db,p,'',now).tasks).toEqual(before.tasks);
  expect(readMilestoneRecords(db,p)).toEqual(beforeMilestones);
  expect(readActivities(db,p,{},now).items).toEqual([]);
  db.exec('DROP TRIGGER activity_cascade_receipt_failure');
  const result=writeTask(db,p,'transition',source!.id,body,'zhou','activity-cascade-reopen',now,'实名管理者');
  const after=readTasks(db,p,'',now);
  expect(result.task).toEqual(after.tasks.find(task=>task.id===source!.id));
  expect(after.tasks.find(task=>task.id===parent!.id)).toMatchObject({taskKind:'summary',status:'in_progress',progress:40});
  expect(after.tasks.find(task=>task.id===downstream!.id)).toMatchObject({status:'in_progress',reviewStatus:'needs_review'});
  expect(after.tasks.find(task=>task.id===downstream!.id)!.submissions[0]).toEqual(acceptedTaskSubmission);
  const invalidated=readMilestoneRecords(db,p).find(record=>record.id===milestone.id)!;
  expect(invalidated).toMatchObject({state:'needs_review',acceptedAt:null});
  expect(invalidated.submissions[0]!.snapshot).toEqual(submission.snapshot);
  expect(invalidated.submissions[0]!.invalidatedAt).toBe(now.toISOString());
  expect(invalidated.events.at(-1)).toMatchObject({action:'invalidated',actor:'实名管理者'});
  const feed=readActivities(db,p,{},now);
  expect(feed.items).toHaveLength(1);
  expect(feed.items[0]).toMatchObject({type:'task.reopen',actor:{id:'zhou',name:'实名管理者'}});
  const detail=readActivityItems(db,p,feed.items[0]!.id,{cursor:feed.items[0]!.itemsCursor},now);
  const invalidatedNames=detail.items[0]!.changes.find(change=>change.field==='invalidatedTargets')!.after;
  expect(invalidatedNames).toContain(milestone.title);expect(invalidatedNames).toContain(downstream!.title);expect(invalidatedNames).not.toContain(parent!.title);
  expect(writeTask(db,p,'transition',source!.id,body,'zhou','activity-cascade-reopen',now,'实名管理者')).toEqual(result);
  const replayFeed=readActivities(db,p,{},now);
  expect(replayFeed.items.map(({itemsCursor:_cursor,...item})=>item)).toEqual(feed.items.map(({itemsCursor:_cursor,...item})=>item));
  expect(readActivityItems(db,p,replayFeed.items[0]!.id,{cursor:replayFeed.items[0]!.itemsCursor},now).items).toEqual(detail.items);
  expect(readMilestoneRecords(db,p).find(record=>record.id===milestone.id)!.events).toEqual(invalidated.events);
 } finally {db.close();}
});
