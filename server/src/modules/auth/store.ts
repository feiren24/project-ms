import { isExistingDatabase } from '../../db/lifecycle.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { managementCapabilities } from './project-access.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import type { AuthProject, AuthSession, AuthUser } from '../../../../shared/src/auth.js';
import { PlanError } from '../planning/errors.js';
import { hashPassword } from './passwords.js';

export const COOKIE_NAME = 'goodwork_session';
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export interface UserRow { id: string; username: string; name: string; system_role: 'admin'|'user'; active: number; can_create_projects: number; must_change_password: number; version: number; password_hash: string }
export interface SessionRecord { user: AuthUser; tokenDigest: string; csrfToken: string; expiresAt: number }
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function initializeAuth(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    system_role TEXT NOT NULL CHECK(system_role IN ('admin','user')), active INTEGER NOT NULL CHECK(active IN(0,1)),
    can_create_projects INTEGER NOT NULL CHECK(can_create_projects IN(0,1)), must_change_password INTEGER NOT NULL CHECK(must_change_password IN(0,1)),
    version INTEGER NOT NULL DEFAULT 1, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions(token_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_login_attempts(id INTEGER PRIMARY KEY, account_digest TEXT NOT NULL, ip_digest TEXT NOT NULL, attempted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_login_attempt_window ON auth_login_attempts(ip_digest,attempted_at);
    CREATE TABLE IF NOT EXISTS auth_audit(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_receipts(actor_id TEXT NOT NULL, request_key TEXT NOT NULL, operation TEXT NOT NULL, request_hash TEXT NOT NULL, credential INTEGER NOT NULL, response_json TEXT, PRIMARY KEY(actor_id,request_key));
    CREATE TABLE IF NOT EXISTS project_user_links(project_id TEXT NOT NULL REFERENCES homepage_projects(id),member_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES auth_users(id), PRIMARY KEY(project_id,member_id), UNIQUE(project_id,user_id));`);
}
export function publicUser(row: UserRow): AuthUser {
  return { id: row.id, username: row.username, name: row.name, systemRole: row.system_role, active: Boolean(row.active), canCreateProjects: Boolean(row.can_create_projects), mustChangePassword: Boolean(row.must_change_password), version: row.version };
}
export function userById(db: Database.Database, id: string): UserRow | undefined { return db.prepare('SELECT * FROM auth_users WHERE id=?').get(id) as UserRow|undefined; }
export function validUsername(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,47}$/.test(value)) throw new PlanError(422, 'INVALID_USERNAME', '账号须为 3–48 位字母、数字、点、下划线或短横线，且以字母或数字开头。');
}
export function validName(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new PlanError(422, 'INVALID_NAME', '请输入不超过 80 字的姓名。'); }
export function audit(db: Database.Database, actor: string, target: string, action: string, now: Date) { db.prepare('INSERT INTO auth_audit VALUES(?,?,?,?,?)').run(randomUUID(), actor, target, action, now.toISOString()); }
export async function createInitialAdmin(db: Database.Database, input: { username: string; name: string; password: string }, now = new Date()): Promise<AuthUser> {
  initializeAuth(db); validUsername(input.username); validName(input.name);
  if (db.prepare('SELECT id FROM auth_users LIMIT 1').get()) throw new PlanError(409, 'ALREADY_INITIALIZED', '账号系统已初始化，请使用现有管理员管理账号。');
  const hash = await hashPassword(input.password);
  return db.transaction(() => {
    if (db.prepare('SELECT id FROM auth_users LIMIT 1').get()) throw new PlanError(409, 'ALREADY_INITIALIZED', '账号系统已初始化。');
    const id = randomUUID();
    db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,input.username.toLowerCase(),input.name.trim(),'admin',1,1,0,1,hash,now.toISOString(),now.toISOString());
    audit(db,id,id,'bootstrap',now); return publicUser(userById(db,id)!);
  })();
}
export function readSession(db: Database.Database, request: FastifyRequest, now = new Date()): SessionRecord|null {
  const matches = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(COOKIE_NAME.length + 1);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
  const tokenDigest = digest(token);
  const row = db.prepare('SELECT user_id,csrf_token,expires_at FROM auth_sessions WHERE token_digest=?').get(tokenDigest) as { user_id: string; csrf_token: string; expires_at: number }|undefined;
  if (!row || row.expires_at <= now.getTime()) return null;
  const user = userById(db,row.user_id); if (!user?.active) return null;
  return { user: publicUser(user), tokenDigest, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}
export function issueSession(db: Database.Database, user: AuthUser, now: Date): { token: string; record: SessionRecord } {
  const token = randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('base64url'); const expiresAt = now.getTime() + SESSION_MS;
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now.getTime());
  db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').run(digest(token),user.id,csrfToken,expiresAt);
  return { token, record: { user, tokenDigest: digest(token), csrfToken, expiresAt } };
}
export function projectsForUser(db: Database.Database, user: AuthUser): AuthProject[] {
  if (user.mustChangePassword) return [];
  const projects = db.prepare('SELECT id,snapshot_json FROM homepage_projects ORDER BY rowid').all() as { id: string; snapshot_json: string }[];
  return projects.flatMap(project => {
    const name = JSON.parse(project.snapshot_json).project.name as string;
    const member = db.prepare('SELECT m.id,m.role FROM project_user_links l JOIN project_members m ON m.project_id=l.project_id AND m.id=l.member_id WHERE l.project_id=? AND l.user_id=? AND m.active=1 AND m.removed_at IS NULL').get(project.id,user.id) as { id: string; role: AuthProject['role'] }|undefined;
    if (user.systemRole === 'admin') return [{ id: project.id, name, memberId: member?.id ?? user.id, role: 'manager' as const, capabilities: managementCapabilities(true) }];
    return member ? [{ id: project.id, name, memberId: member.id, role: member.role, capabilities: managementCapabilities(isProjectManager(member.role)) }] : [];
  });
}
export function sessionView(db: Database.Database, session: SessionRecord|null): AuthSession {
  return { user: session?.user ?? null, csrfToken: session?.csrfToken ?? '', projects: session ? projectsForUser(db,session.user) : [], initialized: Boolean(db.prepare('SELECT id FROM auth_users LIMIT 1').get()) };
}
