import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import { createFeishuRunner, enqueueFeishuTest, listFeishuDeliveries } from '../../server/src/modules/feishu/engine.js';
import type { FastifyInstance } from 'fastify';
const dirs:string[]=[],apps:FastifyInstance[]=[],dbs:Database.Database[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const db of dbs.splice(0))db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const prefix='/api/v1/projects/phase-one/integrations/feishu';
const key=Buffer.alloc(32,17).toString('base64');
const bot={name:'隔离测试机器人',groupName:'隔离测试群',webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/isolated-12345678',signatureEnabled:false,keyword:''};
function fixture(getMasterKey:()=>string|undefined){const dir=mkdtempSync(join(tmpdir(),'feishu-provider-'));dirs.push(dir);const dbPath=join(dir,'fixture.sqlite');const app=buildLegacyApp({dbPath,jobIntervalMs:0,riskIntervalMs:0,snapshotIntervalMs:0,feishu:{getMasterKey,intervalMs:0}});apps.push(app);const db=new Database(dbPath);dbs.push(db);return {app,db};}
async function workspace(app:FastifyInstance){const res=await app.inject({url:prefix,headers:{'x-demo-actor':'zhou'}});expect(res.statusCode,res.body).toBe(200);return res.json().data;}
test('existing app reads a newly available key without restart and encrypts new credentials',async()=>{let material:string|undefined;const {app,db}=fixture(()=>material);expect((await workspace(app)).available).toBe(false);material=key;const current=await workspace(app);expect(current.available).toBe(true);const result=await app.inject({method:'POST',url:prefix+'/bots',headers:{'x-demo-actor':'zhou','x-preview-token':current.writeToken,'idempotency-key':'dynamic-key-create-bot'},payload:{expectedVersion:current.version,bot}});expect(result.statusCode,result.body).toBe(200);expect(JSON.stringify(db.prepare('SELECT * FROM feishu_bots').all())).not.toContain(bot.webhook);material=undefined;expect((await workspace(app)).available).toBe(false);});
test('an existing delivery runner resumes only after its key provider becomes available',async()=>{let material:string|undefined=key;const {app,db}=fixture(()=>material);const current=await workspace(app);const res=await app.inject({method:'POST',url:prefix+'/bots',headers:{'x-demo-actor':'zhou','x-preview-token':current.writeToken,'idempotency-key':'dynamic-key-delivery-bot'},payload:{expectedVersion:current.version,bot}});expect(res.statusCode,res.body).toBe(200);const now=new Date('2026-09-09T02:00:00Z');enqueueFeishuTest(db,'phase-one',res.json().data.bots[0].id,'测试管理员',now);let calls=0;material=undefined;const runner=createFeishuRunner(db,{getMasterKey:()=>material,clock:()=>now,intervalMs:0,transport:async()=>{calls++;return new Response(JSON.stringify({code:0}),{status:200});}});try{await runner.runDueJobs();expect(calls).toBe(0);material=key;await runner.runDueJobs();expect(calls).toBe(1);expect(listFeishuDeliveries(db,'phase-one',{},now).items[0]?.status).toBe('accepted');}finally{await runner.stop();}});
