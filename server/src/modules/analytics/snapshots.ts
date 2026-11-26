import { isExistingDatabase } from '../../db/lifecycle.js';
import type Database from 'better-sqlite3';
import type { AnalyticsTask } from '../../../../shared/src/analytics.js';
import type { PlanNode } from '../../../../shared/src/planning.js';
import { readTasks } from '../tasks/repository.js';
import { readPlan } from '../planning/repository.js';
import { analyticsTask, executable } from './metrics.js';
import { shanghaiDate } from './dates.js';
export interface DailySnapshot { date: string; capturedAt: string; dataAsOf: string; planVersion: number; tasks: AnalyticsTask[]; milestones: PlanNode[] }
export function initializeAnalytics(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
    project_id TEXT NOT NULL REFERENCES homepage_projects(id), date TEXT NOT NULL, captured_at TEXT NOT NULL,
    data_as_of TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(project_id,date)
  );`);
}
export function captureSnapshot(db: Database.Database, projectId: string, now: Date): boolean {
  const date = shanghaiDate(now);
  const latest = db.prepare('SELECT MAX(date) AS date FROM analytics_daily_snapshots WHERE project_id=?').get(projectId) as {date:string|null};
  // Clock rollback must never rewrite a historical observation.
  if (latest.date && date < latest.date) return false;
  const workspace = readTasks(db, projectId, '', now); const plan = readPlan(db, projectId, '', now);
  const snapshot: DailySnapshot = { date, capturedAt: now.toISOString(), dataAsOf: workspace.project.asOf, planVersion: workspace.planVersion,
    tasks: workspace.tasks.filter(executable).map(analyticsTask), milestones: plan.nodes.filter(n => n.kind === 'milestone') };
  db.prepare(`INSERT INTO analytics_daily_snapshots VALUES (?,?,?,?,?) ON CONFLICT(project_id,date) DO UPDATE SET captured_at=excluded.captured_at,data_as_of=excluded.data_as_of,snapshot_json=excluded.snapshot_json`).run(projectId, date, snapshot.capturedAt, snapshot.dataAsOf, JSON.stringify(snapshot));
  snapshotCache.get(db)?.get(projectId)?.rows.delete(date);
  return true;
}
const snapshotCache = new WeakMap<Database.Database, Map<string,{external:unknown;rows:Map<string,DailySnapshot>}>>();
export function readSnapshots(db: Database.Database, projectId: string): DailySnapshot[] {
  let cache = snapshotCache.get(db); if (!cache) { cache = new Map(); snapshotCache.set(db,cache); }
  const external = db.pragma('data_version',{simple:true});
  let entry = cache.get(projectId);
  if (!entry || entry.external !== external) entry = {external,rows:new Map()};
  const metadata = db.prepare('SELECT date,captured_at FROM analytics_daily_snapshots WHERE project_id=? ORDER BY date').all(projectId) as {date:string;captured_at:string}[];
  const dates = new Set(metadata.map(row=>row.date));
  for (const date of entry.rows.keys()) if (!dates.has(date)) entry.rows.delete(date);
  for (const row of metadata) if (entry.rows.get(row.date)?.capturedAt !== row.captured_at) {
    const stored = db.prepare('SELECT snapshot_json FROM analytics_daily_snapshots WHERE project_id=? AND date=?').get(projectId,row.date) as {snapshot_json:string};
    entry.rows.set(row.date,JSON.parse(stored.snapshot_json));
  }
  if (cache.size >= 2 && !cache.has(projectId)) cache.delete(cache.keys().next().value!);
  cache.set(projectId,entry); return metadata.map(row=>entry!.rows.get(row.date)!);
}
