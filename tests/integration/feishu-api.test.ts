import { beforeEach, afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import { buildApp } from '../../server/src/app.js';
import { createFeishuRunner, enqueueFeishuTest } from '../../server/src/modules/feishu/engine.js';
import { issueSession, publicUser, userById } from '../../server/src/modules/auth/store.js';
import { defaultFeishuRule, type FeishuWorkspace } from '../../shared/src/feishu.js';
const prefix='/api/v1/projects/phase-one/integrations/feishu';
const masterKey=Buffer.alloc(32,7).toString('base64');
const webhook='https://open.feishu.cn/open-apis/bot/v2/hook/12345678-abcd-1234-abcd-123456789abc';
const bot={name:'测试机器人',groupName:'测试群',webhook,signatureEnabled:true,secret:'secret-not-for-logs',keyword:'GoodWork'};
describe('Feishu API configuration lifecycle',()=>{
 let app:FastifyInstance,db:Database.Database,dir:string,now:Date,sent:unknown[];
 beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'feishu-api-'));now=new Date('2026-09-09T02:00:00Z');sent=[];app=buildLegacyApp({dbPath:join(dir,'test.sqlite'),clock:()=>now,jobIntervalMs:0,riskIntervalMs:0,snapshotIntervalMs:0,feishu:{masterKey,intervalMs:0}});db=new Database(join(dir,'test.sqlite'));});
 afterEach(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 async function workspace(actor='zhou'){const r=await app.inject({url:prefix,headers:{'x-demo-actor':actor}});expect(r.statusCode,r.body).toBe(200);return r.json().data as FeishuWorkspace;}
 async function write(path:string,data:object={},actor='zhou',key=randomUUID()){const w=await workspace();return app.inject({method:'POST',url:prefix+path,headers:{'x-demo-actor':actor,'x-preview-token':w.writeToken,'idempotency-key':key},payload:{expectedVersion:w.version,...data}});}
 async function sendTests(){const runner=createFeishuRunner(db,{masterKey,clock:()=>now,intervalMs:0,transport:async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({code:0}),{status:200});}});await runner.runDueJobs();await runner.stop();}
 async function readyBot(){expect((await write('/bots',{bot})).statusCode).toBe(200);const id=(await workspace()).bots[0]!.id;expect((await write(`/bots/${id}/test`,{confirmed:true})).statusCode).toBe(200);await sendTests();expect((await write(`/bots/${id}/confirm`,{confirmed:true})).statusCode).toBe(200);return id;}
 test('saving never sends; successful test and human group confirmation gate enabling',async()=>{
  const plan=db.prepare('SELECT version FROM plan_projects').all();
  const id=(await write('/bots',{bot})).json().data.bots[0].id;
  expect(sent).toHaveLength(0);expect(db.prepare('SELECT * FROM feishu_deliveries').all()).toHaveLength(0);
  expect((await write(`/bots/${id}/confirm`,{confirmed:true})).statusCode).toBe(422);
  const draft={...defaultFeishuRule('task_event'),botIds:[id]};let r=await write('/rules',{rule:draft});expect(r.statusCode,r.body).toBe(200);const ruleId=r.json().data.rules[0].id;
  expect((await write(`/rules/${ruleId}/enable`,{confirmed:true})).statusCode).toBe(422);
  expect((await write(`/bots/${id}/test`,{confirmed:false})).statusCode).toBe(422);
  expect((await write(`/bots/${id}/test`,{confirmed:true})).statusCode).toBe(200);await sendTests();expect(sent).toHaveLength(1);
  expect((await workspace()).bots[0]?.testedAt).toBeTruthy();expect((await workspace()).bots[0]?.confirmedAt).toBeNull();
  expect((await write(`/bots/${id}/confirm`,{confirmed:true})).statusCode).toBe(200);
  expect((await write(`/rules/${ruleId}/enable`,{confirmed:true})).statusCode).toBe(200);
  expect((await workspace()).rules[0]?.status).toBe('enabled');expect(db.prepare('SELECT version FROM plan_projects').all()).toEqual(plan);
  const serialized=JSON.stringify((await workspace()));expect(serialized).not.toContain(bot.secret);expect(serialized).not.toContain(webhook);
  const allStored=['feishu_bots','feishu_receipts','background_jobs','feishu_audit','feishu_deliveries'].map(t=>JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('');expect(allStored).not.toContain(bot.secret);expect(allStored).not.toContain(webhook);
 });
 test('same request retries are idempotent, changed payload and stale config do not overwrite',async()=>{
  const w=await workspace(),key=randomUUID(),headers={'x-demo-actor':'zhou','x-preview-token':w.writeToken,'idempotency-key':key},payload={expectedVersion:w.version,bot};
  const a=await app.inject({method:'POST',url:prefix+'/bots',headers,payload});expect(a.statusCode,a.body).toBe(200);
  const b=await app.inject({method:'POST',url:prefix+'/bots',headers,payload});expect(b.statusCode).toBe(200);expect(b.json().data.bots).toHaveLength(1);
  expect((await app.inject({method:'POST',url:prefix+'/bots',headers,payload:{...payload,bot:{...bot,name:'other'}}})).statusCode).toBe(409);
  expect((await app.inject({method:'POST',url:prefix+'/bots',headers:{...headers,'idempotency-key':randomUUID()},payload})).statusCode).toBe(409);
 });
 test('manager-only config and authenticated write protections reject forged writes',async()=>{
  for(const actor of ['chen','xu','unknown'])expect((await app.inject({url:prefix,headers:{'x-demo-actor':actor}})).statusCode).toBe(403);
  expect((await write('/bots',{bot},'chen')).statusCode).toBe(403);
  const w=await workspace();expect((await app.inject({method:'POST',url:prefix+'/bots',headers:{'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{expectedVersion:w.version,bot}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:prefix+'/bots',headers:{'x-demo-actor':'zhou','x-preview-token':w.writeToken,'idempotency-key':randomUUID(),origin:'https://evil.test'},payload:{expectedVersion:w.version,bot}})).statusCode).toBe(403);
  expect((await app.inject({url:prefix.replace('phase-one','missing'),headers:{'x-demo-actor':'zhou'}})).statusCode).toBe(404);
 });
 test('unconfirmed work calendar, invalid filters, and foreign bot IDs fail without writes',async()=>{
  const id=await readyBot();
  const draft={...defaultFeishuRule(),botIds:[id]};const r=await write('/rules',{rule:draft});expect(r.statusCode,r.body).toBe(200);
  expect((await write(`/rules/${r.json().data.rules[0].id}/enable`,{confirmed:true})).statusCode).toBe(422);
  for(const rule of [{...draft,botIds:['foreign-bot']},{...draft,ownerIds:['foreign-owner']},{...draft,workstreamIds:['foreign-group']},{...draft,schedule:{...draft.schedule,time:'25:00'}},{...draft,days:-1}])expect((await write('/rules',{rule})).statusCode).toBe(422);
  expect((await app.inject({url:prefix+'/deliveries?pageSize=10000',headers:{'x-demo-actor':'zhou'}})).statusCode).toBe(422);
 });
 test('credential replacement invalidates test and group confirmation and pauses dependent rules',async()=>{
  const id=await readyBot();const r=await write('/rules',{rule:{...defaultFeishuRule('task_event'),botIds:[id]}});const rid=r.json().data.rules[0].id;
  expect((await write(`/rules/${rid}/enable`,{confirmed:true})).statusCode).toBe(200);
  const next=await write(`/bots/${id}`,{bot:{...bot,webhook:webhook.replace('123456789abc','123456789abd')}});expect(next.statusCode,next.body).toBe(200);
  expect(next.json().data.bots[0]).toMatchObject({testedAt:null,confirmedAt:null});expect(next.json().data.rules[0].status).toBe('paused');
  expect((await write(`/rules/${rid}/enable`,{confirmed:true})).statusCode).toBe(422);
 });
 test('missing key leaves read-only setup usable and original app healthy',async()=>{
  const isolated=buildLegacyApp({dbPath:':memory:',jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0,feishu:{masterKey:'',intervalMs:0}});
  try{const r=await isolated.inject({url:prefix,headers:{'x-demo-actor':'zhou'}});expect(r.statusCode,r.body).toBe(200);expect(r.json().data.available).toBe(false);expect((await isolated.inject('/health/ready')).statusCode).toBe(200);
   const w=r.json().data;expect((await isolated.inject({method:'POST',url:prefix+'/bots',headers:{'x-demo-actor':'zhou','x-preview-token':w.writeToken,'idempotency-key':randomUUID()},payload:{expectedVersion:w.version,bot}})).statusCode).toBe(422);
  }finally{await isolated.close();}
 });
 test('metadata rename preserves delivery version, rule lifecycle and preferences stay independent of planning',async()=>{
  const id=await readyBot(),before=(await workspace()).bots[0]!;
  const renamed=await write(`/bots/${id}`,{bot:{name:'执行提醒',groupName:bot.groupName,signatureEnabled:true,keyword:bot.keyword}});
  expect(renamed.statusCode,renamed.body).toBe(200);expect(renamed.json().data.bots[0].version).toBe(before.version);expect(renamed.json().data.bots[0].testedAt).toBe(before.testedAt);
  const created=await write('/rules',{rule:{...defaultFeishuRule('task_event'),botIds:[id]}});const rid=created.json().data.rules[0].id;
  expect((await write(`/rules/${rid}/enable`,{confirmed:true})).statusCode).toBe(200);
  expect((await write(`/rules/${rid}/pause`,{confirmed:true})).statusCode).toBe(200);
  expect((await write(`/rules/${rid}/copy`,{confirmed:true})).json().data.rules).toHaveLength(2);
  expect((await write(`/rules/${rid}/archive`,{confirmed:true})).statusCode).toBe(200);
  expect((await write(`/rules/${rid}/enable`,{confirmed:true})).statusCode).toBe(422);
  const plan=db.prepare('SELECT version FROM plan_projects').all();
  const prefs=await write('/preferences',{preferences:{quietEnabled:true,quietStart:'21:00',quietEnd:'08:30'},confirmed:true});
  expect(prefs.statusCode,prefs.body).toBe(200);expect(prefs.json().data.preferences.quietStart).toBe('21:00');expect(db.prepare('SELECT version FROM plan_projects').all()).toEqual(plan);
 });
 test('delivery detail remains available beyond the first 100 records and preserves project boundary',async()=>{
  const id=await readyBot();const first=(db.prepare('SELECT id FROM feishu_deliveries').get() as {id:string}).id;
  for(let n=0;n<105;n++)enqueueFeishuTest(db,'phase-one',id,'测试管理员',new Date(now.getTime()+n+1));
  const list=await app.inject({url:prefix+'/deliveries?pageSize=100',headers:{'x-demo-actor':'zhou'}});expect(list.json().data.items).toHaveLength(100);expect(list.json().data.total).toBe(106);
  const r=await app.inject({url:prefix+'/deliveries/'+first,headers:{'x-demo-actor':'zhou'}});expect(r.statusCode,r.body).toBe(200);expect(r.json().data.id).toBe(first);
  expect((await app.inject({url:prefix.replace('phase-one','missing')+'/deliveries/'+first,headers:{'x-demo-actor':'zhou'}})).statusCode).toBe(404);
 });
 test('real sessions override spoofed actor and enforce CSRF and immediate revocation',async()=>{
  await app.close();app=buildApp({dbPath:join(dir,'test.sqlite'),clock:()=>now,jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0,feishu:{masterKey,intervalMs:0}});
  const at=now.toISOString();
  for(const [id,role] of [['test-admin','admin'],['test-member','user']])db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,id,id,role,1,1,0,1,'test-unused-hash',at,at);
  db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','chen','test-member');
  const admin=issueSession(db,publicUser(userById(db,'test-admin')!),now),member=issueSession(db,publicUser(userById(db,'test-member')!),now);
  const adminHeaders={cookie:`goodwork_session=${admin.token}`,'x-demo-actor':'chen'};
  expect((await app.inject({url:prefix})).statusCode).toBe(401);
  const r=await app.inject({url:prefix,headers:adminHeaders});expect(r.statusCode,r.body).toBe(200);
  expect((await app.inject({url:prefix,headers:{cookie:`goodwork_session=${member.token}`,'x-demo-actor':'zhou'}})).statusCode).toBe(403);
  const payload={expectedVersion:r.json().data.version,bot};
  expect((await app.inject({method:'POST',url:prefix+'/bots',headers:{...adminHeaders,'x-preview-token':r.json().data.writeToken,'idempotency-key':randomUUID()},payload})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:prefix+'/bots',headers:{...adminHeaders,'x-csrf-token':admin.record.csrfToken,'idempotency-key':randomUUID()},payload})).statusCode).toBe(200);
  const created=await app.inject({method:'POST',url:'/api/v1/projects',headers:{...adminHeaders,'x-csrf-token':admin.record.csrfToken,'idempotency-key':randomUUID()},payload:{name:'隔离项目',goal:'验证通知配置隔离',start:'2026-09-09',end:'2026-12-31'}});
  expect(created.statusCode,created.body).toBe(200);const otherPrefix=prefix.replace('phase-one',created.json().data.id);
  const other=(await app.inject({url:otherPrefix,headers:adminHeaders})).json().data;expect(other.bots).toHaveLength(0);
  const existing=(await app.inject({url:prefix,headers:adminHeaders})).json().data.bots[0].id;
  expect((await app.inject({method:'POST',url:otherPrefix+'/bots/'+existing+'/pause',headers:{...adminHeaders,'x-csrf-token':admin.record.csrfToken,'idempotency-key':randomUUID()},payload:{expectedVersion:other.version,confirmed:true}})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:otherPrefix+'/rules',headers:{...adminHeaders,'x-csrf-token':admin.record.csrfToken,'idempotency-key':randomUUID()},payload:{expectedVersion:other.version,rule:{...defaultFeishuRule('task_event'),botIds:[existing]}}})).statusCode).toBe(422);
  db.prepare("UPDATE auth_users SET active=0 WHERE id='test-admin'").run();
  expect((await app.inject({url:prefix,headers:adminHeaders})).statusCode).toBe(401);
 });
});
