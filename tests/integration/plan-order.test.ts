import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import { orderPlanNodes } from '../../shared/src/plan-order.js';
import type { PlanNode, ProjectPlan } from '../../shared/src/planning.js';

const prefix='/api/v1/projects/phase-one', now=new Date('2026-09-23T06:00:00Z');
describe('persisted sibling ordering',()=>{
 let dir:string,path:string,app:FastifyInstance,db:Database.Database,token:string;
 beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'goodwork-order-'));path=join(dir,'app.sqlite');app=buildLegacyApp({dbPath:path,clock:()=>now,jobIntervalMs:0});db=new Database(path);token=(await plan()).writeToken;});
 afterEach(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 async function plan():Promise<ProjectPlan>{return (await app.inject(`${prefix}/gantt`)).json().data;}
 async function save(body:object,actor='zhou',key=randomUUID()){return app.inject({method:'POST',url:`${prefix}/plan/order`,headers:{'x-preview-token':token,'x-demo-actor':actor,'idempotency-key':key},payload:body});}
 const snapshot=()=>Object.fromEntries(['plan_projects','plan_structure_versions','task_meta','homepage_tasks','plan_baselines'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
 const revision=async()=> (await app.inject(`${prefix}/revision?actorId=zhou`)).json().data.revision;
 async function create(extra:object={}){const p=await plan();const response=await app.inject({method:'POST',url:`${prefix}/tasks`,headers:{'x-preview-token':token,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{title:'排序测试任务',description:'',workstreamId:p.nodes[0]!.workstreamId,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:null,end:null,expectedPlanVersion:p.planVersion,...extra}});expect(response.statusCode,response.body).toBe(200);return response.json().data;}
 test('changes only order and history, invalidates reads and query index, persists/replays after restart',async()=>{
  const p=await plan(),original=p.siblingOrders[0]!,order={...original,nodeIds:[...original.nodeIds].reverse()},body={expectedOrderVersion:p.orderVersion,orders:[order]},key=randomUUID();
  await app.inject(`${prefix}/tasks/query?sort=plan&state=all`);
  const before=snapshot(),rev=await revision();
  const businessJobs=()=>db.prepare("SELECT * FROM background_jobs WHERE kind IN ('snapshot','risk_evaluate') ORDER BY id").all();
  const jobsBefore=businessJobs();
  const result=await save(body,'zhou',key);expect(result.statusCode,result.body).toBe(200);expect(result.json().data.orderVersion).toBe(2);
  expect(snapshot()).toEqual(before);expect(await revision()).not.toBe(rev);expect(businessJobs()).toEqual(jobsBefore);
  const after=await plan();expect(after.siblingOrders[0]).toEqual(order);expect(after.nodes).toEqual(p.nodes);expect(after.history[0]!.actor).toBe('周亦安');expect(after.history[0]!.orders).toEqual([{parentId:order.parentId,before:original.nodeIds,after:order.nodeIds}]);
  const page=await app.inject(`${prefix}/tasks/query?sort=plan&state=all`);expect(page.statusCode,page.body).toBe(200);
  const ids=new Set(page.json().data.tasks.map((t:any)=>t.id));
  expect(page.json().data.tasks.map((t:any)=>t.id)).toEqual(orderPlanNodes(after.nodes,after.siblingOrders).filter(n=>ids.has(n.id)).map(n=>n.id));
  expect((await save(body)).json().error.code).toBe('ORDER_VERSION_CONFLICT');
  await app.close();app=buildLegacyApp({dbPath:path,clock:()=>now});token=(await plan()).writeToken;
  expect((await save(body,'zhou',key)).json()).toEqual(result.json());expect((await plan()).siblingOrders[0]).toEqual(order);
  expect(db.prepare('SELECT count(*) n FROM plan_history').get()).toEqual({n:1});

 });
 test('checks permissions before replay and keeps receipts scoped to actors',async()=>{
  const p=await plan(),body={expectedOrderVersion:1,orders:[{...p.siblingOrders[0]!,nodeIds:[...p.siblingOrders[0]!.nodeIds].reverse()}]},key=randomUUID();
  for(const actor of ['chen','lin','xu','unknown','']) expect((await save(body,actor,key)).statusCode).toBe(403);
  expect((await save(body,'zhou',key)).statusCode).toBe(200);
  db.prepare("UPDATE project_members SET role='member' WHERE id='zhou'").run();
  expect((await save(body,'zhou',key)).statusCode).toBe(403);
  db.prepare("UPDATE project_members SET role='project_admin' WHERE id='lin'").run();
  expect((await save(body,'lin',key)).json().error.code).toBe('ORDER_VERSION_CONFLICT');
  expect((await save({...body,expectedOrderVersion:2},'lin',key)).statusCode).toBe(200);
 });
 test('rejects malformed permutations and concurrent membership changes without writing',async()=>{
  const p=await plan(),order=p.siblingOrders[0]!,before=snapshot();
  for(const orders of [[{...order,nodeIds:[order.nodeIds[0],order.nodeIds[0]]}],[order,order]]) expect((await save({expectedOrderVersion:1,orders})).statusCode).toBe(422);
  for(const orders of [[{...order,nodeIds:order.nodeIds.slice(1)}],[{parentId:'elsewhere',nodeIds:order.nodeIds}],[{...order,nodeIds:order.nodeIds.map((id,i)=>i?`other-project-${i}`:id)}]]) expect((await save({expectedOrderVersion:1,orders})).statusCode).toBe(409);
  expect(snapshot()).toEqual(before);
  const created=await create();expect((await plan()).orderVersion).toBe(1);
  expect((await save({expectedOrderVersion:1,orders:[order]})).json().error.code).toBe('ORDER_MEMBERSHIP_CONFLICT');
  expect((await plan()).siblingOrders.find(o=>o.parentId===order.parentId)!.nodeIds.at(-1)).toBe(created.task.id);
 });
 test('progress/comment writes and schedule previews coexist with ordering without overwrites',async()=>{
  const p=await plan(),body={expectedOrderVersion:1,orders:[{...p.siblingOrders[0]!,nodeIds:[...p.siblingOrders[0]!.nodeIds].reverse()}]};
  const ws=(await app.inject(`${prefix}/tasks`)).json().data,task=ws.tasks.find((t:any)=>t.status==='in_progress'&&t.ownerId==='chen');
  const response=await app.inject({method:'POST',url:`${prefix}/tasks/${task.id}/comments`,headers:{'x-preview-token':token,'x-demo-actor':'chen','idempotency-key':randomUUID()},payload:{expectedVersion:task.version,expectedPlanVersion:ws.planVersion,text:'保留并发备注'}});expect(response.statusCode,response.body).toBe(200);
  const before=snapshot();expect((await save(body)).statusCode).toBe(200);expect(snapshot()).toEqual(before);
  const preview=await app.inject({method:'POST',url:`${prefix}/schedule/preview`,headers:{'x-preview-token':token},payload:{expectedPlanVersion:(await plan()).planVersion,changes:[{taskId:'task-006',start:'2026-10-01',end:'2026-10-05'}],reason:'检查隔离',mode:'push_successors'}});expect(preview.statusCode,preview.body).toBe(200);
  const orders=(await plan()).siblingOrders;
  const apply=await app.inject({method:'POST',url:`${prefix}/schedule/apply`,headers:{'x-preview-token':token,'idempotency-key':randomUUID()},payload:{previewId:preview.json().data.id,expectedPlanVersion:preview.json().data.basePlanVersion}});expect(apply.statusCode,apply.body).toBe(200);expect((await plan()).siblingOrders).toEqual(orders);
 });
 test('wrapper inherits position, original is first child, moving an existing child appends',async()=>{
  const first=await create(),second=await create(),p=await plan(),parent=p.nodes.find(n=>n.id===first.task.id)!.parentId!;
  const ids=p.siblingOrders.find(o=>o.parentId===parent)!.nodeIds;const reversed=[...ids].reverse();
  expect((await save({expectedOrderVersion:1,orders:[{parentId:parent,nodeIds:reversed}]})).statusCode).toBe(200);
  const converted=await create({parentId:first.task.id,confirmParentConversion:true,expectedParentVersion:first.task.version});
  const after=await plan(),top=after.siblingOrders.find(o=>o.parentId===parent)!.nodeIds;
  expect(top.indexOf(converted.parentTask.id)).toBe(reversed.indexOf(first.task.id));
  expect(after.siblingOrders.find(o=>o.parentId===converted.parentTask.id)!.nodeIds).toEqual([first.task.id,converted.task.id]);
  const ws=(await app.inject(`${prefix}/tasks`)).json().data,t=ws.tasks.find((t:any)=>t.id===second.task.id);
  const fields=Object.fromEntries(['title','description','workstreamId','parentId','ownerId','priority','effortHours','requiresReview','reviewerId','acceptanceCriteria','evidence'].map(k=>[k,t[k]]));
  const move=await app.inject({method:'PATCH',url:`${prefix}/tasks/${t.id}`,headers:{'x-preview-token':token,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{...fields,parentId:converted.parentTask.id,expectedVersion:t.version,expectedPlanVersion:ws.planVersion}});expect(move.statusCode,move.body).toBe(200);
  expect((await plan()).siblingOrders.find(o=>o.parentId===converted.parentTask.id)!.nodeIds).toEqual([first.task.id,converted.task.id,second.task.id]);
 });
 test('audit failure rolls back order, history, receipts and notification jobs together',async()=>{
  const p=await plan(),body={expectedOrderVersion:1,orders:[{...p.siblingOrders[0]!,nodeIds:[...p.siblingOrders[0]!.nodeIds].reverse()}]},key=randomUUID();
  const jobs=db.prepare('SELECT * FROM background_jobs').all();
  db.exec("CREATE TRIGGER order_audit_failure BEFORE INSERT ON plan_history BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  expect((await save(body,'zhou',key)).statusCode).toBe(500);
  expect((await plan()).siblingOrders).toEqual(p.siblingOrders);expect((await plan()).orderVersion).toBe(1);
  expect(db.prepare('SELECT * FROM plan_order_receipts').all()).toEqual([]);expect(db.prepare('SELECT * FROM background_jobs').all()).toEqual(jobs);
  db.exec('DROP TRIGGER order_audit_failure');expect((await save(body,'zhou',key)).statusCode).toBe(200);
 });
 test('cancelled sibling slots survive visible sorting and reopening',async()=>{
  const a=await create(),b=await create(),c=await create();
  async function transition(id:string,action:string){const w=(await app.inject(`${prefix}/tasks`)).json().data,t=w.tasks.find((t:any)=>t.id===id);const r=await app.inject({method:'POST',url:`${prefix}/tasks/${id}/transition`,headers:{'x-preview-token':token,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{expectedPlanVersion:w.planVersion,expectedVersion:t.version,action,...(action==='reopen'?{progress:0}:{}),reason:'排序保留测试'}});expect(r.statusCode,r.body).toBe(200);}
  const original=await plan(),parent=original.nodes.find(n=>n.id===a.task.id)!.parentId!,originalOrder=original.siblingOrders.find(o=>o.parentId===parent)!;
  await transition(b.task.id,'cancel');const active=await plan(),order=active.siblingOrders.find(o=>o.parentId===parent)!;
  expect(order.nodeIds).not.toContain(b.task.id);expect((await save({expectedOrderVersion:1,orders:[originalOrder]})).statusCode).toBe(409);
  const reordered=[...order.nodeIds].reverse();expect((await save({expectedOrderVersion:1,orders:[{...order,nodeIds:reordered}]})).statusCode).toBe(200);
  const visible=await plan();expect(visible.siblingOrders.find(o=>o.parentId===parent)!.nodeIds).toEqual(reordered);
  await transition(b.task.id,'reopen');const restored=(await plan()).siblingOrders.find(o=>o.parentId===parent)!.nodeIds;
  expect(restored.indexOf(b.task.id)).toBe(originalOrder.nodeIds.indexOf(b.task.id));expect(restored.filter(id=>id!==b.task.id)).toEqual(reordered);
  expect(restored).toContain(c.task.id);
 });
 test('5000 sibling API ordering persists, paginates by plan rank and preserves dates and WBS',async()=>{
  const initial=await plan(),parent=initial.siblingOrders[0]!.parentId;
  const row=db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get('phase-one') as {nodes_json:string};
  const nodes=JSON.parse(row.nodes_json) as PlanNode[],siblings=nodes.filter(n=>n.parentId===parent),sample=siblings.find(n=>n.kind==='task')!;
  const metaRow=db.prepare('SELECT meta_json FROM task_meta WHERE task_id=?').get(sample.id) as {meta_json:string};
  const meta=JSON.parse(metaRow.meta_json),firstPosition=(db.prepare('SELECT max(position) n FROM homepage_tasks').get() as {n:number}).n+1;
  const seedStart=performance.now();
  db.transaction(()=>{
   const home=db.prepare('INSERT INTO homepage_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),metadata=db.prepare('INSERT INTO task_meta VALUES(?,?,?)');
   for(let index=0;index<5000-siblings.length;index++) {
    const id=`order-load-${String(index).padStart(5,'0')}`,title=`DEMO 排序容量任务 ${index+1}`,wbs=`${nodes.find(n=>n.id===parent)!.wbs}.L${index+1}`;
    nodes.push({...sample,id,title,wbs,status:'todo',progress:0,start:'2026-10-01',end:'2026-10-01',durationDays:1,effortHours:8,blocked:false});
    home.run(id,'phase-one',title,sample.workstreamId,sample.owner,sample.owner.slice(0,1),'todo','P1','2026-10-01',0,0,firstPosition+index);
    metadata.run(id,'phase-one',JSON.stringify({...meta,id,title,wbs,status:'todo',progress:0,parentId:null,taskKind:'execution',originalWork:false,cancelled:false,reviewStatus:'none',submissions:[],actualStart:null,actualEnd:null,blocked:false,events:[{id:`prior-${id}`,actor:sample.owner,action:'comment',text:'DEMO 历史讨论',createdAt:'2026-09-01T00:00:00Z'}]}));
   }
   db.prepare('UPDATE plan_projects SET nodes_json=?,version=version+1 WHERE project_id=?').run(JSON.stringify(nodes),'phase-one');
  })();
  const seedMs=performance.now()-seedStart;
  const p=await plan(),order=p.siblingOrders.find(o=>o.parentId===parent)!;expect(order.nodeIds).toHaveLength(5000);
  const reversed=[...order.nodeIds].reverse(),payload={expectedOrderVersion:p.orderVersion,orders:[{parentId:parent,nodeIds:reversed}]};
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1024*1024);
  const unchanged=db.prepare('SELECT * FROM plan_projects WHERE project_id=?').get('phase-one');
  const jobsBefore=(db.prepare('SELECT count(*) n FROM background_jobs').get() as {n:number}).n;
  const saveStart=performance.now(),response=await save(payload),saveMs=performance.now()-saveStart;
  expect(response.statusCode,response.body).toBe(200);expect(response.json().data.affectedCount).toBe(5000);
  expect(db.prepare('SELECT * FROM plan_projects WHERE project_id=?').get('phase-one')).toEqual(unchanged);
  const newJobs=db.prepare('SELECT kind,payload_json FROM background_jobs ORDER BY rowid LIMIT -1 OFFSET ?').all(jobsBefore) as {kind:string;payload_json:string}[];
  expect(newJobs).toHaveLength(4);expect(newJobs.every(job=>job.kind==='notification'&&JSON.parse(job.payload_json).kind==='plan.调整任务顺序')).toBe(true);
  const ids=new Set(nodes.filter(n=>n.kind==='task').map(n=>n.id)),expected=reversed.filter(id=>ids.has(id));
  const queryStart=performance.now();
  for(const page of [1,25,50]) {
   const response=await app.inject(`${prefix}/tasks/query?sort=plan&state=all&pageSize=100&page=${page}&workstreamId=${sample.workstreamId}`);
   expect(response.statusCode,response.body).toBe(200);expect(response.json().data.total).toBe(expected.length);
   expect(response.json().data.tasks.map((task:any)=>task.id)).toEqual(expected.slice((page-1)*100,page*100));
  }
  const queryMs=performance.now()-queryStart;
  await app.close();const restartStart=performance.now();app=buildLegacyApp({dbPath:path,clock:()=>now,jobIntervalMs:0});
  const reloaded=await plan(),reloadMs=performance.now()-restartStart;
  expect(reloaded.siblingOrders.find(o=>o.parentId===parent)!.nodeIds).toEqual(reversed);
  expect(reloaded.orderVersion).toBe(p.orderVersion+1);
  expect(db.prepare('SELECT * FROM plan_projects WHERE project_id=?').get('phase-one')).toEqual(unchanged);
  console.info('ORDER_5000_PERFORMANCE',JSON.stringify({siblingCount:5000,requestBytes:Buffer.byteLength(JSON.stringify(payload)),seedMs:Math.round(seedMs),saveMs:Math.round(saveMs),threeQueryPagesMs:Math.round(queryMs),restartAndGanttMs:Math.round(reloadMs)}));
 },60000);
 test('upgrades existing database orders without rewriting business state',async()=>{
  const p=await plan(),before=snapshot();await app.close();db.exec('DROP TABLE plan_order_receipts; DROP TABLE plan_order_projects;');app=buildLegacyApp({dbPath:path,clock:()=>now});
  expect((await plan()).siblingOrders).toEqual(p.siblingOrders);expect(snapshot()).toEqual(before);
 });
 test('authenticated permissions use real actor and recheck revoked role before receipt',async()=>{
  await app.close();app=buildApp({dbPath:path,clock:()=>now,jobIntervalMs:0});
  await createInitialAdmin(db,{username:'admin',name:'排序管理员',password:'test-administrator-password-2026'},now);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:'test-administrator-password-2026'}});expect(login.statusCode).toBe(200);
  const session=login.json().data,cookie=String(login.headers['set-cookie']).split(';')[0]!,headers={cookie,'x-csrf-token':session.csrfToken,'idempotency-key':randomUUID(),'x-demo-actor':'chen'};
  const p=(await app.inject({url:`${prefix}/gantt`,headers:{cookie}})).json().data as ProjectPlan;
  const payload={expectedOrderVersion:1,orders:[{...p.siblingOrders[0]!,nodeIds:[...p.siblingOrders[0]!.nodeIds].reverse()}]};
  expect((await app.inject({method:'POST',url:`${prefix}/plan/order`,headers,payload})).statusCode).toBe(200);
  expect(JSON.parse((db.prepare('SELECT snapshot_json FROM plan_history ORDER BY rowid DESC LIMIT 1').get() as any).snapshot_json).actor).toBe('排序管理员');
  db.prepare("UPDATE auth_users SET system_role='user' WHERE id=?").run(session.user.id);
  db.prepare('INSERT INTO project_user_links VALUES (?,?,?)').run('phase-one','chen',session.user.id);
  expect((await app.inject({method:'POST',url:`${prefix}/plan/order`,headers,payload})).statusCode).toBe(403);
  db.prepare("UPDATE project_members SET role='project_admin' WHERE id='chen'").run();
  expect((await app.inject({method:'POST',url:`${prefix}/plan/order`,headers:{...headers,'idempotency-key':randomUUID()},payload:{...payload,expectedOrderVersion:2}})).statusCode).toBe(200);
  db.prepare("UPDATE project_members SET role='viewer' WHERE id='chen'").run();
  expect((await app.inject({method:'POST',url:`${prefix}/plan/order`,headers,payload})).statusCode).toBe(403);
  db.prepare('UPDATE auth_users SET active=0 WHERE id=?').run(session.user.id);
  expect((await app.inject({method:'POST',url:`${prefix}/plan/order`,headers,payload})).statusCode).toBe(401);
 });
});

test('canonical preorder handles 5000 rows, stale references, cycles and root ordering',()=>{
 const node=(id:string,parentId:string|null)=>({id,parentId} as PlanNode);
 const nodes=[node('root-a',null),...Array.from({length:5000},(_,i)=>node(`n${i}`,i===0?'root-a':`n${i-1}`)),node('root-b',null),node('orphan','missing'),node('cycle-a','cycle-b'),node('cycle-b','cycle-a')];
 const before=JSON.stringify(nodes),ordered=orderPlanNodes(nodes,[{parentId:'root-a',nodeIds:['unknown','n0','n0']},{parentId:'cycle-a',nodeIds:['cycle-b']}]);
 expect(ordered).toHaveLength(nodes.length);expect(new Set(ordered.map(n=>n.id)).size).toBe(nodes.length);expect(ordered.slice(0,3).map(n=>n.id)).toEqual(['root-a','n0','n1']);expect(ordered[5001]!.id).toBe('root-b');expect(JSON.stringify(nodes)).toBe(before);
});
