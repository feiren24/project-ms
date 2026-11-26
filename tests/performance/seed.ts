/** Isolated, fictional, deterministic performance fixtures. Never accepts an existing DB path. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp } from '../../server/src/app.js';
import { hashPassword } from '../../server/src/modules/auth/passwords.js';
import { addWorkdays, defaultCalendar, isWorkday } from '../../server/src/modules/planning/calendar.js';
import type { PlanNode, PlanDependency, PlanBaseline } from '../../shared/src/planning.js';
import type { ManagedTask } from '../../shared/src/tasks.js';
import { analyticsTask } from '../../server/src/modules/analytics/metrics.js';

export const FIXTURE_NOW = '2026-09-08T04:00:00.000Z';
export const FIXTURE_PASSWORD = 'Fictional-Performance-2026!';
export interface FixtureOptions { tasks: number; dense?: boolean }
export interface FixtureAccount { id: string; memberId: string; username: string; password: string; name: string; role: 'manager'|'project_admin'|'member' }
export interface Fixture { directory: string; dbPath: string; projectId: string; accounts: FixtureAccount[]; counts: Record<string, number>; cleanup: () => Promise<void> }
const pad = (n: number) => String(n).padStart(5, '0');
export const taskId = (i: number) => `perf-task-${pad(i)}`;
export async function createFixture(options: FixtureOptions): Promise<Fixture> {
  assert([1000, 2000, 5000].includes(options.tasks), 'Supported execution task counts: 1000, 2000, 5000');
  const directory = await mkdtemp(join(tmpdir(), 'goodwork-performance-'));
  const dbPath = join(directory, 'fixture.sqlite');
  let db: Database.Database | undefined;
  try {
    const app = buildApp({ dbPath, clock: () => new Date(FIXTURE_NOW), jobIntervalMs: 0, snapshotIntervalMs: 0, riskIntervalMs: 0, secureCookies: false });
    await app.ready(); await app.close();
    db = new Database(dbPath); db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
    const project = db.prepare('SELECT id,snapshot_json FROM homepage_projects LIMIT 1').get() as {id:string;snapshot_json:string};
    const projectId = project.id; const snapshot = JSON.parse(project.snapshot_json);
    const hash = await hashPassword(FIXTURE_PASSWORD);
    const accounts: FixtureAccount[] = Array.from({ length: 20 }, (_, i) => ({ id: `perf-user-${i}`, memberId: `perf-member-${i}`, username: `perf.user.${String(i).padStart(2,'0')}`, password: FIXTURE_PASSWORD, name: `虚构测试成员${String(i+1).padStart(2,'0')}`, role: i === 0 ? 'manager' : i < 3 ? 'project_admin' : 'member' }));
    const streams = accounts.map((a,i) => ({ id:`perf-group-${i}`, name:`DEMO 工作分组 ${i+1}`, description:'虚构性能测试工作分组', owner:a.name, ownerId:a.memberId, color:'blue', start:'2026-08-03', end:addWorkdays('2026-08-03',Math.ceil(options.tasks/100)-1), status:'in_progress', progress:10 }));
    const nodes: PlanNode[] = streams.map((s,i) => ({ id:`group-${s.id}`, parentId:null, workstreamId:s.id,wbs:String(i+1),kind:'group',title:s.name,description:s.description,owner:s.owner,color:s.color,status:'in_progress',start:null,end:null,durationDays:null,effortHours:null,progress:0,blocked:false }));
    const execution: ManagedTask[] = []; const summaries: ManagedTask[] = [];
    const creation = '2026-06-01T04:00:00.000Z';
    for (let i=0;i<options.tasks;i++) {
      const owner=accounts[i%20]!; const group=streams[i%20]!; const layer=Math.floor(i/100);
      const planned=i%10!==9; const date=planned?addWorkdays('2026-08-03',layer):null;
      const done=planned&&layer<5; const started=planned&&layer>=5&&layer<10; const review=i%7===0; const reviewer=accounts[(i%20+1)%20]!;
      const accepted=review&&done;
      const task:ManagedTask={ id:taskId(i),taskKind:'execution',originalWork:false,wbs:`${i%20+1}.${Math.floor(i/20)+1}`,workstreamId:group.id,parentId:i%5===0?`perf-summary-${i%20}`:null,title:`DEMO 执行任务 ${pad(i)}`,description:'虚构任务；仅用于隔离性能测试',ownerId:owner.memberId,owner:owner.name,priority:i%5===0?'P0':i%2===0?'P1':'P2',status:done?'done':started?'in_progress':'todo',progress:done?100:started?40:0,start:date,end:date,effortHours:4,blocked:false,blockReason:'',requiresReview:review,reviewerId:review?reviewer.memberId:null,acceptanceCriteria:review?'DEMO 验收：提交可核验结果并经指定人员确认':'',evidence:accepted?'DEMO 已核验的虚构交付结果':'',reviewStatus:accepted?'accepted':'none',completionPlanEnd:done?date:null,actualStart:done||started?date:null,actualEnd:done?date:null,version:accepted?4:2,createdAt:creation,updatedAt:done?`${date}T10:00:00.000Z`:creation,events:[{id:`comment-${i}`,taskId:taskId(i),actor:owner.name,action:'comment',text:`DEMO 进展记录 ${pad(i)}：范围已核对`,createdAt:creation}],submissions:[] };
      if(accepted) task.submissions.push({id:`submission-${i}`,taskId:task.id,version:3,submitterId:owner.memberId,reviewerId:reviewer.memberId,evidence:task.evidence,status:'accepted',comment:'DEMO 对照标准验收通过',createdAt:`${date}T05:00:00.000Z`,reviewedAt:`${date}T06:00:00.000Z`,reviewedById:reviewer.memberId,selfReview:false,snapshot:{title:task.title,description:task.description,acceptanceCriteria:task.acceptanceCriteria,ownerId:task.ownerId}});
      execution.push(task);
      nodes.push({id:task.id,parentId:task.parentId??`group-${group.id}`,workstreamId:group.id,wbs:task.wbs,kind:'task',title:task.title,description:task.description,owner:task.owner,color:'blue',status:task.status as PlanNode['status'],start:date,end:date,durationDays:planned?1:null,effortHours:4,progress:task.progress,blocked:false});
    }
    for(const group of streams) {
      const children=execution.filter(t=>t.parentId===`perf-summary-${streams.indexOf(group)}`); if(!children.length) continue;
      const exemplar=children[0]!; const dates=children.flatMap(t=>t.start?[t.start]:[]).sort();
      const summary:ManagedTask={...exemplar,id:`perf-summary-${streams.indexOf(group)}`,taskKind:'summary',parentId:null,title:`DEMO 汇总父任务 ${group.name}`,wbs:`${streams.indexOf(group)+1}.S`,status:'in_progress',progress:Math.round(children.reduce((n,t)=>n+t.progress,0)/children.length),start:dates[0]??null,end:dates.at(-1)??null,effortHours:children.length*4,requiresReview:false,reviewerId:null,reviewStatus:'none',acceptanceCriteria:'',evidence:'',completionPlanEnd:null,actualStart:null,actualEnd:null,events:[],submissions:[],version:1,updatedAt:creation};
      summaries.push(summary); nodes.push({id:summary.id,parentId:`group-${group.id}`,workstreamId:group.id,wbs:summary.wbs,kind:'task',title:summary.title,description:summary.description,owner:summary.owner,color:'blue',status:'in_progress',start:summary.start,end:summary.end,durationDays:Math.ceil(options.tasks/100),effortHours:summary.effortHours,progress:summary.progress,blocked:false});
    }
    const dependencies:PlanDependency[]=[];const edgeKeys=new Set<string>();
    // Layered DAG: 100 roots; each later task has one (three in dense mode) scheduled predecessor(s).
    for(let i=100;i<options.tasks;i++) for(let k=0;k<(options.dense?3:1);k++) {
      let predecessor=i-100-k; if(predecessor%10===9) predecessor--; if(predecessor<0) continue;
      const edgeKey=`${predecessor}:${i}`;if(!edgeKeys.has(edgeKey)){edgeKeys.add(edgeKey);dependencies.push({predecessorId:taskId(predecessor),successorId:taskId(i),type:'FS',lagDays:0});}
    }
    // All predecessor dates must be strictly earlier; first few columns of a layer use prior layers.
    const byId=new Map(execution.map(t=>[t.id,t]));
    const uniqueDeps=dependencies.filter(e=> {const a=byId.get(e.predecessorId)!;const b=byId.get(e.successorId)!;return !b.start||Boolean(a.end&&a.end<b.start);});
    db.transaction(()=>{
      db!.exec('DROP TRIGGER plan_baselines_no_delete;');
      for(const table of ['notifications','notification_seen','notification_idempotency','notification_job_retries','auth_sessions','auth_login_attempts','auth_audit','auth_receipts','project_user_links','auth_users','member_capacities','project_members','task_meta','homepage_tasks','plan_baselines','plan_history','plan_previews','plan_idempotency','task_idempotency','analytics_daily_snapshots','risk_records','risk_alerts','risk_idempotency','workstream_events','workstream_idempotency','workstreams','background_jobs','background_job_schedules']) db!.prepare(`DELETE FROM ${table}`).run();
      db!.exec("CREATE TRIGGER plan_baselines_no_delete BEFORE DELETE ON plan_baselines BEGIN SELECT RAISE(ABORT, 'Baseline snapshots are immutable'); END;");
      for(const account of accounts){
        db!.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(account.id,account.username,account.name,'user',1,0,0,1,hash,creation,creation);
        db!.prepare('INSERT INTO project_members(project_id,id,name,role,active) VALUES(?,?,?,?,1)').run(projectId,account.memberId,account.name,account.role);
        db!.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run(projectId,account.memberId,account.id);
        db!.prepare('INSERT INTO member_capacities VALUES(?,?,?)').run(projectId,account.memberId,JSON.stringify({memberId:account.memberId,hoursPerDay:8,exceptions:{}}));
      }
      for(const [i,s] of streams.entries()) db!.prepare('INSERT INTO workstreams VALUES(?,?,?,?,?,?,?,?,1)').run(projectId,s.id,s.name,s.description,s.ownerId,'blue',i,1);
      Object.assign(snapshot.project,{name:'DEMO · 20 人隔离性能测试',isDemo:true,start:'2026-06-01',end:streams[0]!.end,asOf:'2026-09-08'});
      Object.assign(snapshot,{mode:'demo',workstreams:streams,milestones:[],risks:[]});
      db!.prepare('UPDATE homepage_projects SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot),projectId);
      db!.prepare('UPDATE plan_projects SET version=1,nodes_json=?,dependencies_json=?,calendar_json=? WHERE project_id=?').run(JSON.stringify(nodes),JSON.stringify(uniqueDeps),JSON.stringify({...defaultCalendar,confirmed:true}),projectId);
      const insertHome=db!.prepare('INSERT INTO homepage_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');const insertMeta=db!.prepare('INSERT INTO task_meta VALUES(?,?,?)');
      for(const [position,task] of [...execution,...summaries].entries()) {insertHome.run(task.id,projectId,task.title,task.workstreamId,task.owner,'虚',task.status,task.priority,task.end??'',task.progress,0,position);insertMeta.run(task.id,projectId,JSON.stringify({...task,cancelled:false}));for(const event of task.events)db!.prepare('INSERT INTO notification_seen(project_id,event_key) VALUES(?,?)').run(projectId,`task:${task.id}:${event.id}`);}
      for(let i=0;i<3;i++){const baseline:PlanBaseline={id:`perf-baseline-${i}`,name:`DEMO 基线 ${i+1}`,createdAt:`2026-06-${String(i+1).padStart(2,'0')}T04:00:00.000Z`,actor:accounts[0]!.name,reason:'隔离测试基线；未排期任务明确排除',entries:execution.filter(t=>t.start).map(t=>({taskId:t.id,start:t.start,end:t.end,effortHours:t.effortHours,owner:t.owner})),dependencies:uniqueDeps.filter(e=>byId.get(e.successorId)!.start),calendar:{...defaultCalendar,confirmed:true},excludedIds:execution.filter(t=>!t.start).map(t=>t.id),demo:true};db!.prepare('INSERT INTO plan_baselines VALUES(?,?,?,?)').run(baseline.id,projectId,JSON.stringify(baseline),baseline.createdAt);}
      for(let i=0;i<90;i++){const date=new Date(Date.parse(FIXTURE_NOW)-(89-i)*86400000).toISOString().slice(0,10);const capturedAt=`${date}T15:55:00.000Z`;const tasks=execution.map(t=>{const historical={...t};if(!t.actualStart||t.actualStart>date){historical.status='todo';historical.progress=0;historical.actualStart=null;historical.actualEnd=null;historical.reviewStatus='none';historical.completionPlanEnd=null;}else if(t.actualEnd&&t.actualEnd>date){historical.status='in_progress';historical.progress=40;historical.actualEnd=null;historical.reviewStatus='none';historical.completionPlanEnd=null;}return analyticsTask(historical);});const daily={date,capturedAt,dataAsOf:date,planVersion:1,tasks,milestones:[]};db!.prepare('INSERT INTO analytics_daily_snapshots VALUES(?,?,?,?,?)').run(projectId,date,capturedAt,date,JSON.stringify(daily));}
      for(let i=0;i<20;i++){const task=execution[600+i]!;const risk={id:`perf-risk-${i}`,title:`DEMO 风险 ${i+1}`,description:'虚构性能测试风险',workstreamId:task.workstreamId,ownerId:task.ownerId,owner:task.owner,probability:2,impact:3,score:6,level:'medium',legacyLevel:null,status:'mitigating',occurred:false,due:'2026-09-30',reviewDate:'2026-09-15',response:'每日核对依赖与资源',acceptanceReason:'',taskIds:[task.id],actionTaskIds:[],sourceAlertId:null,closeReviewerId:accounts[0]!.memberId,closure:null,version:1,createdAt:creation,updatedAt:creation,events:[]};db!.prepare('INSERT INTO risk_records VALUES(?,?,?)').run(risk.id,projectId,JSON.stringify(risk));}
      db!.prepare("UPDATE risk_projects SET revision=1,rules_json='[]',last_evaluated_at=NULL,evaluation_error=NULL").run();
    })();
    const counts=validateFixture(db,projectId,options.tasks);
    const fixture={directory,dbPath,projectId,accounts,counts,cleanup:()=>rm(directory,{recursive:true,force:true})};
    await writeFile(join(directory,'fixture.json'),JSON.stringify({schema:1,seed:'goodwork-perf-v2',now:FIXTURE_NOW,options,projectId,counts},null,2));
    db.close();db=undefined;return fixture;
  } catch(error){if(db?.open)db.close();await rm(directory,{recursive:true,force:true});throw error;}
}
export function validateFixture(db:Database.Database,projectId:string,expected:number){
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  const metas=(db.prepare('SELECT meta_json FROM task_meta WHERE project_id=?').all(projectId) as {meta_json:string}[]).map(r=>JSON.parse(r.meta_json) as ManagedTask);
  const execution=metas.filter(t=>t.taskKind==='execution');assert.equal(execution.length,expected);assert.equal(execution.filter(t=>t.parentId).length,expected/5);assert.equal(execution.filter(t=>!t.start&&!t.end).length,expected/10);
  const row=db.prepare('SELECT nodes_json,dependencies_json FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string;dependencies_json:string};const nodes=JSON.parse(row.nodes_json) as PlanNode[];const deps=JSON.parse(row.dependencies_json) as PlanDependency[];const byId=new Map(nodes.map(n=>[n.id,n]));const metaById=new Map(metas.map(t=>[t.id,t]));
  for(const t of execution){assert(byId.has(t.id));assert.equal(Boolean(t.start),Boolean(t.end));if(t.start){assert(isWorkday(t.start));assert(isWorkday(t.end!));assert(t.start<=t.end!);}if(t.parentId){assert.equal(metaById.get(t.parentId)?.taskKind,'summary');assert.equal(metaById.get(t.parentId)?.workstreamId,t.workstreamId);}if(t.status==='done'){assert.equal(t.progress,100);assert(t.actualEnd);if(t.requiresReview){assert.equal(t.reviewStatus,'accepted');assert(t.submissions.some(s=>s.status==='accepted'&&s.reviewedAt&&s.reviewerId!==s.submitterId));}}for(const s of t.submissions){assert.equal(s.taskId,t.id);assert(s.snapshot?.acceptanceCriteria);assert(s.version<=t.version);}}
  for(const e of deps){const a=byId.get(e.predecessorId)!;const b=byId.get(e.successorId)!;assert(a&&b);assert(e.predecessorId<e.successorId,'strict task order proves DAG');if(b.start)assert(a.end&&a.end<b.start,'FS date invariant');}
  for(const row of db.prepare('SELECT snapshot_json FROM plan_baselines WHERE project_id=?').all(projectId) as {snapshot_json:string}[]){const baseline=JSON.parse(row.snapshot_json) as PlanBaseline;assert.equal(baseline.entries.length+baseline.excludedIds.length,expected);for(const e of baseline.entries){assert(metaById.has(e.taskId));assert(e.start&&e.end&&e.start<=e.end);}}
  for(const row of db.prepare('SELECT date,snapshot_json FROM analytics_daily_snapshots WHERE project_id=?').all(projectId) as {date:string;snapshot_json:string}[]){const daily=JSON.parse(row.snapshot_json);assert.equal(daily.date,row.date);assert.equal(daily.tasks.length,expected);for(const task of daily.tasks){assert(metaById.has(task.id));if(task.status==='done'){assert.equal(task.progress,100);assert(task.actualEnd&&task.actualEnd<=daily.date);}if(task.reviewStatus==='accepted')assert.equal(task.status,'done');}}
  const count=(table:string)=>Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n);
  assert.equal(count('auth_users'),20);assert.equal(count('workstreams'),20);assert.equal(count('plan_baselines'),3);assert.equal(count('analytics_daily_snapshots'),90);
  return {completed:execution.filter(t=>t.status==='done').length,execution:execution.length,summary:metas.length-execution.length,groups:20,accounts:20,children:execution.filter(t=>t.parentId).length,unscheduled:execution.filter(t=>!t.start).length,dependencies:deps.length,comments:execution.reduce((n,t)=>n+t.events.length,0),submissions:execution.reduce((n,t)=>n+t.submissions.length,0),risks:count('risk_records'),baselines:3,dailySnapshots:90};
}
