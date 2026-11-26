import { isExistingDatabase } from '../db/lifecycle.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BackgroundJob } from '../../../shared/src/notifications.js';

export type JobKind = BackgroundJob['kind'];
export interface StoredJob extends BackgroundJob { projectId: string; dedupeKey: string; payload: unknown; leaseToken: string | null; leaseUntil: string | null }
const names: Record<JobKind, string> = { notification: '站内通知投递', risk_evaluate: '风险自动巡检', snapshot: '日终数据快照', backup: '本机一致性备份', feishu_delivery: '飞书机器人投递' };
export function initializeJobs(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  // Rebuild only the legacy CHECK; no referenced table is renamed or data discarded.
  const legacy = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_jobs'").get() as {sql:string}|undefined;
  if (legacy && !legacy.sql.includes("'feishu_delivery'")) db.transaction(() => {
    db.exec(legacy.sql.replace('CREATE TABLE background_jobs', 'CREATE TABLE background_jobs_feishu_migration').replace("'backup'", "'backup','feishu_delivery'"));
    db.exec('INSERT INTO background_jobs_feishu_migration SELECT * FROM background_jobs; DROP TABLE background_jobs; ALTER TABLE background_jobs_feishu_migration RENAME TO background_jobs;');
  })();
  db.exec(`CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES homepage_projects(id), kind TEXT NOT NULL CHECK(kind IN ('notification','risk_evaluate','snapshot','backup','feishu_delivery')),
    dedupe_key TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','missed')), attempts INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, error TEXT, summary TEXT NOT NULL,
    lease_token TEXT, lease_until TEXT, manual_retries INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id,kind,dedupe_key));
    CREATE INDEX IF NOT EXISTS background_jobs_due ON background_jobs(status,due_at);
    CREATE INDEX IF NOT EXISTS background_jobs_ready ON background_jobs(status,due_at,id);
    CREATE INDEX IF NOT EXISTS background_jobs_kind_due ON background_jobs(kind,status,due_at,id);
    CREATE TABLE IF NOT EXISTS background_job_schedules (
      project_id TEXT NOT NULL REFERENCES homepage_projects(id), kind TEXT NOT NULL, next_due_at TEXT NOT NULL,
      PRIMARY KEY(project_id,kind));`);
}
export function enqueueJob(db: Database.Database, input: { projectId: string; kind: JobKind; dedupeKey: string; payload: unknown; dueAt: Date | string }, now: Date): string {
  const due = new Date(input.dueAt).toISOString();
  const id = `job-${randomUUID()}`;
  db.prepare(`INSERT INTO background_jobs(id,project_id,kind,dedupe_key,payload_json,status,due_at,created_at,summary)
    VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(project_id,kind,dedupe_key) DO NOTHING`).run(id, input.projectId, input.kind, input.dedupeKey, JSON.stringify(input.payload ?? {}), due, now.toISOString(), names[input.kind]);
  return (db.prepare('SELECT id FROM background_jobs WHERE project_id=? AND kind=? AND dedupe_key=?').get(input.projectId, input.kind, input.dedupeKey) as {id:string}).id;
}
interface JobRow { id:string; project_id:string; kind:JobKind; dedupe_key:string; payload_json:string; status:BackgroundJob['status']; attempts:number; due_at:string; created_at:string; finished_at:string|null; error:string|null; summary:string; lease_token:string|null; lease_until:string|null }
export function readJob(db: Database.Database, id: string): StoredJob | undefined {
  const row = db.prepare('SELECT * FROM background_jobs WHERE id=?').get(id) as JobRow | undefined;
  return row ? { id:row.id,projectId:row.project_id,kind:row.kind,dedupeKey:row.dedupe_key,payload:JSON.parse(row.payload_json),status:row.status,attempts:row.attempts,dueAt:row.due_at,createdAt:row.created_at,finishedAt:row.finished_at,error:row.error,summary:row.summary,leaseToken:row.lease_token,leaseUntil:row.lease_until } : undefined;
}
export function listJobs(db: Database.Database, projectId: string): BackgroundJob[] {
  return (db.prepare('SELECT id FROM background_jobs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(projectId) as {id:string}[]).map(({id}) => {
    const { projectId: _project, dedupeKey: _key, payload: _payload, leaseToken: _token, leaseUntil: _lease, ...job } = readJob(db,id)!;
    return job;
  });
}
/** The caller owns actor/token/origin checks and its idempotency transaction. */
export function retryFailedJob(db: Database.Database, projectId: string, jobId: string, now: Date): boolean {
  return db.prepare(`UPDATE background_jobs SET status='pending',attempts=0,due_at=?,finished_at=NULL,error=NULL,lease_token=NULL,lease_until=NULL,manual_retries=manual_retries+1
    WHERE id=? AND project_id=? AND status='failed' AND kind!='feishu_delivery'`).run(now.toISOString(),jobId,projectId).changes === 1;
}
