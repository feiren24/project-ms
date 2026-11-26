import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthSession, AuthUser, IssuedCredential } from '../../shared/src/auth.js';
import type { TaskWorkspace } from '../../shared/src/tasks.js';

const originalPassword = '本机管理员密码 十二个字符 2026';
const newPassword = '新密码包含中文和空格 2026 goodwork';
const prefix = '/api/v1/projects/phase-one';
type Login = { cookie: string; setCookie: string; session: AuthSession };
describe('real password authentication and project boundary', () => {
  let directory: string; let dbPath: string; let app: FastifyInstance; let now: Date; let db: Database.Database;
  const freshApp = () => buildApp({ dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0 });
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(),'goodwork-auth-')); dbPath = join(directory,'auth.sqlite'); now = new Date('2026-09-07T03:00:00Z'); app = freshApp(); db = new Database(dbPath); });
  afterEach(async () => { await app.close(); db.close(); await rm(directory,{recursive:true,force:true}); });
  const headers = (login: Login) => ({ cookie: login.cookie, 'x-csrf-token': login.session.csrfToken, origin: 'http://localhost:5174', 'idempotency-key': randomUUID() });
  async function login(username = 'admin',password = originalPassword): Promise<Login> {
    const response = await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password}}); expect(response.statusCode,response.body).toBe(200);
    const setCookie = String(response.headers['set-cookie']); return {cookie:setCookie.split(';')[0]!,setCookie,session:response.json().data};
  }
  async function bootstrap(): Promise<Login> { await createInitialAdmin(db,{username:'Admin',name:'测试管理员',password:originalPassword},now); return login(); }
  async function create(admin: Login, username = 'worker', systemRole: 'admin'|'user' = 'user'): Promise<IssuedCredential> {
    const response = await app.inject({method:'POST',url:'/api/v1/admin/users',headers:headers(admin),payload:{username,name:`测试 ${username}`,systemRole,canCreateProjects:false}}); expect(response.statusCode,response.body).toBe(200); return response.json().data;
  }
  async function change(session: Login, currentPassword: string, password = newPassword): Promise<Login> {
    const response = await app.inject({method:'POST',url:'/api/v1/auth/password',headers:headers(session),payload:{currentPassword,newPassword:password}}); expect(response.statusCode,response.body).toBe(200); const setCookie = String(response.headers['set-cookie']); return {cookie:setCookie.split(';')[0]!,setCookie,session:response.json().data};
  }
  async function patch(admin: Login,user: AuthUser,changes: Partial<AuthUser>,key = randomUUID()) {
    return app.inject({method:'PATCH',url:`/api/v1/admin/users/${user.id}`,headers:{...headers(admin),'idempotency-key':key},payload:{expectedVersion:user.version,name:user.name,systemRole:user.systemRole,active:user.active,canCreateProjects:user.canCreateProjects,...changes}});
  }
  test('starts uninitialized, has no fallback actor/token boundary, and bootstrap creates no legacy link',async () => {
    expect((await app.inject('/api/v1/auth/session')).json().data).toEqual({user:null,csrfToken:'',projects:[],initialized:false});
    for (const path of ['overview','gantt','tasks','analytics','risks','settings','notifications?actorId=zhou','revision?actorId=zhou']) expect((await app.inject({url:`${prefix}/${path}`,headers:{'x-demo-actor':'zhou','x-preview-token':'anything','x-test-only-legacy-auth':'true'}})).statusCode,path).toBe(401);
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    const admin = await bootstrap(); expect(admin.session.projects[0]).toMatchObject({id:'phase-one',memberId:admin.session.user!.id,role:'manager'}); expect(admin.session.user!.id).not.toBe('zhou');
    expect(db.prepare('SELECT * FROM project_user_links').all()).toEqual([]);
    await expect(createInitialAdmin(db,{username:'another',name:'另一个',password:originalPassword},now)).rejects.toMatchObject({code:'ALREADY_INITIALIZED'});
    for (const path of ['overview','analytics','gantt','settings']) {
      const response = await app.inject({url:`${prefix}/${path}`,headers:{cookie:admin.cookie}});
      expect(response.statusCode,`${path}: ${response.body}`).toBe(200);
    }
  });
  const tokenDigest = (session: Login) => createHash('sha256').update(session.cookie.split('=')[1]!).digest('hex');
  const storedSession = (session: Login) => db.prepare('SELECT * FROM auth_sessions WHERE token_digest=?').get(tokenDigest(session)) as {token_digest:string;expires_at:number}|undefined;
  const taskPayload = (workspace: TaskWorkspace) => ({ title:'DEMO · 会话有效期测试',description:'虚构本地任务',workstreamId:workspace.workstreams[0]!.id,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:'2026-10-12',end:'2026-10-13',expectedPlanVersion:workspace.planVersion });
  const taskSnapshot = () => ['homepage_tasks','task_meta','plan_projects','task_idempotency'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  test('stores digest-only sessions for a fixed seven days and rotates login credentials',async () => {
    const issuedAt = now.getTime(); const admin = await bootstrap(); const token = admin.cookie.split('=')[1]!;
    const row = storedSession(admin)!;
    expect(row.token_digest).toBe(tokenDigest(admin)); expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expires_at).toBe(issuedAt+604800000);
    expect(admin.setCookie.split('; ')).toContain('Max-Age=604800');
    expect(JSON.stringify(db.prepare('SELECT * FROM auth_users').all())).not.toContain(originalPassword);
    now = new Date(issuedAt+3600000);
    const second = await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{cookie:admin.cookie},payload:{username:'ADMIN',password:originalPassword}});
    expect(second.statusCode,second.body).toBe(200);
    expect(second.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict'); expect(second.headers['set-cookie']).not.toContain('; Secure');
    expect(String(second.headers['set-cookie']).split('; ')).toContain('Max-Age=604800');
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:admin.cookie}})).json().data.user).toBeNull();
    expect(db.prepare('SELECT expires_at FROM auth_sessions').all()).toEqual([{expires_at:now.getTime()+604800000}]);
  });
  test('session and business requests stay valid past eight hours without renewing the seven-day expiry',async () => {
    const issuedAt = now.getTime(); const admin = await bootstrap(); const original = storedSession(admin);
    for (const elapsed of [8*3600*1000+1,604800000-1]) {
      now = new Date(issuedAt+elapsed);
      const session = await app.inject({url:'/api/v1/auth/session',headers:{cookie:admin.cookie}});
      expect(session.json().data.user?.id).toBe(admin.session.user!.id); expect(session.headers['set-cookie']).toBeUndefined();
      const tasks = await app.inject({url:`${prefix}/tasks`,headers:{cookie:admin.cookie}});
      expect(tasks.statusCode,tasks.body).toBe(200); expect(tasks.headers['set-cookie']).toBeUndefined();
      const created = await app.inject({method:'POST',url:`${prefix}/tasks`,headers:headers(admin),payload:taskPayload(tasks.json().data)});
      expect(created.statusCode,created.body).toBe(200); expect(created.headers['set-cookie']).toBeUndefined();
      expect(storedSession(admin)).toEqual(original);
      expect(storedSession(admin)!.expires_at).toBe(issuedAt+604800000);
    }
  });
  test.each([604800000,604800001])('rejects expired session reads and business writes at %i milliseconds without mutation',async elapsed => {
    const issuedAt = now.getTime(); const admin = await bootstrap();
    const workspace = (await app.inject({url:`${prefix}/tasks`,headers:{cookie:admin.cookie}})).json().data as TaskWorkspace;
    const before = taskSnapshot(); now = new Date(issuedAt+elapsed);
    const session = await app.inject({url:'/api/v1/auth/session',headers:{cookie:admin.cookie}});
    expect(session.statusCode).toBe(200); expect(session.json().data.user).toBeNull();
    expect((await app.inject({url:`${prefix}/tasks`,headers:{cookie:admin.cookie}})).statusCode).toBe(401);
    const write = await app.inject({method:'POST',url:`${prefix}/tasks`,headers:headers(admin),payload:taskPayload(workspace)});
    expect(write.statusCode,write.body).toBe(401); expect(write.json().error.code).toBe('AUTH_REQUIRED');
    expect(taskSnapshot()).toEqual(before);
  });
  test('restart preserves the original seven-day deadline and never restarts its clock',async () => {
    const issuedAt = now.getTime(); const admin = await bootstrap(); const original = storedSession(admin);
    now = new Date(issuedAt+3*24*3600*1000); await app.close(); app = freshApp();
    expect(storedSession(admin)).toEqual(original); expect(storedSession(admin)!.expires_at).toBe(issuedAt+604800000);
    const resumed = await app.inject({url:'/api/v1/auth/session',headers:{cookie:admin.cookie}});
    expect(resumed.json().data.user?.id).toBe(admin.session.user!.id); expect(resumed.headers['set-cookie']).toBeUndefined();
    now = new Date(issuedAt+604800000);
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:admin.cookie}})).json().data.user).toBeNull();
    expect((await app.inject({url:`${prefix}/tasks`,headers:{cookie:admin.cookie}})).statusCode).toBe(401);
  });
  test('keeps legacy eight-hour stored deadlines across restart while new logins receive seven days',async () => {
    const issuedAt = now.getTime(); const legacy = await bootstrap(); const legacyExpiry = issuedAt+8*3600*1000;
    // Simulate a session issued before the duration change; startup must not migrate it.
    db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_digest=?').run(legacyExpiry,tokenDigest(legacy));
    now = new Date(issuedAt+3600000); await app.close(); app = freshApp();
    expect(storedSession(legacy)!.expires_at).toBe(legacyExpiry);
    const fresh = await login(); expect(fresh.setCookie.split('; ')).toContain('Max-Age=604800'); expect(storedSession(fresh)!.expires_at).toBe(now.getTime()+604800000);
    now = new Date(legacyExpiry-1);
    const resumed = await app.inject({url:'/api/v1/auth/session',headers:{cookie:legacy.cookie}});
    expect(resumed.json().data.user?.id).toBe(legacy.session.user!.id); expect(resumed.headers['set-cookie']).toBeUndefined();
    expect(storedSession(legacy)!.expires_at).toBe(legacyExpiry);
    now = new Date(legacyExpiry);
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:legacy.cookie}})).json().data.user).toBeNull();
    expect((await app.inject({url:`${prefix}/tasks`,headers:{cookie:legacy.cookie}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:fresh.cookie}})).json().data.user?.id).toBe(fresh.session.user!.id);
  });
  test('strict bodies, passwords, origin and session-bound CSRF reject before mutation',async () => {
    const admin = await bootstrap(); const second = await login(); const payload = {username:'validuser',name:'普通账号',systemRole:'user',canCreateProjects:false}; const url = '/api/v1/admin/users';
    for (const override of [{'x-csrf-token':''},{'x-csrf-token':'a'.repeat(43)},{'x-csrf-token':'中'.repeat(43)},{'x-csrf-token':second.session.csrfToken},{origin:'https://evil.example'},{origin:'null'}]) expect((await app.inject({method:'POST',url,headers:{...headers(admin),...override},payload})).statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_users').get()).toEqual({n:1});
    for (const extra of [{unexpected:1},{systemRole:'manager'},{canCreateProjects:'true'},{username:' invalid'},{name:''}]) expect((await app.inject({method:'POST',url,headers:headers(admin),payload:{...payload,...extra}})).statusCode).toBe(422);
    for (const password of ['too-short','a'.repeat(129)]) expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password}})).statusCode).toBe(422);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'https://evil.example'},payload:{username:'admin',password:originalPassword}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:originalPassword,testOnlyLegacyAuth:true}})).statusCode).toBe(422);
  });
  test('requires first password change, rotates all sessions, preserves exact spaces, and grants no implicit project',async () => {
    const admin = await bootstrap(); const credential = await create(admin); const first = await login('worker',credential.initialPassword); const duplicate = await login('worker',credential.initialPassword);
    expect(first.session.user!.mustChangePassword).toBe(true); expect(first.session.projects).toEqual([]);
    for (const url of [`${prefix}/tasks`,'/api/v1/admin/users']) expect((await app.inject({url,headers:{cookie:first.cookie}})).json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    now = new Date(now.getTime()+3600000);
    const password = `  ${newPassword}  `; const changed = await change(first,credential.initialPassword,password); expect(changed.session.user!.mustChangePassword).toBe(false); expect(changed.session.projects).toEqual([]); expect(changed.cookie).not.toBe(first.cookie);
    expect(changed.setCookie.split('; ')).toContain('Max-Age=604800'); expect(storedSession(changed)!.expires_at).toBe(now.getTime()+604800000);
    expect(db.prepare('SELECT token_digest FROM auth_sessions WHERE user_id=?').all(credential.user.id)).toEqual([{token_digest:tokenDigest(changed)}]);
    // A lost response cannot replay a write using revoked credentials; recover by session read or login.
    const retryBody = {currentPassword:credential.initialPassword,newPassword:password};
    expect((await app.inject({method:'POST',url:'/api/v1/auth/password',headers:headers(first),payload:retryBody})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/password',headers:{...headers(first),cookie:changed.cookie},payload:retryBody})).statusCode).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE action='password_change'").get() as {n:number}).n).toBe(1);
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:duplicate.cookie}})).json().data.user).toBeNull();
    expect((await app.inject({url:`${prefix}/tasks`,headers:{cookie:changed.cookie,'x-demo-actor':'zhou'}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'worker',password:password.trim()}})).statusCode).toBe(401); await login('worker',password);
  });
  test('linked account is scoped to active project member and cannot spoof notification or plan identity',async () => {
    const admin = await bootstrap(); const credential = await create(admin); const worker = await change(await login('worker',credential.initialPassword),credential.initialPassword);
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','chen',credential.user.id);
    const session = (await app.inject({url:'/api/v1/auth/session',headers:{cookie:worker.cookie}})).json().data as AuthSession; expect(session.projects).toMatchObject([{memberId:'chen',role:'member'}]);
    const tasks = await app.inject({url:`${prefix}/tasks`,headers:{cookie:worker.cookie,'x-demo-actor':'zhou'}}); expect(tasks.statusCode,tasks.body).toBe(200);
    for (const suffix of ['schedule/preview','schedule/apply','baselines']) expect((await app.inject({method:'POST',url:`${prefix}/${suffix}`,headers:{...headers(worker),'x-demo-actor':'zhou'},payload:{}})).json().error.code).toBe('MANAGER_REQUIRED');
    const notification = await app.inject({url:`${prefix}/notifications?actorId=zhou`,headers:{cookie:worker.cookie,'x-demo-actor':'zhou'}}); expect(notification.statusCode,notification.body).toBe(200); expect(notification.json().data.actorId).toBe('chen');
    expect((await app.inject({url:'/api/v1/projects/other/tasks',headers:{cookie:worker.cookie}})).statusCode).toBe(404);
    db.prepare("UPDATE project_members SET active=0 WHERE project_id='phase-one' AND id='chen'").run(); expect((await app.inject({url:`${prefix}/tasks`,headers:{cookie:worker.cookie}})).statusCode).toBe(404);
  });
  test('enforces administrator permissions, optimistic versions, last-admin/self guards, and idempotent updates',async () => {
    const admin = await bootstrap(); const credential = await create(admin); const worker = await change(await login('worker',credential.initialPassword),credential.initialPassword);
    for (const method of ['GET','POST'] as const) expect((await app.inject({method,url:'/api/v1/admin/users',headers:headers(worker),...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(403);
    expect((await patch(admin,admin.session.user!,{active:false})).json().error.code).toBe('LAST_ADMIN_REQUIRED'); await create(admin,'admin-two','admin');
    expect((await patch(admin,admin.session.user!,{systemRole:'user'})).json().error.code).toBe('SELF_DEMOTION_FORBIDDEN');
    const key = randomUUID(); const current = (await app.inject({url:'/api/v1/admin/users',headers:headers(admin)})).json().data.users.find((u:AuthUser)=>u.id===credential.user.id);
    const result = await patch(admin,current,{name:'改名后的账号'},key); expect(result.statusCode,result.body).toBe(200); expect((await patch(admin,current,{name:'改名后的账号'},key)).json()).toEqual(result.json());
    expect((await patch(admin,current,{name:'别的名字'},key)).json().error.code).toBe('IDEMPOTENCY_CONFLICT'); expect((await patch(admin,current,{name:'过期版本'})).json().error.code).toBe('VERSION_CONFLICT');
    expect((await patch(admin,result.json().data,{active:false})).statusCode).toBe(200); expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:worker.cookie}})).json().data.user).toBeNull(); expect(db.prepare('SELECT * FROM auth_sessions WHERE user_id=?').all(credential.user.id)).toEqual([]);
  });
  test('one-time credential replay cannot mutate twice or persist secrets; reset invalidates sessions',async () => {
    const admin = await bootstrap(); const request = {method:'POST' as const,url:'/api/v1/admin/users',headers:headers(admin),payload:{username:'new-worker',name:'新同事',systemRole:'user',canCreateProjects:false}};
    const response = await app.inject(request); expect(response.statusCode,response.body).toBe(200); const credential = response.json().data as IssuedCredential;
    expect((await app.inject(request)).json().error.code).toBe('CREDENTIAL_ALREADY_ISSUED');
    const worker = await login('new-worker',credential.initialPassword); const reset = {method:'POST' as const,url:`/api/v1/admin/users/${credential.user.id}/password-reset`,headers:headers(admin),payload:{expectedVersion:credential.user.version}};
    const resetResult = await app.inject(reset); expect(resetResult.statusCode,resetResult.body).toBe(200); const renewed = resetResult.json().data as IssuedCredential;
    expect(renewed.initialPassword).not.toBe(credential.initialPassword); expect((await app.inject(reset)).json().error.code).toBe('CREDENTIAL_ALREADY_ISSUED');
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:worker.cookie}})).json().data.user).toBeNull(); await login('new-worker',renewed.initialPassword);
    for (const table of ['auth_users','auth_sessions','auth_audit','auth_receipts','auth_login_attempts']) for (const secret of [originalPassword,credential.initialPassword,renewed.initialPassword]) expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(secret);
    expect((db.prepare('SELECT COUNT(*) AS n FROM auth_audit WHERE action=?').get('password_reset') as {n:number}).n).toBe(1);
  });
  test('login limits persist per account/IP and total IP, and expire after fifteen minutes',async () => {
    await bootstrap(); const attempt = (username = 'admin',remoteAddress = '127.0.0.1') => app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress,payload:{username,password:'incorrect-password-2026'}});
    for (let i=0;i<5;i++) expect((await attempt()).statusCode).toBe(401); expect((await attempt()).statusCode).toBe(429); expect((await attempt('admin','127.0.0.2')).statusCode).toBe(401);
    await app.close(); app = freshApp(); expect((await attempt()).statusCode).toBe(429);
    now = new Date(now.getTime()+15*60*1000); expect((await attempt()).statusCode).toBe(401);
    const ip = createHash('sha256').update('127.0.0.3').digest('hex'); const insert = db.prepare('INSERT INTO auth_login_attempts(account_digest,ip_digest,attempted_at) VALUES(?,?,?)'); for(let i=0;i<60;i++) insert.run(String(i),ip,now.getTime()); expect((await attempt('untested-account','127.0.0.3')).statusCode).toBe(429);
  });
  test('logout needs CSRF and clears cookie, while production cookies can be secure',async () => {
    const admin = await bootstrap(); expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{cookie:admin.cookie},payload:{}})).statusCode).toBe(403);
    const result = await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:headers(admin),payload:{}}); expect(result.statusCode).toBe(200); expect(result.headers['set-cookie']).toContain('Max-Age=0'); expect((await app.inject({url:`${prefix}/tasks`,headers:{cookie:admin.cookie}})).statusCode).toBe(401);
    await app.close(); app = buildApp({dbPath,clock:()=>now,secureCookies:true,jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0}); const response = await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:originalPassword}}); expect(response.headers['set-cookie']).toContain('; Secure');
  });
  test('logout clears anonymous, expired, disabled and revoked sessions while enforcing origin',async () => {
    const admin = await bootstrap();
    const logout = (cookie = admin.cookie, origin = 'http://localhost:5174') => app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{cookie,origin},payload:{}});
    expect((await logout()).statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:admin.cookie}})).json().data.user.id).toBe(admin.session.user!.id);
    now = new Date(now.getTime()+604800000);
    expect((await logout(admin.cookie,'https://evil.example')).statusCode).toBe(403);
    const expired = await logout(); expect(expired.statusCode).toBe(200); expect(expired.headers['set-cookie']).toContain('Max-Age=0'); expect(expired.json().data.user).toBeNull();
    const next = await login(); db.prepare('UPDATE auth_users SET active=0 WHERE id=?').run(admin.session.user!.id); expect((await logout(next.cookie)).statusCode).toBe(200);
    db.prepare('UPDATE auth_users SET active=1 WHERE id=?').run(admin.session.user!.id); const revoked = await login(); db.prepare('DELETE FROM auth_sessions').run(); expect((await logout(revoked.cookie)).statusCode).toBe(200); expect((await logout('')).statusCode).toBe(200);
  });
});
