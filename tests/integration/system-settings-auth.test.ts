import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/src/app.js';
import type Database from 'better-sqlite3';
import { openHomepageDatabase } from '../../server/src/db/connection.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
describe('system administrator settings routes require real session and write protection',()=>{
 let directory:string, db:Database.Database, app:FastifyInstance, cookie:string, csrf:string, accountId:string;
 const path='/api/v1/admin/settings';const payload={expectedVersion:1,mode:'generate'};
 const headers=()=>({cookie,'x-csrf-token':csrf,origin:'http://localhost:5174','idempotency-key':randomUUID()});
 beforeEach(async()=>{
  directory=mkdtempSync(join(tmpdir(),'goodwork-system-auth-'));db=openHomepageDatabase(join(directory,'test.db'));
  const clock=()=>new Date('2026-09-09T12:00:00Z');
  app=buildApp({dbPath:join(directory,'test.db'),clock,snapshotIntervalMs:0,riskIntervalMs:0,jobIntervalMs:0});
  const user=await createInitialAdmin(db,{username:'admin',name:'系统管理员',password:'long-testing-password-2026'},clock());accountId=user.id;
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:'long-testing-password-2026'}});
  expect(login.statusCode,login.body).toBe(200);cookie=String(login.headers['set-cookie']).split(';')[0]!;csrf=login.json().data.csrfToken;
 });
 afterEach(async()=>{await app.close();db.close();rmSync(directory,{recursive:true,force:true});});
 test('anonymous and forged legacy headers cannot read status/audit or write',async()=>{
  for(const url of [path,`${path}/audit`])expect((await app.inject({url,headers:{'x-demo-actor':'admin'}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:`${path}/feishu-key`,headers:{'x-demo-actor':'admin'},payload})).statusCode).toBe(401);
  expect(existsSync(join(directory,'system-secrets'))).toBe(false);
 });
 test('ordinary member, disabled admin, password-change-required admin and expired session cannot access settings',async()=>{
  for(const [sql,status] of [["UPDATE auth_users SET system_role='user'",403],["UPDATE auth_users SET system_role='admin',must_change_password=1",403],["UPDATE auth_users SET must_change_password=0,active=0",401],["UPDATE auth_users SET active=1; UPDATE auth_sessions SET expires_at=0",401]] as const){
   db.exec(sql);
   for(const url of [path,`${path}/audit`])expect((await app.inject({url,headers:{cookie}})).statusCode).toBe(status);
   expect((await app.inject({method:'POST',url:`${path}/feishu-key`,headers:headers(),payload})).statusCode).toBe(status);
  }
  expect(existsSync(join(directory,'system-secrets'))).toBe(false);
 });
 test('a linked project manager remains forbidden from system settings',async()=>{
  db.prepare("UPDATE auth_users SET system_role='user' WHERE id=?").run(accountId);
  const manager=db.prepare("SELECT project_id,id FROM project_members WHERE role='manager' AND active=1 LIMIT 1").get() as {project_id:string;id:string};
  db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run(manager.project_id,manager.id,accountId);
  const session=await app.inject({url:'/api/v1/auth/session',headers:{cookie}});expect(session.json().data.projects[0].role).toBe('manager');
  for(const url of [path,`${path}/audit`])expect((await app.inject({url,headers:{cookie}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:`${path}/feishu-key`,headers:headers(),payload})).statusCode).toBe(403);
 });
 test('rejects missing/invalid CSRF and foreign Origin before mutation',async()=>{
  for(const bad of [{...headers(),'x-csrf-token':''},{...headers(),'x-csrf-token':'wrong'},{...headers(),origin:'https://evil.test'}]){
   const response=await app.inject({method:'POST',url:`${path}/feishu-key`,headers:bad,payload});expect(response.statusCode,response.body).toBe(403);
  }
  expect(existsSync(join(directory,'system-secrets'))).toBe(false);
  const read=await app.inject({url:path,headers:{cookie}});expect(read.statusCode).toBe(200);expect(read.headers['cache-control']).toBe('no-store');
 });
 test('authorized save/replay returns status only and records authenticated actor',async()=>{
  const requestHeaders=headers();const response=await app.inject({method:'POST',url:`${path}/feishu-key`,headers:requestHeaders,payload});
  expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toMatchObject({state:'ready',version:2,updatedBy:'系统管理员'});expect(response.headers['cache-control']).toBe('no-store');
  const replay=await app.inject({method:'POST',url:`${path}/feishu-key`,headers:requestHeaders,payload});expect(replay.statusCode).toBe(200);
  const audit=await app.inject({url:`${path}/audit`,headers:{cookie}});expect(audit.json().data.total).toBe(1);expect(audit.json().data.items[0].actor).toBe('系统管理员');
  const stored=db.prepare('SELECT account_id FROM system_settings_receipts').get() as {account_id:string};expect(stored.account_id).toBe(accountId);
  for(const method of ['DELETE','PATCH'] as const)expect((await app.inject({method,url:`${path}/feishu-key`,headers:headers(),payload:{key:'never-persist'}})).statusCode).toBe(404);
 });
 test('backup and rotate enforce authentication, system role, CSRF and explicit confirmation',async()=>{
  await app.inject({method:'POST',url:`${path}/feishu-key`,headers:headers(),payload});
  const actions=[{url:`${path}/feishu-key/backup`,payload:{expectedVersion:2,confirmed:true}},{url:`${path}/feishu-key`,payload:{expectedVersion:2,mode:'rotate',confirmed:true}}];
  for(const action of actions){
   expect((await app.inject({method:'POST',...action})).statusCode).toBe(401);
   for(const bad of [{...headers(),'x-csrf-token':''},{...headers(),origin:'https://evil.test'}])expect((await app.inject({method:'POST',...action,headers:bad})).statusCode).toBe(403);
   db.exec("UPDATE auth_users SET system_role='user'");expect((await app.inject({method:'POST',...action,headers:headers()})).statusCode).toBe(403);db.exec("UPDATE auth_users SET system_role='admin'");
   expect((await app.inject({method:'POST',url:action.url,payload:{...action.payload,confirmed:false},headers:headers()})).statusCode).toBe(422);
  }
  expect((await app.inject({url:path,headers:{cookie}})).json().data.version).toBe(2);
 });
 test('authorized backup has no-store and audit; rotation yields different backup without plaintext status',async()=>{
  await app.inject({method:'POST',url:`${path}/feishu-key`,headers:headers(),payload});
  const backup=await app.inject({method:'POST',url:`${path}/feishu-key/backup`,headers:headers(),payload:{expectedVersion:2,confirmed:true}});
  expect(backup.statusCode,backup.body).toBe(200);expect(backup.headers['cache-control']).toBe('no-store');const original=backup.json().data.key;expect(Buffer.from(original,'base64')).toHaveLength(32);
  const rotate=await app.inject({method:'POST',url:`${path}/feishu-key`,headers:headers(),payload:{expectedVersion:2,mode:'rotate',confirmed:true}});expect(rotate.statusCode,rotate.body).toBe(200);expect(rotate.json().data.version).toBe(3);expect(rotate.body).not.toContain(original);
  const next=await app.inject({method:'POST',url:`${path}/feishu-key/backup`,headers:headers(),payload:{expectedVersion:3,confirmed:true}});expect(next.json().data.key).not.toBe(original);
  const audit=await app.inject({url:`${path}/audit`,headers:{cookie}});expect(audit.json().data.total).toBe(4);expect(audit.body).not.toContain(original);expect(audit.body).not.toContain(next.json().data.key);
 });

});
