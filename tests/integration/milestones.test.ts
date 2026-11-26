import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, test, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { Milestone, MilestoneWorkspace } from '../../shared/src/milestones.js';

const prefix='/api/v1/projects/phase-one';
let app:FastifyInstance, db:Database.Database, dir:string, path:string, token:string;
let now = new Date('2026-09-23T06:00:00Z');
beforeEach(async()=>{ now=new Date('2026-09-23T06:00:00Z');dir=await mkdtemp(join(tmpdir(),'goodwork-milestones-'));path=join(dir,'app.sqlite');app=buildLegacyApp({dbPath:path,clock:()=>now,jobIntervalMs:0});db=new Database(path);token=(await app.inject(`${prefix}/gantt`)).json().data.writeToken; });
afterEach(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
async function workspace():Promise<MilestoneWorkspace>{const r=await app.inject(`${prefix}/milestones`);expect(r.statusCode,r.body).toBe(200);return r.json().data;}
async function write(path:string,payload:object,actor='zhou',key=randomUUID(),method:'POST'|'PATCH'='POST'){return app.inject({method,url:prefix+'/milestones'+path,headers:{'x-preview-token':token,'x-demo-actor':actor,'idempotency-key':key},payload});}
async function create(extra:object={},actor='zhou') { const p=(await app.inject(`${prefix}/gantt`)).json().data;return write('',{title:'试点业务可交付',description:'试点用户可完成岗位发布和报名',workstreamId:p.nodes[0].workstreamId,ownerId:'chen',reviewerId:'lin',date:'2026-09-25',criteria:[{id:'evidence-1',title:'试点用户确认通过',kind:'evidence',taskId:null}],expectedPlanVersion:p.planVersion,...extra},actor); }
async function created(extra:object={}) {const r=await create(extra);expect(r.statusCode,r.body).toBe(200);return r.json().data.milestone as Milestone;}
async function current(id:string){return (await workspace()).milestones.find(m=>m.id===id)!;}
async function action(id:string,action:string,extra:object={},actor='chen',key=randomUUID()){const w=await workspace(),m=w.milestones.find(m=>m.id===id)!;return write('/'+id+'/transition',{expectedVersion:m.version,expectedPlanVersion:w.planVersion,action,...extra},actor,key);}
async function delivery(id:string,extra:object={}) {const w=await workspace(),m=w.milestones.find(m=>m.id===id)!;return write('/'+id+'/draft',{expectedVersion:m.version,expectedPlanVersion:w.planVersion,summary:'完成验证，详见试点记录',links:['https://example.com/demo/report'],evidence:[{criterionId:'evidence-1',description:'试点验证全部通过',links:['https://example.com/demo/confirmation'],declared:true}],...extra},'chen');}
async function submitted(extra:object={}) {const m=await created(extra);expect((await delivery(m.id)).statusCode).toBe(200);const r=await action(m.id,'submit');expect(r.statusCode,r.body).toBe(200);return r.json().data.milestone as Milestone;}

test('legacy migration preserves IDs, baseline and raw plan, never fabricates acceptance or people',async()=>{
 const before=db.prepare('SELECT * FROM plan_baselines').all(),nodes=db.prepare('SELECT nodes_json FROM plan_projects').all();
 const w=await workspace();expect(w.milestones.length).toBeGreaterThan(0);const legacy=w.milestones.find(m=>m.legacyStatus==='done')!;
 expect(legacy.state).toBe('legacy_achieved');expect(legacy.acceptedAt).toBeNull();expect(legacy.submissions).toEqual([]);expect(legacy.ownerId).toBe('');expect(legacy.reviewerId).toBe('');expect(legacy.canSubmit).toBe(false);
 await app.close();app=buildLegacyApp({dbPath:path,clock:()=>now,jobIntervalMs:0});
 expect((await workspace()).milestones.map(m=>m.id)).toEqual(w.milestones.map(m=>m.id));expect(db.prepare('SELECT * FROM plan_baselines').all()).toEqual(before);expect(db.prepare('SELECT nodes_json FROM plan_projects').all()).toEqual(nodes);
});
test('only managers create; validates project members, criteria, URLs, date and summary tasks',async()=>{
 expect((await create({},'chen')).statusCode).toBe(403);expect((await create({},'xu')).statusCode).toBe(403);
 for(const extra of [{criteria:[]},{ownerId:'unknown'},{reviewerId:'xu'},{ownerId:'chen',reviewerId:'chen'},{date:'2026-09-26'},{criteria:[{id:'bad',title:'外部任务',kind:'task',taskId:'other-project-task'}]}]) expect((await create(extra)).statusCode).toBe(422);
 const m=await created({date:null});expect(m.canSubmit).toBe(false);expect(m.missing.join('')).toContain('排期');
 expect((await delivery(m.id,{links:['javascript:alert(1)']})).statusCode).toBe(422);
 const w=await workspace();expect(w.tasks.some(t=>t.id===m.id)).toBe(false);expect((await app.inject(`${prefix}/gantt`)).json().data.nodes.find((n:any)=>n.id===m.id)).toMatchObject({kind:'milestone',durationDays:0,effortHours:null});
});
test('mixed task and evidence conditions gate submission, delivery draft is owner-scoped',async()=>{
 const w=await workspace(),task=w.tasks.find(t=>t.status==='in_progress'&&t.taskKind==='execution')!;
 const m=await created({criteria:[{id:'task-1',title:'必要任务',kind:'task',taskId:task.id},{id:'evidence-1',title:'验收报告',kind:'evidence',taskId:null}]});
 expect((await action(m.id,'submit')).statusCode).toBe(422);expect((await delivery(m.id)).statusCode).toBe(200);
 const notReady=await action(m.id,'submit');expect(notReady.statusCode,notReady.body).toBe(422);expect((await current(m.id)).readiness.find(c=>c.criterionId==='task-1')?.ready).toBe(false);
 const ws=await workspace(),before=await current(m.id);const bad=await write('/'+m.id+'/draft',{...before.delivery,expectedVersion:before.version,expectedPlanVersion:ws.planVersion},'lin');expect(bad.statusCode).toBe(403);
});
test('immutable snapshot, per-condition review, independent reviewer and authoritative acceptance time',async()=>{
 const m=await submitted(),s=m.submissions.at(-1)!;expect(s.snapshot.summary).toContain('完成验证');
 expect((await delivery(m.id,{summary:'silent replacement'})).statusCode).toBe(422);
 expect((await action(m.id,'accept',{submissionId:s.id,checkedCriterionIds:['evidence-1']},'chen')).statusCode).toBe(403);
 expect((await action(m.id,'accept',{submissionId:s.id,checkedCriterionIds:[]},'lin')).statusCode).toBe(422);
 const r=await action(m.id,'accept',{submissionId:s.id,checkedCriterionIds:['evidence-1']},'lin');expect(r.statusCode,r.body).toBe(200);
 const accepted=r.json().data.milestone;expect(accepted.state).toBe('accepted');expect(accepted.acceptedAt).toBe(now.toISOString());expect(accepted.submissions[0].snapshot).toEqual(s.snapshot);expect(accepted.submissions[0].reviews[0]).toMatchObject({actorId:'lin',selfReview:false,decision:'accept'});
 expect((await action(m.id,'complete',{},'zhou')).statusCode).toBe(422);
});
test('return selects failed criteria, withdraw/resubmit creates new snapshots, cancellation/restoration preserve history',async()=>{
 let m=await submitted();expect((await action(m.id,'reject',{submissionId:m.submissions[0]!.id,failedCriterionIds:[]},'lin')).statusCode).toBe(422);
 expect((await action(m.id,'reject',{submissionId:m.submissions[0]!.id,failedCriterionIds:['evidence-1']},'lin')).statusCode).toBe(200);
 expect((await current(m.id)).state).toBe('rejected');expect((await delivery(m.id)).statusCode).toBe(200);expect((await action(m.id,'submit')).statusCode).toBe(200);
 expect((await action(m.id,'withdraw')).statusCode).toBe(200);expect((await current(m.id)).submissions[1]!.invalidatedAt).toBe(now.toISOString());
 expect((await action(m.id,'cancel',{},'zhou')).statusCode).toBe(422);expect((await action(m.id,'cancel',{reason:'调整项目范围'},'zhou')).statusCode).toBe(200);
 expect((await action(m.id,'submit')).statusCode).toBe(422);expect((await action(m.id,'restore',{reason:'恢复承诺准备'},'zhou')).statusCode).toBe(200);m=await current(m.id);expect(m.state).toBe('draft');expect(m.submissions).toHaveLength(2);
},15000);
test('manager self-review requires grounds and audit; reopening clears only current acceptance',async()=>{
 let m=await created({ownerId:'zhou',reviewerId:'zhou'});const w=await workspace();
 expect((await write('/'+m.id+'/draft',{expectedVersion:m.version,expectedPlanVersion:w.planVersion,summary:'项目核查通过',links:['https://example.com/report'],evidence:[{criterionId:'evidence-1',description:'核查通过',links:['https://example.com/report'],declared:true}]})).statusCode).toBe(200);
 expect((await action(m.id,'submit',{},'zhou')).statusCode).toBe(200);m=await current(m.id);
 expect((await action(m.id,'accept',{submissionId:m.submissions[0]!.id,checkedCriterionIds:['evidence-1']},'zhou')).statusCode).toBe(422);
 expect((await action(m.id,'accept',{submissionId:m.submissions[0]!.id,checkedCriterionIds:['evidence-1'],reason:'已亲自核对全部试点材料'},'zhou')).statusCode).toBe(200);
 expect((await current(m.id)).submissions[0]!.reviews[0]!.selfReview).toBe(true);
 expect((await action(m.id,'reopen',{reason:'发现证据需要补充'},'zhou')).statusCode).toBe(200);m=await current(m.id);expect(m.state).toBe('needs_review');expect(m.acceptedAt).toBeNull();expect(m.submissions[0]!.reviews[0]!.createdAt).toBe(now.toISOString());
});
test('optimistic concurrency, idempotent replay, permission recheck and transaction rollback',async()=>{
 const m=await submitted(),w=await workspace(),key=randomUUID(),payload={action:'accept',expectedVersion:m.version,expectedPlanVersion:w.planVersion,submissionId:m.submissions[0]!.id,checkedCriterionIds:['evidence-1']};
 const r=await write('/'+m.id+'/transition',payload,'lin',key);expect(r.statusCode,r.body).toBe(200);expect((await write('/'+m.id+'/transition',payload,'lin',key)).json()).toEqual(r.json());
 expect((await write('/'+m.id+'/transition',payload,'lin')).statusCode).toBe(409);
 db.prepare("UPDATE project_members SET role='viewer' WHERE id='lin'").run();expect((await write('/'+m.id+'/transition',payload,'lin',key)).statusCode).toBe(403);
 db.prepare("UPDATE project_members SET role='member' WHERE id='lin'").run();
 const before=db.prepare('SELECT * FROM milestone_records').all();db.exec("CREATE TRIGGER fail_milestone_write BEFORE INSERT ON milestone_records BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;");expect((await create()).statusCode).toBe(500);expect(db.prepare('SELECT * FROM milestone_records').all()).toEqual(before);
});
test('authenticated identity cannot be spoofed and inaccessible project never leaks milestones',async()=>{
 await app.close();app=buildApp({dbPath:path,clock:()=>now,jobIntervalMs:0});
 await createInitialAdmin(db,{username:'milestone-admin',name:'节点管理员',password:'test-milestone-password-2026'},now);
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'milestone-admin',password:'test-milestone-password-2026'}});expect(login.statusCode).toBe(200);const session=login.json().data,cookie=String(login.headers['set-cookie']).split(';')[0]!;
 const get=await app.inject({url:prefix+'/milestones',headers:{cookie}});expect(get.statusCode,get.body).toBe(200);
 db.prepare("UPDATE auth_users SET system_role='user' WHERE id=?").run(session.user.id);db.prepare('INSERT INTO project_user_links VALUES (?,?,?)').run('phase-one','chen',session.user.id);
 const p=get.json().data;const headers={cookie,'x-csrf-token':session.csrfToken,'x-demo-actor':'zhou','idempotency-key':randomUUID()};
 const bad=await app.inject({method:'POST',url:prefix+'/milestones',headers,payload:{title:'伪造管理身份',expectedPlanVersion:p.planVersion}});expect(bad.statusCode).toBe(403);
 expect((await app.inject({url:'/api/v1/projects/not-mine/milestones',headers:{cookie}})).statusCode).toBe(404);
});

test('cancelled nodes can repair responsibility before restore without reactivating or bypassing schedule',async()=>{
 const m=await created();expect((await action(m.id,'cancel',{reason:'暂停范围'},'zhou')).statusCode).toBe(200);
 db.prepare("UPDATE project_members SET active=0 WHERE id='lin'").run();
 expect((await action(m.id,'restore',{reason:'恢复执行'},'zhou')).statusCode).toBe(422);
 const w=await workspace(),old=w.milestones.find(item=>item.id===m.id)!;
 const fields=Object.fromEntries(draftFieldNames.map(key=>[key,old[key]]));
 const repair=await write('/'+m.id,{...fields,reviewerId:'zhou',expectedVersion:old.version,expectedPlanVersion:w.planVersion},'zhou',randomUUID(),'PATCH');
 expect(repair.statusCode,repair.body).toBe(200);expect(repair.json().data.milestone.state).toBe('cancelled');
 expect((await action(m.id,'restore',{reason:'责任已移交，恢复执行'},'zhou')).statusCode).toBe(200);
});
const draftFieldNames=['title','description','workstreamId','ownerId','reviewerId','date','criteria'] as const;

test('accepted scope edits require reason and preserve old snapshot while invalidating current achievement',async()=>{
 let m=await submitted();expect((await action(m.id,'accept',{submissionId:m.submissions[0]!.id,checkedCriterionIds:['evidence-1']},'lin')).statusCode).toBe(200);
 const w=await workspace();m=w.milestones.find(item=>item.id===m.id)!;const previous=m.submissions[0]!.snapshot;
 const payload={...Object.fromEntries(draftFieldNames.map(key=>[key,m[key]])),description:'增加试点覆盖城市',expectedVersion:m.version,expectedPlanVersion:w.planVersion};
 expect((await write('/'+m.id,payload,'zhou',randomUUID(),'PATCH')).statusCode).toBe(422);
 const r=await write('/'+m.id,{...payload,reason:'试点范围新增，重新验收'},'zhou',randomUUID(),'PATCH');expect(r.statusCode,r.body).toBe(200);expect(r.json().data.milestone.state).toBe('needs_review');expect(r.json().data.milestone.acceptedAt).toBeNull();expect(r.json().data.milestone.submissions[0].snapshot).toEqual(previous);
});

test('explicit milestone dependencies block premature acceptance and invalidate downstream acceptance on cancellation',async()=>{
 const a=await created({title:'前置交付'}),b=await created({title:'后置交付'});
 const w=await workspace();
 const preview=await app.inject({method:'POST',url:prefix+'/schedule/preview',headers:{'x-preview-token':token},payload:{expectedPlanVersion:w.planVersion,changes:[],dependencyTargetId:b.id,incomingDependencies:[{predecessorId:a.id,lagDays:0}],mode:'push_successors'}});expect(preview.statusCode,preview.body).toBe(200);
 const apply=await app.inject({method:'POST',url:prefix+'/schedule/apply',headers:{'x-preview-token':token,'idempotency-key':randomUUID()},payload:{previewId:preview.json().data.id,expectedPlanVersion:w.planVersion}});expect(apply.statusCode,apply.body).toBe(200);
 expect((await delivery(b.id)).statusCode).toBe(200);expect((await action(b.id,'submit')).statusCode).toBe(422);expect((await current(b.id)).missing.join('')).toContain('前置');
 expect((await delivery(a.id)).statusCode).toBe(200);expect((await action(a.id,'submit')).statusCode).toBe(200);
 let predecessor=await current(a.id);expect((await action(a.id,'accept',{submissionId:predecessor.submissions.at(-1)!.id,checkedCriterionIds:['evidence-1']},'lin')).statusCode).toBe(200);
 expect((await action(b.id,'submit')).statusCode).toBe(200);const next=await current(b.id);expect((await action(b.id,'accept',{submissionId:next.submissions.at(-1)!.id,checkedCriterionIds:['evidence-1']},'lin')).statusCode).toBe(200);
 expect((await action(a.id,'cancel',{reason:'前置成果作废'},'zhou')).statusCode).toBe(200);
 const after=await current(b.id);expect(after.state).toBe('needs_review');expect(after.acceptedAt).toBeNull();expect(after.submissions.at(-1)!.reviews[0]!.decision).toBe('accept');expect(after.canSubmit).toBe(false);
},20000);

test('moving a milestone preserves its WBS and future creation never reuses that prefix number',async()=>{
 const a=await created(),b=await created(),w=await workspace(),other=w.workstreams.find(s=>s.id!==a.workstreamId&&s.active!==false)!;
 const move=await write('/'+a.id,{...Object.fromEntries(draftFieldNames.map(key=>[key,a[key]])),workstreamId:other.id,expectedVersion:a.version,expectedPlanVersion:w.planVersion},'zhou',randomUUID(),'PATCH');expect(move.statusCode,move.body).toBe(200);
 const c=await created();expect(new Set([a.wbs,b.wbs,c.wbs]).size).toBe(3);expect((await current(a.id)).wbs).toBe(a.wbs);
});

test('task conditions and schedule dependencies cannot create an acceptance deadlock',async()=>{
 const w=await workspace(),task=w.tasks.find(t=>t.status==='in_progress'&&t.taskKind!=='summary'&&!t.requiresReview)!;
 const m=await created({criteria:[{id:'required-task',title:'必要任务完成',kind:'task',taskId:task.id}]});
 const latest=await workspace();
 const preview=await app.inject({method:'POST',url:prefix+'/schedule/preview',headers:{'x-preview-token':token},payload:{expectedPlanVersion:latest.planVersion,changes:[],dependencyTargetId:task.id,incomingDependencies:[{predecessorId:m.id,lagDays:0}],mode:'push_successors'}});
 expect(preview.statusCode,preview.body).toBe(422);expect(preview.json().error.code).toBe('MILESTONE_ACCEPTANCE_CYCLE');
});
