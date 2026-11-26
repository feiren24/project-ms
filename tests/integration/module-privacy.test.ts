import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';

describe('authenticated project module privacy', () => {
  let app: FastifyInstance, db: Database.Database, directory: string, cookie: string, csrf: string, userId: string;
  const prefix = '/api/v1/projects/phase-one';
  const now = new Date('2026-09-23T06:00:00Z');
  const headers = () => ({ cookie, 'x-csrf-token': csrf, 'idempotency-key': randomUUID(), 'x-demo-actor': 'zhou' });
  const get = (path: string) => app.inject({ method: 'GET', url: prefix + path, headers: headers() });
  const role = (value: string, admin = false) => {
    db.prepare('UPDATE auth_users SET system_role=? WHERE id=?').run(admin ? 'admin' : 'user', userId);
    db.prepare('UPDATE project_members SET role=?,active=1,removed_at=NULL WHERE project_id=? AND id=?').run(value, 'phase-one', 'chen');
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-module-privacy-'));
    const path = join(directory, 'test.sqlite');
    app = buildApp({ dbPath: path, clock: () => now, jobIntervalMs: 0, riskIntervalMs: 0, snapshotIntervalMs: 0, feishu: { intervalMs: 0 } });
    db = new Database(path);
    await createInitialAdmin(db, { username: 'privacy-test', name: '隐私测试账号', password: 'module-privacy-password-2026' }, now);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'privacy-test', password: 'module-privacy-password-2026' } });
    expect(login.statusCode, login.body).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    csrf = login.json().data.csrfToken; userId = login.json().data.user.id;
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one', 'chen', userId);
    db.prepare('INSERT INTO plan_history VALUES(?,?,?,?)').run('privacy-calendar', 'phase-one', JSON.stringify({ id:'privacy-calendar',action:'calendar',actor:'管理人员',reason:'PRIVATE-CAPACITY-REASON',createdAt:now.toISOString(),affectedCount:0 }), now.toISOString());
  });
  beforeEach(() => role('member'));
  afterAll(async () => { db?.close(); await app?.close(); await rm(directory, { recursive: true, force: true }); });

  test.each(['member', 'viewer'])('%s cannot read any private domain or spoof management identity', async value => {
    role(value);
    for (const path of ['/analytics','/risks','/settings','/memberships','/memberships/zhou/removal-preview','/integrations/feishu','/integrations/feishu/templates']) {
      const response = await get(path);
      expect(response.statusCode, `${path}: ${response.body}`).toBe(403);
      expect(response.json().data).toBeUndefined();
      expect(response.json().error.code).toBe('PROJECT_MODULE_FORBIDDEN');
    }
    const head = await app.inject({ method:'HEAD',url:prefix+'/settings',headers:headers() });
    expect(head.statusCode).toBe(403);
  });
  test.each(['manager','project_admin','system_admin'])('%s retains private modules and capability flags', async value => {
    role(value === 'system_admin' ? 'member' : value, value === 'system_admin');
    for (const path of ['/analytics','/risks','/settings','/memberships']) expect((await get(path)).statusCode,path).toBe(200);
    const overview = (await get('/overview')).json().data;
    expect(overview.capabilities).toEqual({analytics:true,risks:true,settings:true});
    expect(overview.risks).toBeInstanceOf(Array);
    expect(overview.summary).toHaveProperty('highRisks');
  });
  test.each(['member','viewer'])('%s sees collaboration but receives no private overview/history data', async value => {
    role(value);
    const overview = (await get('/overview')).json().data;
    expect(overview.capabilities).toEqual({analytics:false,risks:false,settings:false});
    expect(overview).not.toHaveProperty('risks');
    expect(overview.summary).not.toHaveProperty('highRisks');
    expect(overview.summary).not.toHaveProperty('riskReviewOverdue');
    expect(overview.tasks.length).toBeGreaterThan(0);
    expect(overview.summary.totalTasks).toBeGreaterThan(0);
    for (const path of ['/tasks','/tasks/options','/tasks/query','/gantt','/workstreams','']) {
      const response = await get(path); expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('PRIVATE-CAPACITY-REASON');
      expect(response.json().data).not.toHaveProperty('capacities');
      expect(response.json().data).not.toHaveProperty('members');
    }
    expect((await get('/plan/history/privacy-calendar')).statusCode).toBe(404);
  });
  test('same login loses module access immediately on role downgrade', async () => {
    role('manager'); expect((await get('/settings')).statusCode).toBe(200);
    role('member'); expect((await get('/settings')).statusCode).toBe(403);
    const session = await app.inject({method:'GET',url:'/api/v1/auth/session',headers:headers()});
    expect(session.json().data.projects.find((p:{id:string})=>p.id==='phase-one').capabilities.settings).toBe(false);
    role('manager'); expect((await get('/plan/history/privacy-calendar')).statusCode).toBe(200);
  });
  test('HEAD notification and revision requests use the authenticated recipient', async () => {
    for (const path of ['/notifications','/revision']) {
      const response = await app.inject({method:'HEAD',url:prefix+path+'?actorId=not-a-member',headers:headers()});
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');
      expect((await get(path+'?actorId=not-a-member')).json().data.actorId).toBe('chen');
    }
  });
  test('task deletion association preview does not disclose private risk names or ids', async () => {
    const row = db.prepare('SELECT task_id,meta_json FROM task_meta WHERE project_id=? LIMIT 1').get('phase-one') as {task_id:string;meta_json:string};
    const meta = JSON.parse(row.meta_json); meta.creatorId = 'chen';
    db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify(meta),'phase-one',row.task_id);
    const riskRow = db.prepare('SELECT id,snapshot_json FROM risk_records WHERE project_id=? LIMIT 1').get('phase-one') as {id:string;snapshot_json:string};
    const risk = JSON.parse(riskRow.snapshot_json); risk.title = 'PRIVATE-RISK-TITLE'; risk.taskIds = [row.task_id];
    db.prepare('UPDATE risk_records SET snapshot_json=? WHERE project_id=? AND id=?').run(JSON.stringify(risk),'phase-one',riskRow.id);
    const response = await app.inject({method:'POST',url:prefix+`/tasks/${row.task_id}/delete-preview`,headers:headers(),payload:{}});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.body).not.toContain('PRIVATE-RISK-TITLE');
    expect(response.body).not.toContain(riskRow.id);
    expect(response.json().data.blockers.filter((b:{kind:string})=>b.kind==='risk')).toEqual([{kind:'risk',id:'restricted',title:'存在需管理人员处理的关联',message:'请联系项目负责人或项目管理员处理关联后再重试。'}]);
    role('manager');
    const management = await app.inject({method:'POST',url:prefix+`/tasks/${row.task_id}/delete-preview`,headers:headers(),payload:{}});
    expect(management.body).toContain('PRIVATE-RISK-TITLE');
  });
  test('private writes are denied before payload processing or idempotent replay', async () => {
    for (const path of ['/settings/capacity','/risks','/risks/not-readable/responsibilities']) {
      const response = await app.inject({method:'POST',url:prefix+path,headers:headers(),payload:{}});
      expect(response.statusCode,response.body).toBe(403);
      expect(response.json().error.code).toBe('PROJECT_MODULE_FORBIDDEN');
    }
  });
  test('removed members and anonymous requests retain project/login isolation', async () => {
    db.prepare('UPDATE project_members SET active=0 WHERE project_id=? AND id=?').run('phase-one','chen');
    expect((await get('/settings')).statusCode).toBe(404);
    expect((await app.inject({method:'GET',url:prefix+'/settings'})).statusCode).toBe(401);
  });
  test('absolute-form HTTP request targets cannot bypass authentication or module authorization', async () => {
    await app.listen({host:'127.0.0.1',port:0});
    const address = app.server.address() as {port:number};
    const raw = (path: string, authenticated: boolean) => new Promise<{status:number;body:string}>((resolve,reject) => {
      const request = httpRequest({hostname:'127.0.0.1',port:address.port,path:`http://localhost:${address.port}${prefix}${path}`,headers:authenticated?headers():{}}, response => {
        let body=''; response.setEncoding('utf8'); response.on('data',chunk=>{body+=chunk;}); response.on('end',()=>resolve({status:response.statusCode!,body}));
      }); request.on('error',reject); request.end();
    });
    expect((await raw('/overview',false)).status).toBe(401);
    expect((await raw('/plan/history/privacy-calendar',false)).status).toBe(401);
    expect((await raw('/settings',true)).status).toBe(403);
    const overview = await raw('/overview',true);
    expect(overview.status).toBe(200);
    expect(JSON.parse(overview.body).data).not.toHaveProperty('risks');
    expect((await raw('/plan/history/privacy-calendar',true)).status).toBe(404);
  });
  test.each(['ownerId','closeReviewerId'])('account deactivation checks linked open risk %s before changing account or audit', async field => {
    role('manager',true);
    const created = await app.inject({method:'POST',url:'/api/v1/admin/users',headers:headers(),payload:{username:`risk-duty-${field.toLowerCase()}`,name:'虚构风险管理账号',systemRole:'user',canCreateProjects:false}});
    expect(created.statusCode,created.body).toBe(200);
    const target = created.json().data.user;
    const memberId = `privacy-duty-${field}`;
    db.prepare('INSERT INTO project_members(project_id,id,name,role,active) VALUES(?,?,?,?,1)').run('phase-one',memberId,`虚构职责${field}`,'project_admin');
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one',memberId,target.id);
    const row = db.prepare('SELECT id,snapshot_json FROM risk_records WHERE project_id=? LIMIT 1').get('phase-one') as {id:string;snapshot_json:string};
    const risk = JSON.parse(row.snapshot_json); Object.assign(risk,{ownerId:'zhou',closeReviewerId:'zhou',status:'monitoring',[field]:memberId});
    db.prepare('UPDATE risk_records SET snapshot_json=? WHERE id=?').run(JSON.stringify(risk),row.id);
    const payload = {expectedVersion:target.version,name:target.name,systemRole:target.systemRole,active:false,canCreateProjects:false};
    const auditBefore = db.prepare('SELECT COUNT(*) AS count FROM auth_audit WHERE target_id=?').get(target.id);
    const blocked = await app.inject({method:'PATCH',url:`/api/v1/admin/users/${target.id}`,headers:headers(),payload});
    expect(blocked.statusCode,blocked.body).toBe(422);
    expect(blocked.json().error.code).toBe('ACCOUNT_HAS_RISK_RESPONSIBILITIES');
    expect(db.prepare('SELECT active,version FROM auth_users WHERE id=?').get(target.id)).toEqual({active:1,version:target.version});
    expect(db.prepare('SELECT COUNT(*) AS count FROM auth_audit WHERE target_id=?').get(target.id)).toEqual(auditBefore);
    const handover = await app.inject({method:'POST',url:prefix+`/risks/${row.id}/responsibilities`,headers:headers(),payload:{expectedVersion:risk.version,ownerId:'zhou',closeReviewerId:'zhou',reason:'停用账号前移交风险职责'}});
    expect(handover.statusCode,handover.body).toBe(200);
    const disabled = await app.inject({method:'PATCH',url:`/api/v1/admin/users/${target.id}`,headers:headers(),payload});
    expect(disabled.statusCode,disabled.body).toBe(200);
    expect(disabled.json().data.active).toBe(false);
  });
});
