import { isProjectManager } from '../../../../shared/src/permissions.js';
import { setRequestManagementAccess } from './project-access.js';
import { hasTable } from '../settings/store.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser, UserCreate, UserUpdate } from '../../../../shared/src/auth.js';
import { PlanError } from '../planning/errors.js';
import { hashPassword, initialPassword, validatePassword, verifyPassword } from './passwords.js';
import { audit, COOKIE_NAME, digest, initializeAuth, issueSession, projectsForUser, publicUser, readSession, SESSION_MS, sessionView, userById, validName, validUsername, type SessionRecord, type UserRow } from './store.js';
export { initializeAuth, createInitialAdmin, readSession, projectsForUser } from './store.js';

export function readActiveAdmins(db: Database.Database): AuthUser[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='auth_users'").get()) return [];
  return (db.prepare("SELECT * FROM auth_users WHERE active=1 AND system_role='admin'").all() as UserRow[]).map(publicUser);
}
function body(request: FastifyRequest, fields: string[]): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value,key))) throw new PlanError(422,'INVALID_BODY','请求字段不完整或包含不支持的内容。');
  return value as Record<string, unknown>;
}
function version(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new PlanError(422,'INVALID_VERSION','请刷新账号资料后重试。'); }
function role(value: unknown): asserts value is AuthUser['systemRole'] { if (value !== 'admin' && value !== 'user') throw new PlanError(422,'INVALID_ROLE','账号角色无效。'); }
function bool(value: unknown): asserts value is boolean { if (typeof value !== 'boolean') throw new PlanError(422,'INVALID_BODY','账号开关必须为布尔值。'); }
interface Receipt { request_hash: string; credential: number; response_json: string|null }
export interface AuthOptions { secureCookies?: boolean; allowedOrigins?: string[] }
export function registerAuthRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, options: AuthOptions = {}) {
  initializeAuth(db);
  const origins = new Set(options.allowedOrigins ?? ['http://127.0.0.1:5174','http://localhost:5174','http://127.0.0.1:3100','http://localhost:3100']);
  const secure = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const cookie = (reply: FastifyReply, token: string, clear = false) => reply.header('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  const originCheck = (request: FastifyRequest) => { if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) throw new PlanError(403,'ORIGIN_FORBIDDEN','此页面来源无权提交请求。'); };
  const requireSession = (request: FastifyRequest, allowFirstChange = false) => {
    const session = readSession(db,request,clock());
    if (!session) throw new PlanError(401,'AUTH_REQUIRED','登录已失效，请重新登录。填写中的内容会保留。');
    if (!allowFirstChange && session.user.mustChangePassword) throw new PlanError(403,'PASSWORD_CHANGE_REQUIRED','请先修改初始密码。');
    return session;
  };
  const protectWrite = async (request: FastifyRequest) => {
    originCheck(request);
    const session = requireSession(request, /^\/api\/v1\/auth\/(password|logout)(?:\?|$)/.test(request.url));
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(session.csrfToken) || !timingSafeEqual(Buffer.from(token),Buffer.from(session.csrfToken))) throw new PlanError(403,'CSRF_REQUIRED','安全凭据已失效，请刷新登录状态后重试。');
  };
  const requireAdmin = (request: FastifyRequest) => { const session = requireSession(request); if (session.user.systemRole !== 'admin') throw new PlanError(403,'ADMIN_REQUIRED','仅系统管理员可以管理账号。'); return session; };
  const authorizeBusiness = async (request: FastifyRequest) => {
    // Matched routes are canonical even for HTTP absolute-form request targets.
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/api/v1/') || /^\/api\/v1\/(auth|admin)(?:\/|$)/.test(route)) return;
    const session = requireSession(request);
    const projectId = (request.params as { projectId?: string }).projectId;
    if (projectId) {
      const project = projectsForUser(db,session.user).find(item => item.id === projectId);
      if (!project) throw new PlanError(404,'PROJECT_NOT_FOUND','项目不存在或当前账号无权访问。');
      const management = session.user.systemRole === 'admin' || isProjectManager(project.role);
      setRequestManagementAccess(request, management);
      const domain = route.replace('/api/v1/projects/:projectId', '').split('/')[1];
      if (!management && ['analytics', 'risks', 'settings', 'memberships', 'integrations'].includes(domain ?? '')) {
        throw new PlanError(403, 'PROJECT_MODULE_FORBIDDEN', '该功能仅向项目负责人、项目管理员和系统管理员开放。');
      }
      request.headers['x-demo-actor'] = project.memberId;
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && project.role === 'viewer') throw new PlanError(403,'PROJECT_READ_ONLY','只读成员不能修改项目数据。');
      if (['GET','HEAD'].includes(request.method) && /\/(?:notifications|revision)$/.test(route) && request.query && typeof request.query === 'object') (request.query as Record<string, unknown>).actorId = project.memberId;
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && /\/(?:schedule\/(?:preview|apply)|plan\/order|baselines)$/.test(route) && !isProjectManager(project.role)) throw new PlanError(403,'MANAGER_REQUIRED','仅项目负责人或管理员可以修改项目计划。');
    } else request.headers['x-demo-actor'] = session.user.id;
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) await protectWrite(request);
  };
  const actorId = (request: FastifyRequest, projectId: string) => {
    const session = requireSession(request); const project = projectsForUser(db,session.user).find(item => item.id === projectId);
    if (!project) throw new PlanError(404,'PROJECT_NOT_FOUND','项目不存在或当前账号无权访问。'); return project.memberId;
  };
  function receipt(request: FastifyRequest, actor: string, operation: string, input: unknown) {
    const key = request.headers['idempotency-key']; if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new PlanError(422,'IDEMPOTENCY_KEY_REQUIRED','请求标识无效，请重试。');
    const hash = digest(JSON.stringify(input));
    const previous = db.prepare('SELECT request_hash,credential,response_json FROM auth_receipts WHERE actor_id=? AND request_key=?').get(actor,key) as Receipt|undefined;
    if (previous) {
      if (previous.request_hash !== digest(`${operation}:${hash}`)) throw new PlanError(409,'IDEMPOTENCY_CONFLICT','此请求标识已用于其他操作，请刷新后重试。');
      if (previous.credential) throw new PlanError(409,'CREDENTIAL_ALREADY_ISSUED','初始密码已生成且仅显示一次。请刷新账号列表，核对账号后重新重置密码。');
    }
    return { previous: previous?.response_json ? JSON.parse(previous.response_json) : undefined, save: (response: unknown, credential = false) => db.prepare('INSERT INTO auth_receipts VALUES(?,?,?,?,?,?)').run(actor,key,operation,digest(`${operation}:${hash}`),Number(credential),credential ? null : JSON.stringify(response)) };
  }
  const routeOptions = { bodyLimit: 4096 };
  app.get('/api/v1/auth/session',(request,reply) => { reply.header('Cache-Control','no-store'); return { data: sessionView(db,readSession(db,request,clock())) }; });
  app.post('/api/v1/auth/login',routeOptions,async (request,reply) => {
    originCheck(request); const input = body(request,['username','password']); validUsername(input.username); validatePassword(input.password);
    const now = clock(); const username = input.username.toLowerCase(); const account = digest(username); const ip = digest(request.ip);
    db.prepare('DELETE FROM auth_login_attempts WHERE attempted_at<=?').run(now.getTime()-15*60*1000);
    const limits = db.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN account_digest=? THEN 1 ELSE 0 END) AS account FROM auth_login_attempts WHERE ip_digest=?').get(account,ip) as { total: number; account: number };
    if (limits.account >= 5 || limits.total >= 60) throw new PlanError(429,'LOGIN_RATE_LIMITED','登录尝试过多，请在 15 分钟后重试。');
    // Reserve a failure slot before awaiting hashing so concurrent requests cannot bypass limits.
    const attempt = db.prepare('INSERT INTO auth_login_attempts(account_digest,ip_digest,attempted_at) VALUES(?,?,?)').run(account,ip,now.getTime()).lastInsertRowid;
    const user = db.prepare('SELECT * FROM auth_users WHERE username=?').get(username) as UserRow|undefined;
    let correct: boolean;
    try { correct = await verifyPassword(input.password,user?.password_hash); } catch (error) { db.prepare('DELETE FROM auth_login_attempts WHERE id=?').run(attempt); throw error; }
    const current = user ? userById(db,user.id) : undefined;
    if (!correct || !current?.active || current.password_hash !== user?.password_hash) throw new PlanError(401,'INVALID_CREDENTIALS','账号或密码不正确，或账号已停用。');
    db.prepare('DELETE FROM auth_login_attempts WHERE id=?').run(attempt);
    const old = readSession(db,request,now); if (old) db.prepare('DELETE FROM auth_sessions WHERE token_digest=?').run(old.tokenDigest);
    const issued = issueSession(db,publicUser(current),now); cookie(reply,issued.token); reply.header('Cache-Control','no-store'); return { data: sessionView(db,issued.record) };
  });
  app.post('/api/v1/auth/logout',routeOptions,async (request,reply) => {
    originCheck(request); body(request,[]); const session = readSession(db,request,clock());
    // Expired, disabled, or revoked sessions can always discard their stale cookie.
    // A live session still requires its bound CSRF token before revocation.
    if (session) { await protectWrite(request); db.prepare('DELETE FROM auth_sessions WHERE token_digest=?').run(session.tokenDigest); }
    cookie(reply,'',true); reply.header('Cache-Control','no-store'); return { data: sessionView(db,null) };
  });
  app.post('/api/v1/auth/password',{ ...routeOptions, preHandler: protectWrite },async (request,reply) => {
    const input = body(request,['currentPassword','newPassword']); validatePassword(input.currentPassword); validatePassword(input.newPassword);
    if (input.currentPassword === input.newPassword) throw new PlanError(422,'PASSWORD_UNCHANGED','新密码不能与当前密码相同。');
    const session = requireSession(request,true); const replay = receipt(request,session.user.id,'password',input);
    if (replay.previous) return { data: sessionView(db,session) };
    const user = userById(db,session.user.id)!;
    if (!await verifyPassword(input.currentPassword,user.password_hash)) throw new PlanError(422,'CURRENT_PASSWORD_INCORRECT','当前密码不正确。');
    const hash = await hashPassword(input.newPassword);
    const issued = db.transaction(() => {
      requireSession(request,true);
      const current = userById(db,user.id)!; if (current.version !== user.version || current.password_hash !== user.password_hash) throw new PlanError(409,'VERSION_CONFLICT','账号已更新，请重新登录后重试。');
      db.prepare('UPDATE auth_users SET password_hash=?,must_change_password=0,version=version+1,updated_at=? WHERE id=?').run(hash,clock().toISOString(),user.id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id); audit(db,user.id,user.id,'password_change',clock()); replay.save({ changed: true }); return issueSession(db,publicUser(userById(db,user.id)!),clock());
    })();
    cookie(reply,issued.token); reply.header('Cache-Control','no-store'); return { data: sessionView(db,issued.record) };
  });
  app.get('/api/v1/admin/users',(request,reply) => { requireAdmin(request); reply.header('Cache-Control','no-store'); return { data: { users: (db.prepare('SELECT * FROM auth_users ORDER BY created_at,id').all() as UserRow[]).map(publicUser) } }; });
  app.post('/api/v1/admin/users',{ ...routeOptions, preHandler: protectWrite },async (request,reply) => {
    const admin = requireAdmin(request); const input = body(request,['username','name','systemRole','canCreateProjects']); validUsername(input.username); validName(input.name); role(input.systemRole); bool(input.canCreateProjects);
    const create = input as unknown as UserCreate; receipt(request,admin.user.id,'user_create',input);
    if (db.prepare('SELECT id FROM auth_users WHERE username=?').get(create.username.toLowerCase())) throw new PlanError(409,'USERNAME_EXISTS','此登录账号已存在。');
    const password = initialPassword(); const hash = await hashPassword(password);
    const user = db.transaction(() => {
      requireAdmin(request); const replay = receipt(request,admin.user.id,'user_create',input);
      if (db.prepare('SELECT id FROM auth_users WHERE username=?').get(create.username.toLowerCase())) throw new PlanError(409,'USERNAME_EXISTS','此登录账号已存在。');
      const id = randomUUID(); const now = clock(); db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,create.username.toLowerCase(),create.name.trim(),create.systemRole,1,Number(create.canCreateProjects),1,1,hash,now.toISOString(),now.toISOString());
      audit(db,admin.user.id,id,'user_create',now); replay.save(null,true); return publicUser(userById(db,id)!);
    })(); reply.header('Cache-Control','no-store'); return { data: { user, initialPassword: password } };
  });
  app.patch<{ Params: { id: string } }>('/api/v1/admin/users/:id',{ ...routeOptions, preHandler: protectWrite },(request) => {
    const admin = requireAdmin(request); const input = body(request,['expectedVersion','name','systemRole','active','canCreateProjects']); version(input.expectedVersion); validName(input.name); role(input.systemRole); bool(input.active); bool(input.canCreateProjects); const update = input as unknown as UserUpdate;
    return db.transaction(() => {
      const replay = receipt(request,admin.user.id,`user_update:${request.params.id}`,input); if (replay.previous) return { data: replay.previous };
      const user = userById(db,request.params.id); if (!user) throw new PlanError(404,'USER_NOT_FOUND','账号不存在。');
      if (user.version !== update.expectedVersion) throw new PlanError(409,'VERSION_CONFLICT','账号已被更新，请刷新后重新核对。');
      if (user.system_role === 'admin' && user.active && (!update.active || update.systemRole !== 'admin')) {
        if ((db.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE active=1 AND system_role='admin'").get() as { n: number }).n <= 1) throw new PlanError(422,'LAST_ADMIN_REQUIRED','必须保留至少一名启用的系统管理员。');
        if (user.id === admin.user.id) throw new PlanError(422,'SELF_DEMOTION_FORBIDDEN','不能停用自己或取消自己的管理员角色。');
      }
      if (user.active && !update.active) {
        const owned = db.prepare(`SELECT m.project_id FROM project_members m JOIN project_user_links l ON l.project_id=m.project_id AND l.member_id=m.id
          WHERE l.user_id=? AND m.role='manager' AND m.active=1 AND m.removed_at IS NULL`).all(user.id) as { project_id: string }[];
        for (const project of owned) {
          const other = db.prepare(`SELECT 1 FROM project_members m LEFT JOIN project_user_links l ON l.project_id=m.project_id AND l.member_id=m.id
            LEFT JOIN auth_users u ON u.id=l.user_id WHERE m.project_id=? AND m.role='manager' AND m.active=1 AND m.removed_at IS NULL
            AND (l.user_id IS NULL OR (l.user_id<>? AND u.active=1)) LIMIT 1`).get(project.project_id, user.id);
          if (!other) throw new PlanError(422, 'LAST_MANAGER_REQUIRED', '此账号仍是项目唯一有效负责人，请先移交项目负责人再停用账号。');
        }
        if (hasTable(db, 'risk_records')) {
          const duty = db.prepare(`SELECT r.id,r.project_id,json_extract(r.snapshot_json,'$.title') AS title
            FROM risk_records r JOIN project_user_links l ON l.project_id=r.project_id
            JOIN project_members m ON m.project_id=l.project_id AND m.id=l.member_id
            WHERE l.user_id=? AND m.active=1 AND m.removed_at IS NULL
            AND json_extract(r.snapshot_json,'$.status')<>'closed'
            AND (json_extract(r.snapshot_json,'$.ownerId')=m.id OR json_extract(r.snapshot_json,'$.closeReviewerId')=m.id)
            ORDER BY r.project_id,r.id LIMIT 1`).get(user.id) as {id:string;project_id:string;title:string}|undefined;
          if (duty) throw new PlanError(422, 'ACCOUNT_HAS_RISK_RESPONSIBILITIES', `此账号仍承担未关闭风险「${duty.title}」的负责或复核职责，请先移交后再停用账号。`, {projectId:duty.project_id,riskId:duty.id});
        }
      }
      db.prepare('UPDATE auth_users SET name=?,system_role=?,active=?,can_create_projects=?,version=version+1,updated_at=? WHERE id=?').run(update.name.trim(),update.systemRole,Number(update.active),Number(update.canCreateProjects),clock().toISOString(),user.id);
      if (!update.active || update.systemRole !== user.system_role) db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
      audit(db,admin.user.id,user.id,'user_update',clock()); const result = publicUser(userById(db,user.id)!); replay.save(result); return { data: result };
    })();
  });
  app.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/password-reset',{ ...routeOptions, preHandler: protectWrite },async (request,reply) => {
    const admin = requireAdmin(request); const input = body(request,['expectedVersion']); version(input.expectedVersion); receipt(request,admin.user.id,`password_reset:${request.params.id}`,input);
    const password = initialPassword(); const hash = await hashPassword(password);
    const user = db.transaction(() => {
      requireAdmin(request); const replay = receipt(request,admin.user.id,`password_reset:${request.params.id}`,input); const current = userById(db,request.params.id);
      if (!current) throw new PlanError(404,'USER_NOT_FOUND','账号不存在。');
      if (current.version !== input.expectedVersion) throw new PlanError(409,'VERSION_CONFLICT','账号已被更新，请刷新后重新核对。');
      db.prepare('UPDATE auth_users SET password_hash=?,must_change_password=1,version=version+1,updated_at=? WHERE id=?').run(hash,clock().toISOString(),current.id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(current.id); audit(db,admin.user.id,current.id,'password_reset',clock()); replay.save(null,true); return publicUser(userById(db,current.id)!);
    })(); reply.header('Cache-Control','no-store'); return { data: { user, initialPassword: password } };
  });
  const actorName = (request: FastifyRequest) => requireSession(request).user.name;
  const systemAdmin = (request: FastifyRequest) => requireSession(request).user.systemRole === 'admin';
  const accountId = (request: FastifyRequest) => requireSession(request).user.id;
  return { authorizeBusiness, protectWrite, actorId, actorName, systemAdmin, accountId };
}
