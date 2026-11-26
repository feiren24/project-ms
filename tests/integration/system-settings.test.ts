import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSystemSettingsProvider, type SystemSettingsProvider } from '../../server/src/modules/system-settings/index.js';
import { encryptFeishuCredentials } from '../../server/src/modules/feishu/store.js';
const original = Buffer.alloc(32,7).toString('base64');
const wrong = Buffer.alloc(32,8).toString('base64');
const identity={accountId:'system-admin',actor:'系统管理员'};
const now=()=>new Date('2026-09-09T12:00:00.000Z');
const first='operation-key-00001';
const generate={expectedVersion:1,mode:'generate'};
const imported=(key=original,expectedVersion=1)=>({expectedVersion,mode:'import',key});
describe('system settings key persistence and recovery',()=>{
 let db:Database.Database, directory:string, keyDirectory:string, keyPath:string, provider:SystemSettingsProvider;
 beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'goodwork-system-key-'));keyDirectory=join(directory,'system-secrets');keyPath=join(keyDirectory,'feishu-master-key.json');
  db=new Database(join(directory,'test.db'));db.exec('CREATE TABLE feishu_bots(project_id TEXT,id TEXT,credentials_json TEXT)');
  provider=createSystemSettingsProvider(db,{clock:now});
 });
 afterEach(()=>{if(db.open)db.close();rmSync(directory,{recursive:true,force:true});});
 const bot=(database:Database.Database,project='project-a',id='bot-a',key=original)=>database.prepare('INSERT INTO feishu_bots VALUES(?,?,?)').run(project,id,encryptFeishuCredentials({webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh12345678',secret:'signing-secret'},key,project,id));
 test('reads do not create secret storage or change independent versions',()=>{
  const changes=db.prepare('SELECT total_changes() AS n').get();
  expect(provider.readStatus()).toMatchObject({version:1,state:'missing',source:'none',canGenerate:true,canImport:true,hasCredentials:false});
  expect(provider.getKey()).toBeUndefined();expect(provider.readAudit()).toEqual({items:[],page:1,total:0});
  expect(existsSync(keyDirectory)).toBe(false);expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
 });
 test('generates private persistent key, survives restart, and never returns plaintext',()=>{
  const result=provider.saveFeishuKey(generate,first,identity);const key=provider.getKey()!;
  expect(Buffer.from(key,'base64')).toHaveLength(32);expect(result).toMatchObject({version:2,state:'ready',source:'file',canGenerate:false,canImport:false,updatedBy:identity.actor});
  expect(statSync(keyDirectory).mode&0o777).toBe(0o700);expect(statSync(keyPath).mode&0o777).toBe(0o600);
  expect(JSON.stringify(result)).not.toContain(key);expect(JSON.stringify(provider.readAudit())).not.toContain(key);
  db.close();db=new Database(join(directory,'test.db'));provider=createSystemSettingsProvider(db,{clock:now});
  expect(provider.getKey()).toBe(key);expect(provider.readStatus().version).toBe(2);expect(provider.readAudit().total).toBe(1);
  const tables=['system_settings_config','system_settings_audit','system_settings_receipts'];
  for(const table of tables)expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(key);
 });
 test('imports canonical key and blocks every replacement after healthy configuration',()=>{
  provider.saveFeishuKey(imported(),first,identity);expect(provider.getKey()).toBe(original);
  expect(()=>provider.saveFeishuKey(imported(wrong,2),'operation-key-00002',identity)).toThrow(/不能/);
  expect(()=>provider.saveFeishuKey({expectedVersion:2,mode:'generate'},'operation-key-00003',identity)).toThrow(/不能/);
  expect(provider.getKey()).toBe(original);expect(provider.readAudit().total).toBe(1);
 });
 test('validates all projects and bots, rejecting bad imports without file or audit writes',()=>{
  bot(db);bot(db,'project-b','bot-b');
  expect(provider.readStatus()).toMatchObject({hasCredentials:true,canGenerate:false,canImport:true});
  expect(()=>provider.saveFeishuKey(generate,first,identity)).toThrow(/原主密钥/);
  expect(()=>provider.saveFeishuKey(imported(wrong),first,identity)).toThrow(/所有项目/);
  expect(existsSync(keyPath)).toBe(false);expect(provider.readStatus().version).toBe(1);expect(provider.readAudit().total).toBe(0);
  expect(provider.saveFeishuKey(imported(),first,identity).state).toBe('ready');expect(provider.getKey()).toBe(original);
 });
 test('mixed keys across projects cannot pass partial validation',()=>{
  bot(db);bot(db,'project-b','bot-b',wrong);
  expect(()=>provider.saveFeishuKey(imported(),first,identity)).toThrow(/所有项目/);expect(provider.getKey()).toBeUndefined();
 });
 test.each(['missing','corrupt','mismatched'] as const)('restores %s file only using key matching existing ciphertexts',kind=>{
  provider.saveFeishuKey(imported(),first,identity);bot(db);
  if(kind==='missing')unlinkSync(keyPath);
  if(kind==='corrupt')writeFileSync(keyPath,'broken');
  if(kind==='mismatched'){const file=JSON.parse(readFileSync(keyPath,'utf8'));file.key=wrong;writeFileSync(keyPath,JSON.stringify(file));}
  expect(provider.getKey()).toBeUndefined();expect(provider.readStatus()).toMatchObject({canGenerate:false,canImport:true});
  expect(()=>provider.saveFeishuKey(imported(wrong,2),'operation-key-00002',identity)).toThrow(/所有项目/);
  expect(provider.saveFeishuKey(imported(original,2),'operation-key-00002',identity)).toMatchObject({state:'ready',version:3});
 });
 test.each([wrong,'','malformed'])('environment setting takes precedence even when invalid (%s)',environmentKey=>{
  provider.saveFeishuKey(imported(),first,identity);bot(db);
  const env=createSystemSettingsProvider(db,{environmentKey,clock:now});
  expect(env.getKey()).toBeUndefined();expect(env.readStatus()).toMatchObject({state:'invalid',source:'environment',canGenerate:false,canImport:false});
  expect(()=>env.saveFeishuKey(imported(original,2),'operation-key-00002',identity)).toThrow(/不能/);
  expect(provider.getKey()).toBe(original);
 });
 test('valid environment key works without file creation',()=>{
  const env=createSystemSettingsProvider(db,{environmentKey:original});expect(env.getKey()).toBe(original);
  expect(env.readStatus()).toMatchObject({state:'ready',source:'environment',canImport:false});expect(existsSync(keyDirectory)).toBe(false);
 });
 test('memory database never uses a real default secret directory',()=>{
  const memory=new Database(':memory:');try{
   const ephemeral=createSystemSettingsProvider(memory);expect(ephemeral.readStatus()).toMatchObject({canGenerate:false,canImport:false});
   expect(()=>ephemeral.saveFeishuKey(generate,first,identity)).toThrow(/持久化/);
   const isolated=createSystemSettingsProvider(memory,{keyDirectory});expect(isolated.saveFeishuKey(generate,first,identity).state).toBe('ready');
  }finally{memory.close();}
 });
 test('idempotent retry has one version/audit; changed payload or stale competing write conflicts',()=>{
  const result=provider.saveFeishuKey(imported(),first,identity);
  expect(provider.saveFeishuKey(imported(),first,identity)).toEqual(result);
  expect(()=>provider.saveFeishuKey(imported(wrong),first,identity)).toThrow(/操作标识/);
  expect(()=>provider.saveFeishuKey(generate,'operation-key-00002',identity)).toThrow(/已更新/);
  expect(provider.readAudit().total).toBe(1);
 });
 test('two database connections serialize competing updates and keep shared version',()=>{
  const otherDb=new Database(join(directory,'test.db'));try{
   const other=createSystemSettingsProvider(otherDb);provider.saveFeishuKey(generate,first,identity);
   expect(()=>other.saveFeishuKey(generate,'operation-key-00002',identity)).toThrow(/已更新/);
   expect(other.readStatus().version).toBe(2);expect(other.getKey()).toBe(provider.getKey());
  }finally{otherDb.close();}
 });
 test('committed file repairs audit/version/receipt after SQL failure or crash, exactly once',()=>{
  db.exec("CREATE TRIGGER crash_before_audit BEFORE INSERT ON system_settings_audit BEGIN SELECT RAISE(ABORT,'simulated crash'); END;");
  expect(()=>provider.saveFeishuKey(imported(),first,identity)).toThrow('simulated crash');expect(existsSync(keyPath)).toBe(true);
  expect((db.prepare('SELECT version FROM system_settings_config').get() as {version:number}).version).toBe(1);
  db.exec('DROP TRIGGER crash_before_audit');db.close();db=new Database(join(directory,'test.db'));provider=createSystemSettingsProvider(db,{clock:now});
  expect(provider.readStatus()).toMatchObject({state:'ready',version:2});expect(provider.readAudit().total).toBe(1);
  provider.saveFeishuKey(imported(),first,identity);provider.readStatus();expect(provider.readAudit().total).toBe(1);
 });
 test.each(['directory','file'] as const)('rejects %s symlinks without touching external targets',kind=>{
  const external=join(directory,'external');
  if(kind==='directory'){mkdirSync(external,{mode:0o700});symlinkSync(external,keyDirectory);}
  else{mkdirSync(keyDirectory,{mode:0o700});writeFileSync(external,'do not change');symlinkSync(external,keyPath);}
  expect(provider.readStatus().state).toBe('invalid');expect(provider.getKey()).toBeUndefined();
  expect(()=>provider.saveFeishuKey(generate,first,identity)).toThrow(/保存/);
  expect(provider.readAudit().total).toBe(0);
  if(kind==='file')expect(readFileSync(external,'utf8')).toBe('do not change');
 });
 test.each(['directory','file'] as const)('rejects broad %s permissions and recovers after permissions restored',kind=>{
  provider.saveFeishuKey(imported(),first,identity);
  const target=kind==='directory'?keyDirectory:keyPath;chmodSync(target,kind==='directory'?0o755:0o644);
  expect(provider.getKey()).toBeUndefined();expect(provider.readStatus().state).toBe('invalid');
  chmodSync(target,kind==='directory'?0o700:0o600);expect(provider.getKey()).toBe(original);
 });
 test('write failure does not claim success, advance version, or append success audit',()=>{
  mkdirSync(keyDirectory,{mode:0o700});mkdirSync(keyPath,{mode:0o700});
  expect(()=>provider.saveFeishuKey(generate,first,identity)).toThrow(/保存/);
  expect(provider.readStatus().version).toBe(1);expect(provider.getKey()).toBeUndefined();expect(provider.readAudit().total).toBe(0);
 });
 test.each(['matching','mismatched'] as const)('older database backup with future %s key marker allows validated import recovery',kind=>{
  provider.saveFeishuKey(imported(),first,identity);bot(db);
  const file=JSON.parse(readFileSync(keyPath,'utf8'));file.operation.version=5;if(kind==='mismatched')file.key=wrong;
  writeFileSync(keyPath,JSON.stringify(file));
  expect(provider.readStatus()).toMatchObject({state:'invalid',version:2,canImport:true,canGenerate:false});
  expect(provider.getKey()).toBeUndefined();
  expect(provider.saveFeishuKey(imported(original,2),'operation-key-00002',identity)).toMatchObject({state:'ready',version:3});
  expect(provider.getKey()).toBe(original);expect(provider.readAudit().total).toBe(2);
 });
 test('strict validation rejects unsupported keys, malformed import, absent version and invalid request marker',()=>{
  for(const value of [{mode:'generate'}, {...generate,unexpected:true}, {...generate,key:original},imported('bad'),{expectedVersion:1,mode:'rotate'},null])expect(()=>provider.saveFeishuKey(value,first,identity)).toThrow();
  expect(()=>provider.saveFeishuKey(generate,'short',identity)).toThrow(/操作标识/);expect(existsSync(keyDirectory)).toBe(false);
 });
 test('audit pagination is bounded, stable and validates page values',()=>{
  for(let i=0;i<25;i++)db.prepare('INSERT INTO system_settings_audit VALUES(?,?,?,?,?)').run(`audit-${i}`,now().toISOString(),'管理员','配置操作','成功');
  expect(provider.readAudit().items).toHaveLength(20);expect(provider.readAudit('2').items).toHaveLength(5);expect(provider.readAudit(3)).toMatchObject({items:[],page:3,total:25});
  for(const page of [0,-1,'0','1.1','1foo',Infinity])expect(()=>provider.readAudit(page)).toThrow(/页码/);
 });
});
