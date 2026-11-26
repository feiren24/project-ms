import { isExistingDatabase } from '../db/lifecycle.js';
import { advanceActivityBackfill } from '../modules/activities/repository.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { captureSnapshot } from '../modules/analytics/snapshots.js';
import { evaluateProjectRisks, recordEvaluationFailure } from '../modules/risks/service.js';
import { enqueueJob, initializeJobs, readJob, type JobKind, type StoredJob } from './store.js';

const minute = 60_000, day = 86_400_000, quarter = 15 * minute;
const shanghaiOffset = 8 * 60 * minute;
type HandlerResult = void | { delivered: boolean; reason?: string };
/** Synchronous handlers run with the job completion in one transaction. Backup alone is async. */
export type JobHandler = (job: StoredJob, now: Date) => HandlerResult;
export interface JobRunnerOptions { clock?: () => Date; backupDirectory?: string; intervalMs?: number; leaseMs?: number; handlers?: Partial<Record<JobKind, JobHandler>>; onError?: (error: unknown) => void }
export interface JobRunResult { processed: number; failed: number; retried: number }
function localDate(date: Date) { return new Date(date.getTime() + shanghaiOffset).toISOString().slice(0,10); }
function nextDaily(now: Date, localMinutes: number) {
  const midnight = Math.floor((now.getTime() + shanghaiOffset) / day) * day - shanghaiOffset;
  const scheduled = midnight + localMinutes * minute;
  return new Date(scheduled > now.getTime() ? scheduled : scheduled + day);
}
function nextSlot(kind: JobKind, now: Date) {
  return kind === 'risk_evaluate' ? new Date((Math.floor(now.getTime() / quarter) + 1) * quarter) : nextDaily(now,kind === 'snapshot' ? 23 * 60 + 55 : 120);
}
export function ensureProjectSchedules(db: Database.Database, projectId: string, now: Date) {
  for (const kind of ['risk_evaluate','snapshot','backup'] as const) {
    db.prepare('INSERT OR IGNORE INTO background_job_schedules VALUES(?,?,?)').run(projectId,kind,nextSlot(kind,now).toISOString());
  }
}
function initializeSchedules(db: Database.Database, now: Date) {
  db.transaction(() => {
    for (const {id} of db.prepare('SELECT id FROM homepage_projects').all() as {id:string}[]) {
      ensureProjectSchedules(db,id,now);
    }
  })();
}
function scheduleDue(db: Database.Database, now: Date) {
  initializeSchedules(db,now);
  db.transaction(() => {
    const schedules = db.prepare('SELECT project_id,kind,next_due_at FROM background_job_schedules WHERE next_due_at<=?').all(now.toISOString()) as {project_id:string;kind:JobKind;next_due_at:string}[];
    for (const schedule of schedules) {
      let due = new Date(schedule.next_due_at);
      if (schedule.kind === 'risk_evaluate') {
        // A restart observes current evidence once, never replaying old risk states.
        due = new Date(Math.floor(now.getTime() / quarter) * quarter);
        db.prepare(`UPDATE background_jobs SET status='missed',finished_at=?,error='已合并到当前风险巡检' WHERE project_id=? AND kind='risk_evaluate' AND status='pending' AND due_at<?`).run(now.toISOString(),schedule.project_id,due.toISOString());
        enqueueJob(db,{projectId:schedule.project_id,kind:schedule.kind,dedupeKey:due.toISOString(),payload:{scheduledAt:due.toISOString()},dueAt:due},now);
      } else {
        // Daily cursors are durable: record each missed date without synthesizing its data.
        while (due <= now) {
          const id = enqueueJob(db,{projectId:schedule.project_id,kind:schedule.kind,dedupeKey:due.toISOString(),payload:{scheduledAt:due.toISOString(),date:localDate(due)},dueAt:due},now);
          if (now.getTime() - due.getTime() >= 5 * minute) db.prepare(`UPDATE background_jobs SET status='missed',finished_at=?,error=? WHERE id=? AND status='pending'`).run(now.toISOString(),schedule.kind === 'snapshot' ? '错过日终采集窗口；不以当前数据补造历史快照' : '错过定时备份窗口；等待下一次计划备份',id);
          due = new Date(due.getTime() + day);
        }
      }
      db.prepare('UPDATE background_job_schedules SET next_due_at=? WHERE project_id=? AND kind=?').run(nextSlot(schedule.kind,now).toISOString(),schedule.project_id,schedule.kind);
    }
  })();
}
function claimJob(db: Database.Database, now: Date, leaseMs: number, preferObservations: boolean): StoredJob | undefined {
  return db.transaction(() => {
    // A process dying on its fourth attempt is terminal, not a fifth hidden attempt.
    db.prepare(`UPDATE background_jobs SET status='failed',finished_at=?,error='执行租约过期，重试次数已用尽',lease_token=NULL,lease_until=NULL
      WHERE kind!='feishu_delivery' AND status='running' AND lease_until<=? AND attempts>=4`).run(now.toISOString(),now.toISOString());
    const eligible = "((status='pending' AND due_at<=?) OR (status='running' AND lease_until<=? AND attempts<4))";
    // Current observations must not sit behind thousands of notification deliveries.
    // After four observation turns the oldest eligible job gets a fair turn.
    const priority = preferObservations ? db.prepare(`SELECT id FROM background_jobs WHERE kind IN ('risk_evaluate','snapshot') AND ${eligible} ORDER BY due_at,id LIMIT 1`).get(now.toISOString(),now.toISOString()) as {id:string}|undefined : undefined;
    // Bound each candidate before merging: an OR across status branches forces
    // SQLite to sort the entire pending notification backlog on every claim.
    let row = priority;
    if (!row) {
      type Candidate = {id:string;due_at:string};
      const pending = db.prepare("SELECT id,due_at FROM background_jobs WHERE kind!='feishu_delivery' AND status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1").get(now.toISOString()) as Candidate|undefined;
      const expired = db.prepare("SELECT id,due_at FROM background_jobs WHERE kind!='feishu_delivery' AND status='running' AND lease_until<=? AND attempts<4 ORDER BY due_at,id LIMIT 1").get(now.toISOString()) as Candidate|undefined;
      row = !pending ? expired : !expired ? pending :
        expired.due_at < pending.due_at || (expired.due_at === pending.due_at && expired.id < pending.id) ? expired : pending;
    }
    if (!row) return undefined;
    db.prepare(`UPDATE background_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,finished_at=NULL WHERE id=?`).run(randomUUID(),new Date(now.getTime()+leaseMs).toISOString(),row.id);
    return readJob(db,row.id);
  }).immediate();
}
function finish(db: Database.Database, job: StoredJob, now: Date, status: 'succeeded'|'missed', error: string|null = null) {
  db.prepare(`UPDATE background_jobs SET status=?,finished_at=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=?`).run(status,now.toISOString(),error,job.id,job.leaseToken);
}
function failure(db: Database.Database, job: StoredJob, now: Date, error: unknown): boolean {
  const retry = job.attempts < 4;
  const delay = [1,5,15][job.attempts-1] ?? 0;
  // Logs must not expose local filesystem paths or DB internals in the project UI.
  const message = error instanceof Error ? error.message.replace(/(?:\/[\w.\-]+){2,}/g,'[本机路径]').slice(0,500) : '后台作业执行失败';
  db.prepare(`UPDATE background_jobs SET status=?,due_at=?,finished_at=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=?`).run(retry ? 'pending':'failed',retry ? new Date(now.getTime()+delay*minute).toISOString():job.dueAt,retry ? null:now.toISOString(),message,job.id,job.leaseToken);
  return retry;
}
export function createJobRunner(db: Database.Database, options: JobRunnerOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 5 * minute;
  initializeJobs(db); if (!isExistingDatabase(db)) initializeSchedules(db,clock());
  let timer: ReturnType<typeof setInterval>|undefined;
  let active: Promise<JobRunResult>|undefined;
  let stopping = false, observationTurns = 0;
  let nextActivityBatchAt = 0;
  function runActivityBatch(now:Date) {
    // Wall time is independent of the injectable business clock used for dates.
    const wallNow=Date.now();
    if(isExistingDatabase(db) || stopping || wallNow<nextActivityBatchAt)return;
    nextActivityBatchAt=wallNow+1000;
    advanceActivityBackfill(db,now);
  }
  const directory = options.backupDirectory ?? (db.name && db.name !== ':memory:' ? join(dirname(db.name),'backups') : undefined);
  async function backup(job: StoredJob, now: Date) {
    if (!directory) { finish(db,job,now,'missed','内存数据库未配置本机备份路径，未生成备份'); return; }
    await mkdir(directory,{recursive:true});
    const filename = `${job.id}-${now.toISOString().replace(/[:.]/g,'-')}.sqlite`;
    const destination = join(directory,filename);
    const temporary = `${destination}.${job.leaseToken}.tmp`;
    // Lease renewal covers slow online backups. No write transaction spans an await.
    const heartbeat = setInterval(() => {
      db.prepare(`UPDATE background_jobs SET lease_until=? WHERE id=? AND status='running' AND lease_token=?`).run(new Date(clock().getTime()+leaseMs).toISOString(),job.id,job.leaseToken);
    },Math.max(10,Math.floor(leaseMs/3)));
    heartbeat.unref();
    try {
      await db.backup(temporary);
      if (readJob(db,job.id)?.leaseToken !== job.leaseToken) { await rm(temporary,{force:true}); return; }
      await rename(temporary,destination);
      finish(db,job,now,'succeeded');
    } catch (error) { await rm(temporary,{force:true}); throw error; }
    finally { clearInterval(heartbeat); }
  }
  async function execute(now: Date, limit: number, includeBackfill: boolean): Promise<JobRunResult> {
    if (includeBackfill) runActivityBatch(now);
    scheduleDue(db,now);
    const result: JobRunResult = {processed:0,failed:0,retried:0};
    for (let i=0;i<Math.max(0,Math.min(100,limit));i++) {
      now = new Date(Math.max(now.getTime(),clock().getTime()));
      const job = claimJob(db,now,leaseMs,observationTurns<4); if (!job) break;
      observationTurns = ['risk_evaluate','snapshot'].includes(job.kind) ? observationTurns+1 : 0;
      try {
        const payload = job.payload as {scheduledAt?:string;date?:string};
        if (job.kind === 'snapshot' && payload.date && payload.date !== localDate(now)) {
          finish(db,job,now,'missed','已错过原定日期，不以当前数据补造历史快照');
        } else if (job.kind === 'backup' && !options.handlers?.backup) await backup(job,now);
        else db.transaction(() => {
          const handler = options.handlers?.[job.kind];
          let outcome: HandlerResult = undefined;
          if (handler) outcome = handler(job,now);
          else if (job.kind === 'risk_evaluate') evaluateProjectRisks(db,job.projectId,now);
          else if (job.kind === 'snapshot') captureSnapshot(db,job.projectId,now);
          else throw new Error('站内通知投递处理器未配置');
          if (outcome && 'then' in outcome) throw new Error('事务作业处理器必须同步执行');
          finish(db,job,now,outcome?.delivered === false ? 'missed':'succeeded',outcome?.delivered === false ? outcome.reason ?? '收件人已失效，未投递' : null);
        })();
        result.processed++;
      } catch (error) {
        if (job.kind === 'risk_evaluate') { try { recordEvaluationFailure(db,job.projectId); } catch {} }
        result.failed++; if (failure(db,job,now,error)) result.retried++;
      }
      // A long coalesced job drain must not starve the bounded history worker.
      if (includeBackfill) runActivityBatch(now);
      // Yield between transactions so a batch cannot monopolize the HTTP event loop.
      if (options.intervalMs !== 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return result;
  }
  function runDueJobs(now = clock(), limit = 100, includeBackfill = true): Promise<JobRunResult> {
    if (active) return active;
    if (stopping) return Promise.resolve({processed:0,failed:0,retried:0});
    active = execute(now,limit,includeBackfill).finally(() => { active=undefined; });
    return active;
  }
  return {
    runDueJobs,
    start() {
      if (timer) return; stopping=false;
      timer = setInterval(() => {
        try { runActivityBatch(clock()); } catch(error) { options.onError?.(error); }
        void runDueJobs().catch(error => options.onError?.(error));
      },options.intervalMs ?? 1_000); timer.unref();
    },
    async stop() { stopping=true; if (timer) clearInterval(timer); timer=undefined; await active; },
  };
}
