import type Database from 'better-sqlite3';
import { enqueueJob } from './jobs/store.js';
import { captureProjectEvents } from './modules/notifications/events.js';
import { hasTable } from './modules/settings/store.js';
import { shanghaiDate } from './modules/analytics/dates.js';
const coalescing = new WeakMap<Database.Database, number>();
/** Production batches nearby writes; explicit synchronous fixtures retain zero delay. */
export function configureBusinessJobCoalescing(db: Database.Database, enabled: boolean) { coalescing.set(db,enabled?1500:0); }
/** Invoked inside the business transaction so crash recovery shares its commit. */
export function captureBusinessJobs(db: Database.Database, projectId: string, now: Date, taskIds?: string[]) {
  captureProjectEvents(db, projectId, now, taskIds);
  if (!hasTable(db, 'background_jobs')) return;
  const { version } = db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get(projectId) as { version: number };
  for (const kind of ['risk_evaluate', 'snapshot'] as const) {
    // A pending business job always reads the latest committed state. Preserve
    // its identity and retry schedule; audit events and notifications are not coalesced.
    const pending = db.prepare("SELECT id FROM background_jobs WHERE project_id=? AND kind=? AND status='pending' AND dedupe_key LIKE ? AND (? != 'snapshot' OR json_extract(payload_json,'$.date')=?) LIMIT 1").get(projectId,kind,`business-${kind}:%`,kind,shanghaiDate(now));
    if (pending) continue;
    enqueueJob(db, {
    projectId, kind, dedupeKey: `business-${kind}:${version}`, payload: { date: shanghaiDate(now) }, dueAt: new Date(now.getTime()+(coalescing.get(db)??0)),
  }, now);
  }
}
