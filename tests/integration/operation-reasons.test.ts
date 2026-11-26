import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app.js';
let app: FastifyInstance, directory: string;
const prefix='/api/v1/projects/phase-one';
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'operation-reasons-'));app=buildLegacyApp({dbPath:join(directory,'test.sqlite'),clock:()=>new Date('2026-09-23T02:00:00Z'),snapshotIntervalMs:0,riskIntervalMs:0,jobIntervalMs:0});});
afterEach(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
async function read(path:string){const r=await app.inject(prefix+path);expect(r.statusCode,r.body).toBe(200);return r.json().data;}
async function send(path:string,body:object,actor='zhou',method:'POST'|'PATCH'='POST',key=randomUUID()){const w=await read('/settings');return app.inject({method,url:prefix+path,headers:{'x-preview-token':w.writeToken,'x-demo-actor':actor,'idempotency-key':key},payload:body});}
test('ordinary workgroup writes omit reasons but retain audit and replay',async()=>{
 let w=await read('/workstreams');const body={expectedVersion:w.version,expectedPlanVersion:w.planVersion,workstream:{name:'分级测试组',description:'虚构',ownerId:null,color:'blue'}},key=randomUUID();
 const r=await send('/workstreams',body,'zhou','POST',key);expect(r.statusCode,r.body).toBe(200);w=r.json().data;expect(w.history[0]).toMatchObject({actor:'zhou',action:'workstream.create'});expect(w.history[0].reason).toContain('新增');expect((await send('/workstreams',body,'zhou','POST',key)).json()).toEqual(r.json());
 const group=w.workstreams.find((g:any)=>g.name==='分级测试组');const status=await send(`/workstreams/${group.id}/status`,{expectedVersion:w.version,expectedPlanVersion:w.planVersion,active:false,reason:''});expect(status.statusCode,status.body).toBe(200);w=status.json().data;
 for(const reason of [null,123,{},'x'.repeat(501)])expect((await send(`/workstreams/${group.id}/move`,{expectedVersion:w.version,expectedPlanVersion:w.planVersion,direction:'up',reason})).statusCode).toBe(422);
});
test('daily settings need no reason; permission changes require one using stored role',async()=>{
 let w=await read('/settings');let r=await send('/settings/calendar',{expectedVersion:w.version,expectedPlanVersion:w.planVersion,calendar:{...w.calendar,confirmed:true}});expect(r.statusCode,r.body).toBe(200);w=r.json().data;
 r=await send('/settings/member_create',{expectedVersion:w.version,expectedPlanVersion:w.planVersion,member:{name:'分级成员甲',role:'member',active:true}});expect(r.statusCode,r.body).toBe(200);w=r.json().data;const m=w.members.find((m:any)=>m.name==='分级成员甲');
 for(const patch of [{role:'project_admin'},{active:false}])for(const reason of [undefined,'   ']){const r=await send('/settings/member_update',{expectedVersion:w.version,expectedPlanVersion:w.planVersion,member:{id:m.id,name:m.name,role:m.role,active:m.active,...patch},...(reason===undefined?{}:{reason})});expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('REASON_REQUIRED');}
 r=await send('/settings/member_update',{expectedVersion:w.version,expectedPlanVersion:w.planVersion,member:{id:m.id,name:m.name,role:m.role,active:false},reason:'暂停参与'});expect(r.statusCode,r.body).toBe(200);w=r.json().data;
 r=await send('/settings/member_update',{expectedVersion:w.version,expectedPlanVersion:w.planVersion,member:{id:m.id,name:m.name,role:m.role,active:true}});expect(r.statusCode,r.body).toBe(200);
});
async function task(review=false,ownerId='chen',reviewerId:string|null=null){const w=await read('/tasks');const r=await send('/tasks',{expectedPlanVersion:w.planVersion,title:'分级虚构任务',description:'',workstreamId:w.workstreams[0].id,parentId:null,ownerId,priority:'P1',effortHours:8,requiresReview:review,reviewerId,acceptanceCriteria:review?'成果可核对':'',evidence:'',start:null,end:null});expect(r.statusCode,r.body).toBe(200);return r.json().data.task;}
async function transition(id:string,action:string,extra:object={},actor='chen',fast=false){const w=await read('/tasks'),t=w.tasks.find((t:any)=>t.id===id);return send(`/tasks/${id}/transition`,{expectedVersion:t.version,expectedPlanVersion:w.planVersion,...(fast?{expectedStructureVersion:w.structureVersion}:{}),action,...extra},actor);}
test('task fast/full paths and optional block notes omit reasons; reopening remains protected',async()=>{
 const t=await task();let r=await transition(t.id,'start',{},'chen',true);expect(r.statusCode,r.body).toBe(200);
 r=await transition(t.id,'progress',{progress:40},'chen',true);expect(r.statusCode,r.body).toBe(200);expect(r.json().data.task.events.at(-1).text).toContain('40%');
 r=await transition(t.id,'block');expect(r.statusCode,r.body).toBe(200);expect(r.json().data.task).toMatchObject({blocked:true,blockReason:''});
 r=await transition(t.id,'unblock',{reason:'依赖已恢复'});expect(r.statusCode,r.body).toBe(200);expect(r.json().data.task.events.at(-1).text).toContain('依赖已恢复');
 r=await transition(t.id,'progress',{progress:60});expect(r.statusCode,r.body).toBe(200);
 r=await transition(t.id,'complete');expect(r.statusCode,r.body).toBe(200);
 r=await transition(t.id,'reopen',{progress:0},'zhou');expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('REASON_REQUIRED');
});
test('independent reviews omit opinions but self review cannot omit its reason',async()=>{
 for(const action of ['accept','reject']){const t=await task(true,'chen','lin');expect((await transition(t.id,'start')).statusCode).toBe(200);const submitted=await transition(t.id,'submit',{evidence:'虚构成果说明'});expect(submitted.statusCode,submitted.body).toBe(200);const r=await transition(t.id,action,{submissionId:submitted.json().data.task.submissions.at(-1).id},'lin');expect(r.statusCode,r.body).toBe(200);expect(r.json().data.task.submissions.at(-1).comment).toBe('');}
 const t=await task(true,'zhou','zhou');expect((await transition(t.id,'start',{},'zhou')).statusCode).toBe(200);const submitted=await transition(t.id,'submit',{evidence:'虚构自验成果'},'zhou');expect(submitted.statusCode,submitted.body).toBe(200);const r=await transition(t.id,'accept',{submissionId:submitted.json().data.task.submissions.at(-1).id},'zhou');expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('REASON_REQUIRED');
});
test('risk maintenance omits reasons while acceptance and closure require them',async()=>{
 const settings=await read('/settings'); const promoted=await send('/settings/member_update',{expectedVersion:settings.version,expectedPlanVersion:settings.planVersion,member:{id:'lin',name:'林若宁',role:'project_admin',active:true},reason:'配置实际管理复核职责'});expect(promoted.statusCode,promoted.body).toBe(200);
 const w=await read('/risks'),draft={title:'分级风险',description:'虚构',workstreamId:w.workstreams[0].id,ownerId:'lin',probability:3,impact:3,due:'2026-10-01',reviewDate:null,response:'检查交付',taskIds:[],closeReviewerId:null};let r=await send('/risks',draft);expect(r.statusCode,r.body).toBe(200);let risk=r.json().data.risk;
 r=await send(`/risks/${risk.id}`,{...draft,title:'修改风险',expectedVersion:risk.version},'lin','PATCH');expect(r.statusCode,r.body).toBe(200);risk=r.json().data.risk;
 for(const action of ['assess','mitigate','monitor']){r=await send(`/risks/${risk.id}/transition`,{expectedVersion:risk.version,action},'lin');expect(r.statusCode,r.body).toBe(200);risk=r.json().data.risk;}
 for(const action of ['accept','submit_close']){r=await send(`/risks/${risk.id}/transition`,{expectedVersion:risk.version,action,reviewDate:'2026-10-05'},'lin');expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('REASON_REQUIRED');}
 r=await send(`/risks/${risk.id}/transition`,{expectedVersion:risk.version,action:'submit_close',reason:'处置完成'},'lin');expect(r.statusCode,r.body).toBe(200);risk=r.json().data.risk;
 r=await send(`/risks/${risk.id}/transition`,{expectedVersion:risk.version,action:'approve_close'},'zhou');expect(r.statusCode,r.body).toBe(422);
 r=await send(`/risks/${risk.id}/transition`,{expectedVersion:risk.version,action:'reject_close'},'lin');expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('REASON_REQUIRED');
 r=await send(`/risks/${risk.id}/transition`,{expectedVersion:risk.version,action:'reject_close'},'zhou');expect(r.statusCode,r.body).toBe(200);
});

test('ordinary scheduling previews omit reasons, preserve invalid-date validation, and baseline publication remains protected',async()=>{
 const w=await read('/gantt');const node=w.nodes.find((n:any)=>n.id==='task-006');
 const r=await send('/schedule/preview',{expectedPlanVersion:w.planVersion,changes:[{taskId:node.id,start:node.start,end:node.end}],dependencyTargetId:node.id,incomingDependencies:w.dependencies.filter((d:any)=>d.successorId===node.id),mode:'push_successors'});
 expect(r.statusCode,r.body).toBe(200);expect(r.json().data.reason).toContain('调整');
 const invalid=await send('/schedule/preview',{expectedPlanVersion:w.planVersion,changes:[{taskId:node.id,start:'invalid',end:node.end}],mode:'push_successors'});expect(invalid.statusCode,invalid.body).toBe(422);
 const baseline=await send('/baselines',{expectedPlanVersion:w.planVersion,name:'缺少原因基线',calendarConfirmed:true,excludedIds:[],exclusionReason:''});expect(baseline.statusCode,baseline.body).toBe(422);expect(baseline.json().error.code).toBe('REASON_REQUIRED');
});
