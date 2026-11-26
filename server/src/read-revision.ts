import type Database from 'better-sqlite3';
/** Business revisions exclude sessions, notifications, job leases and derived TEMP indexes.
 * data_version additionally invalidates direct writes by another SQLite connection. */
export function readRevision(db: Database.Database, projectId: string, now: Date): string {
  const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const version = (table: string) => has(table) ? (db.prepare(`SELECT version FROM ${table} WHERE project_id=?`).get(projectId) as {version:number}|undefined)?.version ?? 0 : 0;
  const accounts = has('auth_users') ? JSON.stringify(db.prepare('SELECT id,version FROM auth_users ORDER BY id').all()) : '';
  return [version('plan_projects'),version('plan_order_projects'),version('plan_structure_versions'),version('settings_projects'),version('workstream_projects'),accounts,db.pragma('data_version',{simple:true}),new Date(now.getTime()+8*3600000).toISOString().slice(0,10)].join(':');
}
