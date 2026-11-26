import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSystemSettingsProvider, type SystemSettingsProvider } from '../../server/src/modules/system-settings/index.js';
import { decryptFeishuCredentials, encryptFeishuCredentials } from '../../server/src/modules/feishu/store.js';
const original=Buffer.alloc(32,7).toString('base64'),identity={accountId:'admin',actor:'系统管理员'};
const rotate={expectedVersion:2,mode:'rotate',confirmed:true},marker='rotate-operation-0001';
const payload={webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh12345678',secret:'group-signing-secret'};
describe('system key backup and safe rotation',()=>{
 let directory:string,db:Database.Database,provider:SystemSettingsProvider,path:string;
 const rows=()=>db.prepare('SELECT * FROM feishu_bots ORDER BY project_id,id').all() as {project_id:string;id:string;credentials_json:string;snapshot_json:string}[];
 beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'goodwork-key-lifecycle-'));path=join(directory,'system-secrets','feishu-master-key.json');db=new Database(join(directory,'test.db'));
  db.exec('CREATE TABLE feishu_bots(project_id TEXT,id TEXT,credentials_json TEXT,snapshot_json TEXT,PRIMARY KEY(project_id,id)); CREATE TABLE feishu_rules(id TEXT,snapshot_json TEXT); CREATE TABLE background_jobs(id TEXT,status TEXT);');
  provider=createSystemSettingsProvider(db);provider.saveFeishuKey({expectedVersion:1,mode:'import',key:original},'initial-operation-001',identity);
  for(const [pid,id] of [['p1','b1'],['p2','b2']])db.prepare('INSERT INTO feishu_bots VALUES(?,?,?,?)').run(pid,id,encryptFeishuCredentials(payload,original,pid!,id!),JSON.stringify({enabled:true,version:3,testedAt:'2026-09-09',confirmedAt:'2026-09-09'}));
  db.exec(`INSERT INTO feishu_rules VALUES('rule1','{"status":"enabled"}');INSERT INTO background_jobs VALUES('pending1','pending');`);
 });
 afterEach(()=>{if(db.open)db.close();rmSync(directory,{recursive:true,force:true});});
 test('backup is explicit and never leaks via status, audit or receipts',()=>{
  expect(provider.readStatus()).toMatchObject({canBackup:true,canRotate:true,credentialCount:2});
  expect(provider.backupFeishuKey({expectedVersion:2,confirmed:true},identity)).toMatchObject({key:original,version:2});
  expect(provider.readStatus().version).toBe(2);expect(provider.readAudit().items[0]).toMatchObject({actor:'系统管理员',action:'备份飞书凭据主密钥'});
  for(const value of [provider.readStatus(),provider.readAudit(),db.prepare('SELECT * FROM system_settings_receipts').all()])expect(JSON.stringify(value)).not.toContain(original);
 });
 test('rotation migrates all projects and survives restart without changing bot/rule/job state',()=>{
  const before=rows();expect(provider.saveFeishuKey(rotate,marker,identity)).toMatchObject({state:'ready',version:3,credentialCount:2});const next=provider.getKey()!;
  expect(next).not.toBe(original);expect(Buffer.from(next,'base64')).toHaveLength(32);
  for(const [i,row] of rows().entries()){
   expect(decryptFeishuCredentials(row.credentials_json,next,row.project_id,row.id)).toEqual(payload);
   expect(()=>decryptFeishuCredentials(row.credentials_json,original,row.project_id,row.id)).toThrow();expect(row.snapshot_json).toBe(before[i]!.snapshot_json);
  }
  expect(db.prepare('SELECT * FROM feishu_rules').all()).toEqual([{id:'rule1',snapshot_json:'{"status":"enabled"}'}]);expect(db.prepare('SELECT * FROM background_jobs').all()).toEqual([{id:'pending1',status:'pending'}]);
  expect(readFileSync(path,'utf8')).not.toContain(original);expect(provider.readAudit().total).toBe(2);
  db.close();db=new Database(join(directory,'test.db'));provider=createSystemSettingsProvider(db);expect(provider.getKey()).toBe(next);
 });
 test('lost response retry does not rotate twice and stale writes/exports conflict',()=>{
  provider.saveFeishuKey(rotate,marker,identity);const key=provider.getKey();expect(provider.saveFeishuKey(rotate,marker,identity).version).toBe(3);expect(provider.getKey()).toBe(key);expect(provider.readAudit().total).toBe(2);
  expect(()=>provider.saveFeishuKey(rotate,'rotate-operation-0002',identity)).toThrow(/已更新/);expect(()=>provider.backupFeishuKey({expectedVersion:2,confirmed:true},identity)).toThrow(/已更新/);
 });
 test('unconfirmed and malformed operations leave ciphertext and key untouched',()=>{
  const before=rows();for(const input of [{...rotate,confirmed:false},{expectedVersion:2,mode:'rotate'},{...rotate,key:original}])expect(()=>provider.saveFeishuKey(input,marker,identity)).toThrow();
  for(const input of [{expectedVersion:2},{expectedVersion:2,confirmed:false},{expectedVersion:2,confirmed:true,key:original},null])expect(()=>provider.backupFeishuKey(input,identity)).toThrow();
  expect(rows()).toEqual(before);expect(provider.getKey()).toBe(original);expect(provider.readAudit().total).toBe(1);
 });
 test('any corrupt credential blocks rotation and export before file changes',()=>{
  db.prepare("UPDATE feishu_bots SET credentials_json='broken' WHERE project_id='p2'").run();const file=readFileSync(path,'utf8');expect(provider.readStatus()).toMatchObject({state:'invalid',canBackup:false,canRotate:false});
  expect(()=>provider.saveFeishuKey(rotate,marker,identity)).toThrow(/恢复|不可用/);expect(()=>provider.backupFeishuKey({expectedVersion:2,confirmed:true},identity)).toThrow(/恢复|不可用/);expect(readFileSync(path,'utf8')).toBe(file);expect(provider.readAudit().total).toBe(1);
 });
 test('environment source remains readonly for both new actions',()=>{
  const env=createSystemSettingsProvider(db,{environmentKey:original});expect(env.readStatus()).toMatchObject({canBackup:false,canRotate:false});
  expect(()=>env.saveFeishuKey(rotate,marker,identity)).toThrow(/环境变量/);expect(()=>env.backupFeishuKey({expectedVersion:2,confirmed:true},identity)).toThrow(/环境变量/);expect(provider.getKey()).toBe(original);
 });
 test.each(['audit','row'])('%s failure rolls back all ciphertext and recovery finishes the same rotation',stage=>{
  const before=rows();db.exec(stage==='audit'?"CREATE TRIGGER fail_rotate BEFORE INSERT ON system_settings_audit WHEN NEW.action='安全更换飞书凭据主密钥' BEGIN SELECT RAISE(ABORT,'simulated crash'); END;":"CREATE TRIGGER fail_rotate BEFORE UPDATE ON feishu_bots WHEN OLD.project_id='p2' BEGIN SELECT RAISE(ABORT,'simulated crash'); END;");
  expect(()=>provider.saveFeishuKey(rotate,marker,identity)).toThrow(/simulated crash/);expect(rows()).toEqual(before);expect(JSON.parse(readFileSync(path,'utf8')).previousKey).toBe(original);
  db.exec('DROP TRIGGER fail_rotate');db.close();db=new Database(join(directory,'test.db'));provider=createSystemSettingsProvider(db);expect(provider.readStatus()).toMatchObject({state:'ready',version:3});expect(provider.readAudit().total).toBe(2);
  for(const row of rows())expect(decryptFeishuCredentials(row.credentials_json,provider.getKey(),row.project_id,row.id)).toEqual(payload);
  expect(readFileSync(path,'utf8')).not.toContain(original);provider.saveFeishuKey(rotate,marker,identity);expect(provider.readAudit().total).toBe(2);
 });
 test('nested recovery rollback keeps the previous key until the outer commit',()=>{
  db.exec("CREATE TRIGGER fail_rotate BEFORE INSERT ON system_settings_audit WHEN NEW.action='安全更换飞书凭据主密钥' BEGIN SELECT RAISE(ABORT,'crash'); END;");expect(()=>provider.saveFeishuKey(rotate,marker,identity)).toThrow();db.exec('DROP TRIGGER fail_rotate');
  expect(()=>db.transaction(()=>{expect(provider.readStatus().state).toBe('ready');throw new Error('outer rollback');})()).toThrow('outer rollback');expect(JSON.parse(readFileSync(path,'utf8')).previousKey).toBe(original);
  expect(provider.readStatus().state).toBe('ready');expect(readFileSync(path,'utf8')).not.toContain(original);
 });
 test('an initialized system with no bots can rotate',()=>{db.exec('DELETE FROM feishu_bots');expect(provider.saveFeishuKey(rotate,marker,identity)).toMatchObject({state:'ready',credentialCount:0});expect(provider.getKey()).not.toBe(original);});
 test('caller-owned transactions cannot overwrite the durable key journal before their commit',()=>{
  const file=readFileSync(path,'utf8'),before=rows();
  expect(()=>db.transaction(()=>provider.saveFeishuKey(rotate,marker,identity))()).toThrow(/独立/);
  expect(readFileSync(path,'utf8')).toBe(file);expect(rows()).toEqual(before);expect(provider.getKey()).toBe(original);
 });

});
