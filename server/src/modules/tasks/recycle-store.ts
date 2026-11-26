import type Database from 'better-sqlite3';
import type {ManagedTask} from '../../../../shared/src/tasks.js';
import { isExistingDatabase } from '../../db/lifecycle.js';

/** Also called by the explicit offline upgrade command, never by existing-only startup. */
export function migrateTaskRecycle(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS task_recycle (
      project_id TEXT NOT NULL REFERENCES homepage_projects(id),task_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),deleted_at TEXT,
      history_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(history_json)),PRIMARY KEY(project_id,task_id));
      CREATE INDEX IF NOT EXISTS task_recycle_deleted ON task_recycle(project_id,deleted_at);
      CREATE TABLE IF NOT EXISTS task_recycle_receipts (
      project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_key));
      CREATE TABLE IF NOT EXISTS task_recycle_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT OR IGNORE INTO task_recycle_schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
  })();
}
export function initializeTaskRecycle(db: Database.Database) { if (!isExistingDatabase(db)) migrateTaskRecycle(db); }
export function taskIsDeleted(db: Database.Database, projectId: string, taskId: string) {
  return Boolean(db.prepare('SELECT 1 FROM task_recycle WHERE project_id=? AND task_id=? AND deleted_at IS NOT NULL').get(projectId,taskId));
}
export function readDeletedTaskSnapshots(db:Database.Database,projectId:string):ManagedTask[] {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_recycle'").get())return [];
  return (db.prepare("SELECT json_extract(snapshot_json,'$.task') AS task FROM task_recycle WHERE project_id=? AND deleted_at IS NOT NULL").all(projectId) as {task:string}[]).map(r=>JSON.parse(r.task));
}
