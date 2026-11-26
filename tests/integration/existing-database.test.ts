import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { buildApp } from '../../server/src/app.js';
import { checkExistingDatabase } from '../../server/src/db/existing.js';
import { readSchema, schemaDifferences, normalizeSql, type SchemaContract } from '../../server/src/db/schema.js';
import { createInitialAdmin } from '../../server/src/modules/auth/store.js';
import { runtimeConfig } from '../../server/src/config.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'goodwork-existing-')); dirs.push(dir);
  const path=join(dir,'original.sqlite');
  const app=buildApp({dbPath:path,jobIntervalMs:0}); await app.ready(); await app.close();
  const db=new Database(path); await createInitialAdmin(db,{username:'existing-admin',name:'原管理员',password:'Existing-password-123'}); db.close();
  return {dir,path};
}
function snapshot(path:string) {
  const db=new Database(path,{readonly:true});
  try {
    return {schema:readSchema(db),data:Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]))};
  } finally {db.close();}
}
describe('existing-only deployment',()=>{
  it('uses the exact public HTTPS origin for login, secure cookies and protected writes',async()=>{
    const {path}=await fixture();
    const origin='https://pm.example.com';
    const options=runtimeConfig({DATABASE_PATH:path,DATABASE_MODE:'existing-only',PUBLIC_BASE_URL:origin,HOST:'127.0.0.1',NODE_ENV:'production'});
    const app=buildApp({...options,jobIntervalMs:0});
    try {
      await app.ready();
      for(const denied of ['https://other.example.com','http://pm.example.com','http://127.0.0.1:3100']) {
        const result=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:denied},payload:{}});
        expect(result.statusCode).toBe(403);expect(result.json().error.code).toBe('ORIGIN_FORBIDDEN');
      }
      const probe=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{}});
      expect(probe.statusCode).toBe(422);expect(probe.json().error.code).toBe('INVALID_BODY');
      const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{username:'existing-admin',password:'Existing-password-123'}});
      expect(login.statusCode,login.body).toBe(200);expect(login.headers['set-cookie']).toContain('; Secure');
      const cookie=String(login.headers['set-cookie']).split(';')[0]!;
      const session=await app.inject({url:'/api/v1/auth/session',headers:{cookie}});
      expect(session.json().data.user.username).toBe('existing-admin');
      const change=await app.inject({method:'POST',url:'/api/v1/auth/password',headers:{origin,cookie,'x-csrf-token':login.json().data.csrfToken,'idempotency-key':crypto.randomUUID()},payload:{currentPassword:'Existing-password-123',newPassword:'Changed-domain-password-123'}});
      expect(change.statusCode,change.body).toBe(200);
    } finally {await app.close();}
  });
  it('validates, starts and serves reads without any schema/data initialization',async()=>{
    const {path}=await fixture();const before=snapshot(path);
    checkExistingDatabase(path);
    const app=buildApp({dbPath:path,databaseMode:'existing-only',jobIntervalMs:0,secureCookies:false,allowedOrigins:['http://203.0.113.10:3100']});
    try { await app.ready(); expect((await app.inject('/health/ready')).statusCode).toBe(200); expect((await app.inject('/api/v1/auth/session')).json().data.initialized).toBe(true); }
    finally {await app.close();}
    expect(snapshot(path)).toEqual(before);
  });
  it('keeps original login and normal business writes across restarts',async()=>{
    const {path}=await fixture();
    const options={dbPath:path,databaseMode:'existing-only' as const,jobIntervalMs:0,secureCookies:false,allowedOrigins:['http://203.0.113.10:3100']};
    const app=buildApp(options);await app.ready();
    try {
      const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:options.allowedOrigins[0]},payload:{username:'existing-admin',password:'Existing-password-123'}});
      expect(login.statusCode,login.body).toBe(200);
      expect(login.headers['set-cookie']).not.toContain('; Secure');
      const cookie=String(login.headers['set-cookie']).split(';')[0]!;
      const response=await app.inject({method:'POST',url:'/api/v1/auth/password',headers:{origin:options.allowedOrigins[0],cookie,'x-csrf-token':login.json().data.csrfToken,'idempotency-key':crypto.randomUUID()},payload:{currentPassword:'Existing-password-123',newPassword:'Changed-password-123'}});
      expect(response.statusCode,response.body).toBe(200);
      const denied=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://untrusted.example'},payload:{username:'existing-admin',password:'Changed-password-123'}});expect(denied.statusCode).toBe(403);
    } finally {await app.close();}
    const restarted=buildApp(options);
    try {const login=await restarted.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:options.allowedOrigins[0]},payload:{username:'existing-admin',password:'Changed-password-123'}});expect(login.statusCode,login.body).toBe(200);}
    finally {await restarted.close();}
  });
  it('does not create missing files or initialize empty/corrupt databases',async()=>{
    const {dir}=await fixture(),path=join(dir,'missing.sqlite');
    expect(()=>buildApp({dbPath:path,databaseMode:'existing-only'})).toThrow(/不存在/);expect(existsSync(path)).toBe(false);
    for(const data of ['', 'not sqlite']){writeFileSync(path,data);expect(()=>checkExistingDatabase(path)).toThrow();expect(readFileSync(path,'utf8')).toBe(data);}
  });
  it('reports missing schema and markers without repairing them',async()=>{
    const {path}=await fixture();let db=new Database(path);db.exec('DROP TABLE system_settings_receipts');db.close();const before=snapshot(path);
    expect(()=>buildApp({dbPath:path,databaseMode:'existing-only'})).toThrow(/缺少 table: system_settings_receipts/);expect(snapshot(path)).toEqual(before);
    const other=await fixture();db=new Database(other.path);db.exec("DELETE FROM notification_state WHERE key='initial_events_seen'");db.close();const rows=snapshot(other.path);
    expect(()=>checkExistingDatabase(other.path)).toThrow(/缺少运行记录/);expect(snapshot(other.path)).toEqual(rows);
  });
  it('rejects missing columns and preserves significant SQL defaults',async()=>{
    const {path}=await fixture();const db=new Database(path);db.exec('ALTER TABLE system_settings_config DROP COLUMN updated_by');db.close();const before=snapshot(path);
    expect(()=>checkExistingDatabase(path)).toThrow(/结构定义不匹配: system_settings_config/);expect(snapshot(path)).toEqual(before);
    expect(normalizeSql("CREATE TABLE IF NOT EXISTS t(x TEXT DEFAULT 'ifnotexists')")).not.toBe(normalizeSql("CREATE TABLE t(x TEXT DEFAULT '')"));
  });
  it('keeps the schema contract aligned with all current module initializers',async()=>{
    const {path}=await fixture(),db=new Database(path,{readonly:true});
    try {const expected=JSON.parse(readFileSync(new URL('../../server/src/db/schema-contract.json',import.meta.url),'utf8')) as SchemaContract;expect(schemaDifferences(readSchema(db),expected)).toEqual([]);expect(schemaDifferences(expected,readSchema(db))).toEqual([]);}
    finally {db.close();}
  });
});
