import { isExistingDatabase } from '../../db/lifecycle.js';
import type Database from 'better-sqlite3';
import type { PersonalCapacity, ProjectMember } from '../../../../shared/src/settings.js';
import type { PersonName, TaskActor } from '../../../../shared/src/tasks.js';

const seedMembers: readonly ProjectMember[] = [
  { id: 'zhou', name: '周亦安', role: 'manager', active: true }, { id: 'chen', name: '陈知远', role: 'member', active: true },
  { id: 'lin', name: '林若宁', role: 'member', active: true }, { id: 'xu', name: '许景行', role: 'viewer', active: true },
];
export function hasTable(db: Database.Database, name: string): boolean { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
/** Rebuild the legacy CHECK constraint without renaming referenced tables. */
export function migrateProjectMembers(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_members'").get() as { sql: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(project_members)').all() as { name: string }[];
  if (table.sql.includes("'project_admin'") && columns.some(column => column.name === 'removed_at')) return;
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE project_members_migrating (project_id TEXT NOT NULL REFERENCES settings_projects(project_id), id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('manager','project_admin','member','viewer')), active INTEGER NOT NULL CHECK(active IN (0,1)), removed_at TEXT, PRIMARY KEY(project_id,id), UNIQUE(project_id,name));
        INSERT INTO project_members_migrating SELECT project_id,id,name,CASE WHEN role='reviewer' THEN 'member' ELSE role END,active,${columns.some(column => column.name === 'removed_at') ? 'removed_at' : 'NULL'} FROM project_members;
        DROP TABLE project_members;
        ALTER TABLE project_members_migrating RENAME TO project_members;`);
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Member migration foreign key validation failed');
    })();
  } finally { db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`); }
}
export function initializeSettings(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  migrateProjectMembers(db);
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS settings_projects (project_id TEXT PRIMARY KEY REFERENCES plan_projects(project_id), version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL REFERENCES settings_projects(project_id), id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('manager','project_admin','member','viewer')), active INTEGER NOT NULL CHECK(active IN (0,1)), removed_at TEXT, PRIMARY KEY(project_id,id), UNIQUE(project_id,name));
      CREATE TABLE IF NOT EXISTS member_capacities (project_id TEXT NOT NULL, member_id TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(project_id,member_id), FOREIGN KEY(project_id,member_id) REFERENCES project_members(project_id,id));
      CREATE TABLE IF NOT EXISTS settings_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES settings_projects(project_id), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)));
      CREATE TABLE IF NOT EXISTS settings_idempotency (project_id TEXT NOT NULL REFERENCES settings_projects(project_id), request_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)), PRIMARY KEY(project_id,request_key));`);
    for (const { project_id } of db.prepare('SELECT project_id FROM plan_projects').all() as { project_id: string }[]) {
      if (db.prepare('SELECT project_id FROM settings_projects WHERE project_id=?').get(project_id)) continue;
      db.prepare('INSERT INTO settings_projects(project_id) VALUES (?)').run(project_id);
      for (const member of seedMembers) {
        db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES (?,?,?,?,?)').run(project_id, member.id, member.name, member.role, 1);
        db.prepare('INSERT INTO member_capacities VALUES (?,?,?)').run(project_id, member.id, JSON.stringify({ memberId: member.id, hoursPerDay: null, exceptions: {} }));
      }
    }
  })();
}
/** Independent legacy repository tests may initialize tasks without settings. Fallback is read-only and freshly copied per database read. */
export function readMembers(db: Database.Database, projectId: string): ProjectMember[] {
  if (!hasTable(db, 'project_members')) return seedMembers.map(member => ({ ...member }));
  const linked = hasTable(db, 'project_user_links') && hasTable(db, 'auth_users');
  const sql = linked ? `SELECT m.id,m.name,m.role,m.active,m.removed_at AS removedAt,l.user_id AS userId,u.username,u.active AS accountActive
    FROM project_members m LEFT JOIN project_user_links l ON l.project_id=m.project_id AND l.member_id=m.id
    LEFT JOIN auth_users u ON u.id=l.user_id WHERE m.project_id=? ORDER BY m.rowid` : 'SELECT id,name,role,active,removed_at AS removedAt FROM project_members WHERE project_id=? ORDER BY rowid';
  return (db.prepare(sql).all(projectId) as Array<Omit<ProjectMember, 'active'|'accountActive'> & { active: number; accountActive?: number|null }>).map(({ accountActive, ...member }) => ({ ...member, active: Boolean(member.active), ...(member.userId ? { accountActive: Boolean(accountActive) } : {}) }));
}
/** Names remain readable after account/member deactivation; this is not an actor directory. */
export function readPeople(db: Database.Database, projectId: string, referencedIds: Array<string | null | undefined> = []): PersonName[] {
  const people = new Map(readMembers(db, projectId).map(({ id, name }) => [id, { id, name }]));
  if (hasTable(db, 'auth_users')) {
    const references = [...new Set(referencedIds.filter((id): id is string => Boolean(id)))];
    // A former administrator may now be an ordinary/disabled account, but its
    // submission ID must still resolve. Include only referenced former accounts.
    const accounts = db.prepare("SELECT id,name FROM auth_users WHERE system_role='admin' OR id IN (SELECT value FROM json_each(?))").all(JSON.stringify(references)) as PersonName[];
    for (const person of accounts) if (!people.has(person.id)) people.set(person.id, person);
  }
  return [...people.values()];
}
export function readActors(db: Database.Database, projectId: string): TaskActor[] {
  const actors = readMembers(db, projectId).filter(member => !member.removedAt && member.active && member.accountActive !== false).map(({ removedAt: _removedAt, active: _active, userId: _userId, username: _username, accountActive: _accountActive, ...actor }) => actor);
  if (!hasTable(db, 'auth_users')) return actors;
  // Disabling an account immediately removes its linked execution identity, while
  // readMembers retains the historical member and all task/capacity references.
  const disabled = hasTable(db, 'project_user_links') ? new Set((db.prepare(`SELECT l.member_id FROM project_user_links l
    JOIN auth_users u ON u.id=l.user_id WHERE l.project_id=? AND u.active=0`).all(projectId) as { member_id: string }[]).map(row => row.member_id)) : new Set<string>();
  const available = actors.filter(actor => !disabled.has(actor.id));
  // Global administrators can operate under their own account identity. They
  // are not project staffing records and must never receive task/risk ownership.
  if (!hasTable(db, 'settings_projects') || !db.prepare('SELECT 1 FROM settings_projects WHERE project_id=?').get(projectId)) return available;
  const linkedUsers = hasTable(db, 'project_user_links') ? new Set((db.prepare(`SELECT l.user_id FROM project_user_links l
    JOIN project_members m ON m.project_id=l.project_id AND m.id=l.member_id
    WHERE l.project_id=? AND m.active=1`).all(projectId) as { user_id: string }[]).map(row => row.user_id)) : new Set<string>();
  const admins = db.prepare("SELECT id,name FROM auth_users WHERE active=1 AND system_role='admin' ORDER BY created_at,id").all() as { id: string; name: string }[];
  for (const admin of admins) {
    if (linkedUsers.has(admin.id)) {
      const link = db.prepare('SELECT member_id FROM project_user_links WHERE project_id=? AND user_id=?').get(projectId, admin.id) as { member_id: string };
      const existing = available.find(actor => actor.id === link.member_id);
      if (existing) existing.role = 'manager';
      continue;
    }
    const existing = available.findIndex(actor => actor.id === admin.id);
    const actor: TaskActor = { ...admin, role: 'manager', assignable: false };
    if (existing >= 0) available[existing] = actor; else available.push(actor);
  }
  return available;
}
export function readCapacities(db: Database.Database, projectId: string): PersonalCapacity[] {
  if (!hasTable(db, 'member_capacities')) return readMembers(db, projectId).map(member => ({ memberId: member.id, hoursPerDay: null, exceptions: {} }));
  return (db.prepare('SELECT snapshot_json FROM member_capacities WHERE project_id=? ORDER BY rowid').all(projectId) as { snapshot_json: string }[]).map(row => JSON.parse(row.snapshot_json));
}
