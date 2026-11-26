import { afterEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSystemSettingsProvider } from '../../server/src/modules/system-settings/index.js';
import { encryptFeishuCredentials, decryptFeishuCredentials } from '../../server/src/modules/feishu/store.js';
vi.mock('node:fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs')>();
 return {...actual,fsyncSync:vi.fn(actual.fsyncSync)};
});
const identity={accountId:'admin',actor:'管理员'};
let directory:string|undefined;let db:Database.Database|undefined;
afterEach(()=>{vi.mocked(fsyncSync).mockRestore();if(db?.open)db.close();if(directory)rmSync(directory,{recursive:true,force:true});});
describe('system settings filesystem durability failures',()=>{
 test.each(['file','directory'] as const)('%s fsync failure never reports success; recovery synchronizes before audit commit',async stage=>{
  const actual=await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fsyncSync).mockImplementation(fd=>{
   const info=actual.fstatSync(fd);
   if(stage==='directory'?info.isDirectory():info.isFile())throw new Error('simulated fsync failure');
   actual.fsyncSync(fd);
  });
  directory=mkdtempSync(join(tmpdir(),'goodwork-key-durability-'));db=new Database(join(directory,'test.db'));
  const provider=createSystemSettingsProvider(db);const input={expectedVersion:1,mode:'generate'};const request='durability-op-00001';
  expect(()=>provider.saveFeishuKey(input,request,identity)).toThrow(/保存/);
  expect(provider.getKey()).toBeUndefined();expect(provider.readStatus().version).toBe(1);expect(provider.readAudit().total).toBe(0);
  if(stage==='directory'){
   expect(provider.readStatus()).toMatchObject({state:'invalid',canGenerate:false,canImport:false});
   expect(()=>provider.saveFeishuKey(input,'durability-op-00002',identity)).toThrow(/恢复/);
  }else expect(existsSync(join(directory,'system-secrets','feishu-master-key.json'))).toBe(false);
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  if(stage==='file')provider.saveFeishuKey(input,request,identity);
  else expect(provider.readStatus()).toMatchObject({state:'ready',version:2});
  expect(provider.readAudit().total).toBe(1);expect(provider.getKey()).toBeDefined();
  expect(provider.saveFeishuKey(input,request,identity).version).toBe(2);expect(provider.readAudit().total).toBe(1);
  expect(statSync(join(directory,'system-secrets','feishu-master-key.json')).mode&0o777).toBe(0o600);
 });
 test('crash marker recovers with invalid environment key without enabling fallback',()=>{
  directory=mkdtempSync(join(tmpdir(),'goodwork-key-durability-'));db=new Database(join(directory,'test.db'));
  const provider=createSystemSettingsProvider(db);db.exec("CREATE TRIGGER crash BEFORE INSERT ON system_settings_audit BEGIN SELECT RAISE(ABORT,'crash'); END;");
  expect(()=>provider.saveFeishuKey({expectedVersion:1,mode:'generate'},'durability-op-00001',identity)).toThrow('crash');
  db.exec('DROP TRIGGER crash');db.close();db=new Database(join(directory,'test.db'));
  const restarted=createSystemSettingsProvider(db,{environmentKey:''});
  expect(restarted.readStatus()).toMatchObject({version:2,source:'environment',state:'invalid',canImport:false});
  expect(restarted.getKey()).toBeUndefined();expect(restarted.readAudit().total).toBe(1);
 });
 test.each(['file','directory'] as const)('rotation %s fsync failure keeps credentials recoverable and never acknowledges success',async stage=>{
  const actual=await vi.importActual<typeof import('node:fs')>('node:fs');vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  directory=mkdtempSync(join(tmpdir(),'goodwork-rotate-durability-'));db=new Database(join(directory,'test.db'));const provider=createSystemSettingsProvider(db);
  provider.saveFeishuKey({expectedVersion:1,mode:'generate'},'initial-durability-001',identity);const old=provider.getKey()!;
  db.exec('CREATE TABLE feishu_bots(project_id TEXT,id TEXT,credentials_json TEXT)');const content={webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh12345678',secret:'signature'};
  const encrypted=encryptFeishuCredentials(content,old,'p1','b1');db.prepare('INSERT INTO feishu_bots VALUES(?,?,?)').run('p1','b1',encrypted);
  vi.mocked(fsyncSync).mockImplementation(fd=>{const info=actual.fstatSync(fd);if(stage==='directory'?info.isDirectory():info.isFile())throw new Error('disk failure');actual.fsyncSync(fd);});
  const body={expectedVersion:2,mode:'rotate',confirmed:true},key='rotate-durability-001';expect(()=>provider.saveFeishuKey(body,key,identity)).toThrow(/保存/);
  expect((db.prepare('SELECT credentials_json FROM feishu_bots').get() as {credentials_json:string}).credentials_json).toBe(encrypted);expect(provider.readStatus().version).toBe(2);
  if(stage==='directory'){expect(provider.getKey()).toBeUndefined();expect(provider.readStatus()).toMatchObject({canImport:false,canRotate:false});}else expect(provider.getKey()).toBe(old);
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);if(stage==='file')provider.saveFeishuKey(body,key,identity);else expect(provider.readStatus().version).toBe(3);
  expect(provider.getKey()).not.toBe(old);const row=db.prepare('SELECT credentials_json FROM feishu_bots').get() as {credentials_json:string};expect(decryptFeishuCredentials(row.credentials_json,provider.getKey(),'p1','b1')).toEqual(content);
  expect(provider.readAudit().total).toBe(2);expect(readFileSync(join(directory,'system-secrets','feishu-master-key.json'),'utf8')).not.toContain(old);
 });
 test('post-commit cleanup failure preserves a usable new key and later removes recovery material',async()=>{
  const actual=await vi.importActual<typeof import('node:fs')>('node:fs');vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  directory=mkdtempSync(join(tmpdir(),'goodwork-rotate-cleanup-'));db=new Database(join(directory,'test.db'));const provider=createSystemSettingsProvider(db);
  provider.saveFeishuKey({expectedVersion:1,mode:'generate'},'initial-durability-001',identity);const old=provider.getKey();let calls=0;
  vi.mocked(fsyncSync).mockImplementation(fd=>{calls++;if(calls>2)throw new Error('cleanup unavailable');actual.fsyncSync(fd);});
  const result=provider.saveFeishuKey({expectedVersion:2,mode:'rotate',confirmed:true},'rotate-durability-001',identity);expect(result).toMatchObject({version:3,state:'ready'});expect(provider.getKey()).not.toBe(old);
  const keyPath=join(directory,'system-secrets','feishu-master-key.json');expect(JSON.parse(readFileSync(keyPath,'utf8')).previousKey).toBe(old);
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);provider.readStatus();expect(JSON.parse(readFileSync(keyPath,'utf8')).previousKey).toBeUndefined();expect(provider.readAudit().total).toBe(2);
 });

});
