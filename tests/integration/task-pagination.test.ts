import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readTaskPage, readTaskEditor } from '../../server/src/modules/tasks/query.js';
import { readPlan } from '../../server/src/modules/planning/repository.js';
import { readAnalytics } from '../../server/src/modules/analytics/repository.js';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import type { TaskPage, TaskWorkspace } from '../../shared/src/tasks.js';
let app:FastifyInstance, directory:string, path:string;
const prefix='/api/v1/projects/phase-one';
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'gw-page-'));path=join(directory,'test.sqlite');app=buildLegacyApp({dbPath:path,jobIntervalMs:0});});
afterEach(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
async function page(query='') {const r=await app.inject(`${prefix}/tasks/query?state=all&${query}`);expect(r.statusCode,r.body).toBe(200);return r.json().data as TaskPage;}
async function workspace(){return (await app.inject(`${prefix}/tasks`)).json().data as TaskWorkspace;}
function post(w:TaskWorkspace,id:string,payload:object,actor='zhou',key=randomUUID(),operation='transition'){return app.inject({method:'POST',url:`${prefix}/tasks/${id}/${operation}`,headers:{'x-preview-token':w.writeToken,'x-demo-actor':actor,'idempotency-key':key},payload:{expectedPlanVersion:w.planVersion,expectedStructureVersion:w.structureVersion,...payload}});}
test('SQL pagination covers all tasks once, stable ordering, full-scope counts and literal search',async()=>{
 const all=await workspace(), first=await page('pageSize=20&sort=wbs'),second=await page('pageSize=20&sort=wbs&page=2'),third=await page('pageSize=20&sort=wbs&page=3');
 expect(first.total).toBe(all.tasks.length);expect(first.tasks).toHaveLength(20);expect(new Set([...first.tasks,...second.tasks,...third.tasks].map(t=>t.id)).size).toBe(all.tasks.length);
 expect((await page('pageSize=20&page=999')).page).toBe(3);
 expect((await page('query='+encodeURIComponent(all.tasks.at(-1)!.title))).tasks.map(t=>t.id)).toContain(all.tasks.at(-1)!.id);
 expect((await page('query=%25')).tasks).toEqual([]);
 expect(first.scopeCounts.all).toBe(all.tasks.length);expect(first.tasks.every(t=>t.events.length===0&&t.submissions.length===0&&t.description==='')).toBe(true);
 for(const q of ['page=0','page=-1','pageSize=200','sort=sql','page=1&page=2','unknown=x'])expect((await app.inject(`${prefix}/tasks/query?${q}`)).statusCode,q).toBe(422);
 const mine=await page('scope=mine&actorId=chen');expect(mine.total).toBe(all.tasks.filter(t=>t.ownerId==='chen').length);
 const done=await page('boardState=done');expect(done.total).toBe(all.tasks.filter(t=>t.status==='done').length);expect(done.boardCounts.todo).toBe(all.tasks.filter(t=>t.status==='todo').length);
});
test('different task edits succeed against one structure version; same-task stale update conflicts and stale structure rejects',async()=>{
 const w=await workspace();const tasks=w.tasks.filter(t=>t.status==='in_progress'&&!t.requiresReview).slice(0,2);expect(tasks).toHaveLength(2);
 const results=await Promise.all(tasks.map(t=>post(w,t.id,{expectedVersion:t.version,action:'progress',progress:43,reason:'并发测试'})));expect(results.map(r=>r.statusCode)).toEqual([200,200]);
 const stale=await post(w,tasks[0]!.id,{expectedVersion:tasks[0]!.version,action:'progress',progress:50,reason:'旧任务版本'});expect(stale.statusCode).toBe(409);
 const fresh=await workspace();const db=new Database(path);const raw=db.prepare('SELECT calendar_json FROM plan_projects WHERE project_id=?').get('phase-one') as {calendar_json:string};const calendar=JSON.parse(raw.calendar_json);calendar.hoursPerDay=7;db.prepare('UPDATE plan_projects SET calendar_json=? WHERE project_id=?').run(JSON.stringify(calendar),'phase-one');db.close();
 const conflict=await post(fresh,tasks[1]!.id,{expectedVersion:fresh.tasks.find(t=>t.id===tasks[1]!.id)!.version,action:'progress',progress:55,reason:'过期结构'});expect(conflict.statusCode).toBe(409);
});
test('concurrent append comments persist exactly once, idempotent replay and viewer denial',async()=>{
 const w=await workspace(),task=w.tasks[0]!,key=randomUUID();
 const payload={expectedVersion:task.version,text:'同一逻辑评论'};
 const first=await post(w,task.id,payload,'zhou',key,'comments');expect(first.statusCode,first.body).toBe(200);
 const replay=await post(w,task.id,payload,'zhou',key,'comments');expect(replay.json()).toEqual(first.json());
 const results=await Promise.all(Array.from({length:20},(_,i)=>post(w,task.id,{expectedVersion:task.version,text:`并发评论${i}`},'zhou',randomUUID(),'comments')));expect(results.every(r=>r.statusCode===200)).toBe(true);
 const updated=(await workspace()).tasks.find(t=>t.id===task.id)!;expect(updated.events.filter(e=>e.text==='同一逻辑评论')).toHaveLength(1);expect(updated.events.filter(e=>e.text.startsWith('并发评论'))).toHaveLength(20);
 expect((await post(w,task.id,payload,'xu',randomUUID(),'comments')).statusCode).toBe(403);
 const details=await app.inject(`${prefix}/tasks/${task.id}`);expect(details.statusCode).toBe(200);expect(details.json().data.tasks.find((t:{id:string})=>t.id===task.id).events).toEqual(updated.events);
});
test('aggregate statistics and full detail share metrics, invalidate after writes and retain export data',async()=>{
 const get=async(detail:string)=>(await app.inject(`${prefix}/analytics?detail=${detail}`)).json().data;
 const summary=await get('summary'),full=await get('full');expect(summary.tasks).toEqual([]);expect(summary.deviations).toEqual([]);expect(summary.counts).toEqual(full.counts);expect(summary.metrics).toEqual(full.metrics);expect(full.tasks.length).toBeGreaterThan(0);
 const w=await workspace(),task=w.tasks.find(t=>t.status==='in_progress'&&!t.requiresReview&&w.dependencies.filter(e=>e.successorId===t.id).every(e=>w.tasks.find(p=>p.id===e.predecessorId)?.status==='done'))!;expect(task).toBeDefined();const done=await post(w,task.id,{expectedVersion:task.version,action:'complete',reason:'验证统计失效'});expect(done.statusCode,done.body).toBe(200);expect((await get('summary')).counts.done).toBe(full.counts.done+1);
});

test('task-scoped start/progress preserves guards, exact replay and committed read models',async()=>{
 let w=await workspace();const todo=w.tasks.find(t=>t.status==='todo'&&t.taskKind==='execution'&&t.reviewStatus!=='submitted')!;
 expect(todo).toBeDefined();const payload={expectedVersion:todo.version,action:'start',reason:'单任务开始'},key=randomUUID();
 const denied=await post(w,todo.id,payload,'xu');expect(denied.statusCode).toBe(403);
 const other=w.actors.find(a=>a.role==='member'&&a.id!==todo.ownerId)!;expect(other).toBeDefined();expect((await post(w,todo.id,payload,other.id)).statusCode).toBe(403);
 const started=await post(w,todo.id,payload,'zhou',key);expect(started.statusCode,started.body).toBe(200);
 expect((await post(w,todo.id,payload,'zhou',key)).json()).toEqual(started.json());
 const saved=(await workspace()).tasks.find(t=>t.id===todo.id)!;expect(started.json().data.task).toEqual(saved);expect(saved.status).toBe('in_progress');expect(saved.actualStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
 w=await workspace();const invalid=await post(w,saved.id,{expectedVersion:saved.version,action:'progress',progress:100,reason:'不能绕过完成'});expect(invalid.statusCode).toBe(422);
 const done=w.tasks.find(t=>t.status==='done'&&t.taskKind==='execution')!;expect((await post(w,done.id,{expectedVersion:done.version,action:'progress',progress:20,reason:'已完成不可改'})).statusCode).toBe(422);
 const db=new Database(path);db.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.reviewStatus','submitted') WHERE task_id=?").run(saved.id);db.close();
 w=await workspace();const pending=w.tasks.find(t=>t.id===saved.id)!;expect((await post(w,pending.id,{expectedVersion:pending.version,action:'progress',progress:30,reason:'验收中不可改'})).statusCode).toBe(422);
});
test('a plan storage failure rolls back task-scoped progress and its receipt/audit',async()=>{
 const w=await workspace(),task=w.tasks.find(t=>t.status==='in_progress'&&!t.requiresReview&&t.taskKind==='execution')!,key=randomUUID();
 const db=new Database(path);const before=db.prepare('SELECT * FROM homepage_tasks WHERE id=?').get(task.id);const meta=db.prepare('SELECT * FROM task_meta WHERE task_id=?').get(task.id);
 db.exec("CREATE TRIGGER fail_scoped_plan BEFORE UPDATE ON plan_projects BEGIN SELECT RAISE(ABORT,'fixture plan failure'); END");
 const failed=await post(w,task.id,{expectedVersion:task.version,action:'progress',progress:47,reason:'不应持久化'},'zhou',key);expect(failed.statusCode).toBe(500);
 expect(db.prepare('SELECT * FROM homepage_tasks WHERE id=?').get(task.id)).toEqual(before);expect(db.prepare('SELECT * FROM task_meta WHERE task_id=?').get(task.id)).toEqual(meta);
 expect(db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get('phase-one')).toEqual({version:w.planVersion});expect(db.prepare('SELECT * FROM task_idempotency WHERE request_key=?').get(key)).toBeUndefined();db.exec('DROP TRIGGER fail_scoped_plan');db.close();
});

test('scoped execution state survives unrelated writes, group reorder, scheduling, restart and backup restore',async()=>{
 let w=await workspace();const task=w.tasks.find(t=>t.status==='todo'&&t.taskKind==='execution'&&t.reviewStatus!=='submitted')!;
 const write=async(url:string,payload:object)=>{const r=await app.inject({method:'POST',url:prefix+url,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou',origin:'http://127.0.0.1:5174','idempotency-key':randomUUID()},payload});expect(r.statusCode,r.body).toBe(200);return r.json().data;};
 expect((await post(w,task.id,{expectedVersion:task.version,action:'start',reason:'生命周期开始'})).statusCode).toBe(200);
 w=await workspace();expect((await post(w,task.id,{expectedVersion:w.tasks.find(t=>t.id===task.id)!.version,action:'progress',progress:63,reason:'持久执行进度'})).statusCode).toBe(200);
 const verify=async()=>{const current=(await workspace()).tasks.find(t=>t.id===task.id)!;expect(current).toMatchObject({status:'in_progress',progress:63});expect(current.actualStart).toBeTruthy();const plan=(await app.inject(`${prefix}/gantt`)).json().data;expect(plan.nodes.find((n:{id:string})=>n.id===task.id)).toMatchObject({status:'in_progress',progress:63});};
 await verify();w=await workspace();const other=w.tasks.find(t=>t.id!==task.id&&t.status==='in_progress'&&t.taskKind==='execution'&&t.reviewStatus!=='submitted')!;
 await write(`/tasks/${other.id}/transition`,{expectedPlanVersion:w.planVersion,expectedVersion:other.version,action:'progress',progress:42,reason:'普通路径整份写入'});await verify();
 const groups=(await app.inject(`${prefix}/workstreams`)).json().data;
 await write(`/workstreams/${groups.workstreams[1].id}/move`,{expectedVersion:groups.version,expectedPlanVersion:groups.planVersion,reason:'验证重排保留执行状态',direction:'up'});await verify();
 w=await workspace();const preview=await write('/schedule/preview',{expectedPlanVersion:w.planVersion,reason:'验证排期保留执行状态',changes:[{taskId:'task-006',start:'2026-10-01',end:'2026-10-05'}],mode:'push_successors'});
 await write('/schedule/apply',{previewId:preview.id,expectedPlanVersion:preview.basePlanVersion});await verify();
 await app.close();app=buildLegacyApp({dbPath:path,jobIntervalMs:0});await verify();
 const backup=join(directory,'restore.sqlite'),db=new Database(path);await db.backup(backup);db.close();await app.close();app=buildLegacyApp({dbPath:backup,jobIntervalMs:0});await verify();
});


test('cached plan and analytics responses cannot be mutated by another request',()=>{
 const db=new Database(path),now=new Date('2026-09-08T04:00:00Z');
 try {
   const plan=readPlan(db,'phase-one','first',now),expected=structuredClone(plan);
   plan.nodes[0]!.title='caller mutation';plan.calendar.weekdays.length=0;
   const second=readPlan(db,'phase-one','second',now);expect(second).toEqual({...expected,writeToken:'second'});
   const report=readAnalytics(db,'phase-one',{},now),full=structuredClone(report);
   report.counts.total=-1;report.tasks.length=0;report.metrics.completion.taskIds.length=0;
   expect(readAnalytics(db,'phase-one',{},now)).toEqual(full);
   const summary=readAnalytics(db,'phase-one',{detail:'summary'},now);summary.counts.total=-2;
   expect(readAnalytics(db,'phase-one',{detail:'summary'},now).counts).toEqual(full.counts);
 } finally { db.close(); }
});


test('external commit during task-index construction invalidates the following request',()=>{
 const db=new Database(path),writer=new Database(path),now=new Date('2026-09-08T04:00:00Z');
 const original=db.exec.bind(db);let committed=false;
 const hook=vi.spyOn(db,'exec').mockImplementation(sql=>{
   if (!committed && sql.includes('CREATE TEMP TABLE')) {
     committed=true;writer.prepare('UPDATE homepage_tasks SET title=? WHERE id=?').run('external concurrent title','task-006');
   }
   return original(sql);
 });
 try {
   const first=readTaskPage(db,'phase-one',{state:'all'},'zhou','',now);
   expect(committed).toBe(true);expect(first.tasks.find(t=>t.id==='task-006')?.title).not.toBe('external concurrent title');
   const second=readTaskPage(db,'phase-one',{state:'all',query:'external concurrent title'},'zhou','',now);
   expect(second.total).toBe(1);expect(second.tasks[0]?.id).toBe('task-006');
 } finally { hook.mockRestore();db.close();writer.close(); }
});


test('existing task editor includes only its relationship context while creation retains root candidates',async()=>{
 const initial=await workspace();const [ancestor,parent,predecessor,unrelated,target,child]=initial.tasks.slice(0,6);
 const db=new Database(path);
 try {
  const attach=db.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.parentId',?) WHERE task_id=?");
  attach.run(ancestor!.id,parent!.id);attach.run(parent!.id,target!.id);attach.run(target!.id,child!.id);
  db.prepare('UPDATE plan_projects SET dependencies_json=?,version=version+1 WHERE project_id=?').run(JSON.stringify([{predecessorId:predecessor!.id,successorId:target!.id,type:'FS',lagDays:0}]),'phase-one');
  const detail=readTaskEditor(db,'phase-one','token',new Date(),target!.id);
  expect(detail.tasks.map(t=>t.id).sort()).toEqual([ancestor!.id,parent!.id,predecessor!.id,target!.id,child!.id].sort());
  expect(detail.tasks.some(t=>t.id===unrelated!.id)).toBe(false);
  const all=await workspace();
  const creation=readTaskEditor(db,'phase-one','token',new Date());
  expect(creation.tasks.map(t=>t.id).sort()).toEqual(all.tasks.filter(t=>t.parentId===null).map(t=>t.id).sort());
  const scoped=readTaskEditor(db,'phase-one','token',new Date(),undefined,ancestor!.workstreamId);
  expect(scoped.tasks.map(t=>t.id).sort()).toEqual(all.tasks.filter(t=>t.parentId===null&&t.workstreamId===ancestor!.workstreamId).map(t=>t.id).sort());
 } finally {db.close();}
});

async function createReadbackTask(review=false) {
 const w=await workspace();
 const result=await app.inject({method:'POST',url:prefix+'/tasks',headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{expectedPlanVersion:w.planVersion,title:review?'关键结果回读':'执行结果回读',description:'',workstreamId:w.workstreams[0]!.id,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:review,reviewerId:review?'lin':null,acceptanceCriteria:review?'核对成果':'',evidence:review?'已提供成果':'',start:null,end:null}});
 expect(result.statusCode,result.body).toBe(200);
 return result.json().data.task.id as string;
}
async function transitionWithReadback(id:string,action:string,extra:object={},actor='zhou') {
 const w=await workspace(),task=w.tasks.find(t=>t.id===id)!;
 const response=await post(w,id,{expectedVersion:task.version,action,reason:'验证返回数据',...extra},actor);
 expect(response.statusCode,response.body).toBe(200);
 const saved=(await workspace()).tasks.find(t=>t.id===id)!;
 expect(response.json().data.task).toEqual(saved);
 return saved;
}
test('execution transition responses equal authoritative readback through block, completion, cancellation and reopen',async()=>{
 const ordinary=await createReadbackTask();
 for(const action of ['block','unblock','complete','reopen','cancel','reopen'])await transitionWithReadback(ordinary,action,action==='reopen'?{progress:30}:{});
});
test('key review responses equal authoritative readback through submit, reject, accept and reopen',async()=>{
 const key=await createReadbackTask(true);await transitionWithReadback(key,'start');
 let submitted=await transitionWithReadback(key,'submit');await transitionWithReadback(key,'reject',{submissionId:submitted.submissions.at(-1)!.id},'lin');
 submitted=await transitionWithReadback(key,'submit');const accepted=await transitionWithReadback(key,'accept',{submissionId:submitted.submissions.at(-1)!.id},'lin');
 expect(accepted.parentEligibility?.mode).toBe('blocked');expect((await transitionWithReadback(key,'reopen',{progress:20})).parentEligibility?.mode).toBe('convert');
});
