import { captureBusinessJobs, configureBusinessJobCoalescing } from '../../server/src/job-integration.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createJobRunner } from '../../server/src/jobs/runner.js';
import { enqueueJob, initializeJobs, listJobs, readJob, retryFailedJob } from '../../server/src/jobs/store.js';

describe('durable local jobs', () => {
  let db: Database.Database; let directory: string; let path: string; let now: Date;
  const runners: ReturnType<typeof createJobRunner>[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(),'goodwork-jobs-')); path=join(directory,'queue.sqlite'); now=new Date('2026-09-07T02:01:00Z');
    db = new Database(path); db.pragma('journal_mode=WAL'); db.exec("CREATE TABLE homepage_projects(id TEXT PRIMARY KEY); INSERT INTO homepage_projects VALUES('demo'); CREATE TABLE effects(value TEXT)"); initializeJobs(db);
  });
  afterEach(async () => { for (const runner of runners.splice(0)) await runner.stop(); if (db.open) db.close(); await rm(directory,{recursive:true,force:true}); });
  function runner(extra: Parameters<typeof createJobRunner>[1] = {}) { const item=createJobRunner(db,{clock:()=>now,handlers:{risk_evaluate:()=>{},snapshot:()=>{}},...extra}); runners.push(item); return item; }
  function enqueue(key='one',kind:'notification'|'snapshot'|'backup'='notification',payload:unknown={}) { return enqueueJob(db,{projectId:'demo',kind,dedupeKey:key,payload,dueAt:now},now); }
  test('coalesces pending observations within a day but never swallows a new-day snapshot', () => {
    db.exec("CREATE TABLE plan_projects(project_id TEXT PRIMARY KEY,version INTEGER); INSERT INTO plan_projects VALUES('demo',1)");
    const yesterday=new Date('2026-09-07T15:59:00Z'),today=new Date('2026-09-07T16:01:00Z');
    captureBusinessJobs(db,'demo',yesterday);
    db.prepare('UPDATE plan_projects SET version=version+1').run(); captureBusinessJobs(db,'demo',yesterday);
    expect(listJobs(db,'demo').filter(job=>job.kind==='snapshot')).toHaveLength(1);
    db.prepare("UPDATE background_jobs SET due_at=?,attempts=1 WHERE kind='snapshot'").run('2026-09-07T16:10:00.000Z');
    db.prepare('UPDATE plan_projects SET version=version+1').run(); captureBusinessJobs(db,'demo',today);
    const snapshots=db.prepare("SELECT json_extract(payload_json,'$.date') date FROM background_jobs WHERE kind='snapshot' ORDER BY date").all();
    expect(snapshots).toEqual([{date:'2026-09-07'},{date:'2026-09-08'}]);
    expect(listJobs(db,'demo').filter(job=>job.kind==='risk_evaluate')).toHaveLength(1);
  });
  test('current observations bypass notification backlog while ordinary work still gets a turn', async () => {
    db.transaction(() => { for (let i=0;i<1000;i++) enqueue(`backlog-${i}`); })();
    now = new Date(now.getTime()+1000);
    for (let i=0;i<10;i++) enqueueJob(db,{projectId:'demo',kind:i%2?'snapshot':'risk_evaluate',dedupeKey:`current-${i}`,payload:{},dueAt:now},now);
    const kinds:string[]=[];
    const item=runner({handlers:{notification:()=>{kinds.push('notification');},risk_evaluate:()=>{kinds.push('risk_evaluate');},snapshot:()=>{kinds.push('snapshot');}}});
    await item.runDueJobs(now,5);
    expect(kinds.slice(0,4).every(kind=>kind!=='notification')).toBe(true);
    expect(kinds[4]).toBe('notification');
  });
  test('a yielding batch observes newly due work with a current capture timestamp', async () => {
    enqueue('first'); const start=now.getTime(); let observed:string|undefined;
    const item=runner({handlers:{notification:()=>{now=new Date(start+1500);enqueueJob(db,{projectId:'demo',kind:'snapshot',dedupeKey:'arrived-during-batch',payload:{},dueAt:now},now);},snapshot:(_job,at)=>{observed=at.toISOString();}}});
    await item.runDueJobs(now,2);
    expect(observed).toBe(new Date(start+1500).toISOString());
  });
  test('business observations collect a short fixed window without sliding under more writes', async () => {
    db.exec("CREATE TABLE plan_projects(project_id TEXT PRIMARY KEY,version INTEGER); INSERT INTO plan_projects VALUES('demo',1)");
    configureBusinessJobCoalescing(db,true);const start=now.getTime(),seen:number[]=[];
    captureBusinessJobs(db,'demo',now);
    const item=runner({handlers:{risk_evaluate:()=>{seen.push(1);},snapshot:()=>{seen.push(2);}}});
    await item.runDueJobs();expect(seen).toEqual([]);
    now=new Date(start+1400);db.prepare('UPDATE plan_projects SET version=2').run();captureBusinessJobs(db,'demo',now);await item.runDueJobs();expect(seen).toEqual([]);
    expect(listJobs(db,'demo')).toHaveLength(2);
    now=new Date(start+1500);await item.runDueJobs();expect(seen.sort()).toEqual([1,2]);
    expect(listJobs(db,'demo').every(job=>job.status==='succeeded')).toBe(true);
  });
  test('pending and expired leases preserve global due/id order without reclaiming live leases', async () => {
    const pending=enqueue('pending'),expired=enqueue('expired'),live=enqueue('live');
    const past=new Date(now.getTime()-1000).toISOString(),future=new Date(now.getTime()+1000).toISOString();
    db.prepare("UPDATE background_jobs SET status='running',attempts=1,lease_until=?,due_at=? WHERE id=?").run(past,past,expired);
    db.prepare("UPDATE background_jobs SET status='running',attempts=1,lease_until=?,due_at=? WHERE id=?").run(future,past,live);
    const seen:string[]=[];const item=runner({handlers:{notification:job=>{seen.push(job.id);}}});
    await item.runDueJobs(now,3);expect(seen).toEqual([expired,pending]);expect(readJob(db,expired)?.attempts).toBe(2);expect(readJob(db,live)?.status).toBe('running');
    const a=enqueue('tie-a'),b=enqueue('tie-b');db.prepare("UPDATE background_jobs SET status='running',attempts=1,lease_until=? WHERE id=?").run(past,b);
    await item.runDueJobs(now,2);expect(seen.slice(2)).toEqual([a,b].sort());
  });
  test('dedup survives restart and outer transaction rollback removes queued work', () => {
    const id=enqueue(); expect(enqueue()).toBe(id);
    expect(() => db.transaction(() => { enqueue('rolled-back'); throw new Error('rollback'); })()).toThrow('rollback');
    expect(listJobs(db,'demo')).toHaveLength(1); db.close(); db=new Database(path); initializeJobs(db); expect(enqueue()).toBe(id);
  });
  test('handler side effects and completion roll back together; 1/5/15 minute backoff and terminal fourth failure', async () => {
    const id=enqueue(); const item=runner({handlers:{notification:()=>{ db.prepare('INSERT INTO effects VALUES(?)').run('must rollback'); throw new Error('fixture failure'); }}});
    db.prepare('UPDATE background_job_schedules SET next_due_at=?').run('2026-09-08T02:00:00.000Z');
    for (const [index,delay] of [1,5,15,0].entries()) {
      const result=await item.runDueJobs(now,1); expect(result).toEqual({processed:0,failed:1,retried:index<3 ? 1:0});
      expect(db.prepare('SELECT * FROM effects').all()).toEqual([]);
      const job=readJob(db,id)!; expect(job.attempts).toBe(index+1); expect(job.status).toBe(index<3?'pending':'failed');
      if (delay) { expect(job.dueAt).toBe(new Date(now.getTime()+delay*60000).toISOString()); expect((await item.runDueJobs(now,1)).failed).toBe(0); now=new Date(job.dueAt); }
    }
    expect(retryFailedJob(db,'foreign',id,now)).toBe(false); expect(retryFailedJob(db,'demo',id,now)).toBe(true); expect(retryFailedJob(db,'demo',id,now)).toBe(false);
    expect(readJob(db,id)).toMatchObject({status:'pending',attempts:0,error:null});
  });
  test('two workers respect durable leases and restart reclaims only expired attempts', async () => {
    const id=enqueue(); const lease=new Date(now.getTime()+60000).toISOString();
    db.prepare("UPDATE background_jobs SET status='running',attempts=1,lease_token='dead-process',lease_until=? WHERE id=?").run(lease,id);
    db.close(); db=new Database(path); const item=runner({handlers:{notification:()=>{ db.prepare("INSERT INTO effects VALUES('delivered')").run(); }}});
    expect((await item.runDueJobs(now,1)).processed).toBe(0); now=new Date(lease);
    const other=new Database(path); const second=createJobRunner(other,{clock:()=>now,handlers:{notification:()=>{throw new Error('must not duplicate');}}});
    try { const results=await Promise.all([item.runDueJobs(now,1),second.runDueJobs(now,1)]); expect(results.reduce((n,r)=>n+r.processed,0)).toBe(1); }
    finally { await second.stop(); other.close(); }
    expect(readJob(db,id)).toMatchObject({status:'succeeded',attempts:2}); expect(db.prepare('SELECT * FROM effects').all()).toHaveLength(1);
    expect(retryFailedJob(db,'demo',id,now)).toBe(false);
  });
  test('completion storage failure also rolls back notification effects', async () => {
    const id=enqueue(); db.exec("CREATE TRIGGER reject_job_success BEFORE UPDATE ON background_jobs WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'completion unavailable'); END");
    const item=runner({handlers:{notification:()=>{ db.prepare('INSERT INTO effects VALUES(?)').run('must rollback with completion'); }}});
    expect(await item.runDueJobs()).toEqual({processed:0,failed:1,retried:1}); expect(db.prepare('SELECT * FROM effects').all()).toHaveLength(0);
    expect(readJob(db,id)).toMatchObject({status:'pending',attempts:1,error:'completion unavailable'});
  });
  test('fourth crashed attempt becomes failed; no fifth automatic execution', async () => {
    const id=enqueue(); db.prepare("UPDATE background_jobs SET status='running',attempts=4,lease_token='dead',lease_until=? WHERE id=?").run(now.toISOString(),id);
    expect((await runner().runDueJobs(now,1)).processed).toBe(0); expect(readJob(db,id)).toMatchObject({status:'failed',attempts:4});
  });
  test('initialization creates only future schedules; restart records missed daily windows and coalesces risk evaluation', async () => {
    let calls=0; const item=runner({handlers:{risk_evaluate:()=>{calls++;},snapshot:()=>{throw new Error('must never fabricate historical data');}}});
    expect(listJobs(db,'demo')).toEqual([]); expect((await item.runDueJobs()).processed).toBe(0);
    expect(db.prepare('SELECT next_due_at FROM background_job_schedules ORDER BY kind').all()).toEqual([{next_due_at:'2026-09-07T18:00:00.000Z'},{next_due_at:'2026-09-07T02:15:00.000Z'},{next_due_at:'2026-09-07T15:55:00.000Z'}]);
    await item.stop(); db.close(); db=new Database(path); now=new Date('2026-09-10T04:00:00Z');
    const restarted=runner({handlers:{risk_evaluate:()=>{calls++;},snapshot:()=>{throw new Error('must not run historical snapshot');}}});
    await restarted.runDueJobs(); expect(calls).toBe(1);
    const jobs=listJobs(db,'demo'); expect(jobs.filter(j=>j.kind==='snapshot')).toHaveLength(3); expect(jobs.filter(j=>j.kind==='snapshot').every(j=>j.status==='missed')).toBe(true);
    expect(jobs.filter(j=>j.kind==='risk_evaluate')).toHaveLength(1); await restarted.runDueJobs(); expect(calls).toBe(1);
  });
  test('Shanghai 23:55 current snapshot runs once and queued previous-date snapshot is missed', async () => {
    now=new Date('2026-09-07T15:54:00Z'); let captured=0; const item=runner({handlers:{snapshot:()=>{captured++;}}});
    now=new Date('2026-09-07T15:55:05Z'); await item.runDueJobs(); expect(captured).toBe(1); await item.runDueJobs(); expect(captured).toBe(1);
    const id=enqueue('old-snapshot','snapshot',{date:'2026-09-06'}); await item.runDueJobs(); expect(readJob(db,id)?.status).toBe('missed'); expect(captured).toBe(1);
  });
  test('inactive notification is recorded as missed without retry', async () => {
    const id=enqueue(); await runner({handlers:{notification:()=>({delivered:false,reason:'收件人已停用'})}}).runDueJobs();
    expect(readJob(db,id)).toMatchObject({status:'missed',attempts:1,error:'收件人已停用'});
  });
  test('02:00 online SQLite backup is readable, consistent and stays in configured temporary directory', async () => {
    now=new Date('2026-09-07T17:59:00Z'); const destination=join(directory,'isolated-backups'); const item=runner({backupDirectory:destination});
    db.prepare("INSERT INTO effects VALUES('DEMO committed record')").run(); now=new Date('2026-09-07T18:00:00Z');
    await item.runDueJobs(); const files=await readdir(destination); expect(files).toHaveLength(1); expect(files[0]).toMatch(/\.sqlite$/);
    const restored=new Database(join(destination,files[0]!),{readonly:true});
    try { expect(restored.pragma('integrity_check',{simple:true})).toBe('ok'); expect(restored.prepare('SELECT value FROM effects').all()).toEqual([{value:'DEMO committed record'}]); } finally { restored.close(); }
    expect(listJobs(db,'demo').find(j=>j.kind==='backup')?.status).toBe('succeeded');
  });
  test('memory backup without directory is explicitly missed', async () => {
    db.close(); db=new Database(':memory:'); db.exec("CREATE TABLE homepage_projects(id TEXT PRIMARY KEY); INSERT INTO homepage_projects VALUES('demo')"); initializeJobs(db);
    const id=enqueue('memory','backup'); await runner().runDueJobs(); expect(readJob(db,id)).toMatchObject({status:'missed',error:'内存数据库未配置本机备份路径，未生成备份'});
  });
});
