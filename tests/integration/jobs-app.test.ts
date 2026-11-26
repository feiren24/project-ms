import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { TaskWorkspace } from '../../shared/src/tasks.js';
import type { SettingsWorkspace } from '../../shared/src/settings.js';
import type { NotificationWorkspace } from '../../shared/src/notifications.js';

const prefix='/api/v1/projects/phase-one';
describe('application business transactions and durable delivery integration', () => {
  let app:FastifyInstance; let db:Database.Database; let directory:string; let path:string;
  const now=new Date('2026-09-23T02:01:00Z');
  const start=()=>buildApp({dbPath:path,clock:()=>now,jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0});
  beforeEach(async () => { directory=await mkdtemp(join(tmpdir(),'goodwork-jobs-app-')); path=join(directory,'app.sqlite'); app=start(); await app.ready(); db=new Database(path); });
  afterEach(async () => { if (db.open) db.close(); await app.close(); await rm(directory,{recursive:true,force:true}); });
  async function workspace():Promise<TaskWorkspace> { return (await app.inject(`${prefix}/tasks`)).json().data; }
  async function notifications(actor='chen'):Promise<NotificationWorkspace> { const response=await app.inject(`${prefix}/notifications?actorId=${actor}`); expect(response.statusCode,response.body).toBe(200); return response.json().data; }
  function headers(token:string,key=randomUUID()) { return {'x-preview-token':token,'x-demo-actor':'zhou','idempotency-key':key}; }
  async function createTask(key=randomUUID()) {
    const w=await workspace(); const body={title:'DEMO · 作业集成测试任务',description:'虚构测试记录',workstreamId:w.workstreams[0]!.id,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:null,end:null,expectedPlanVersion:w.planVersion};
    const response=await app.inject({method:'POST',url:`${prefix}/tasks`,headers:headers(w.writeToken,key),payload:body}); return {response,body,key};
  }
  function persisted() {
    return ['background_jobs','notification_seen','notifications','task_meta','plan_projects','settings_projects','settings_events'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }
  test('task creation automatically queues and delivers recipient notification and durable observations', async () => {
    const {response}=await createTask(); expect(response.statusCode,response.body).toBe(200); const task=response.json().data.task;
    const own=(await notifications()).notifications.filter(n=>n.target.id===task.id); expect(own).toHaveLength(1); expect(own[0]).toMatchObject({kind:'task.create',recipientId:'chen'});
    expect((await notifications('xu')).notifications.filter(n=>n.target.id===task.id)).toHaveLength(0);
    const jobs=db.prepare("SELECT kind,status FROM background_jobs WHERE dedupe_key IN (?,?) ORDER BY kind").all(`business-risk_evaluate:${response.json().data.planVersion}`,`business-snapshot:${response.json().data.planVersion}`);
    expect(jobs).toEqual([{kind:'risk_evaluate',status:'succeeded'},{kind:'snapshot',status:'succeeded'}]);
  });
  test('settings changes notify managers and preserve business revision after marking read', async () => {
    const w:SettingsWorkspace=(await app.inject(`${prefix}/settings`)).json().data;
    const response=await app.inject({method:'POST',url:`${prefix}/settings/capacity`,headers:headers(w.writeToken),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,reason:'DEMO · 测试配置通知',capacity:{memberId:'chen',hoursPerDay:7,exceptions:{}}}});
    expect(response.statusCode,response.body).toBe(200);
    const manager=await notifications('zhou'); expect(manager.notifications.filter(n=>n.kind==='settings.capacity')).toHaveLength(1);
    expect((await notifications('chen')).notifications.filter(n=>n.kind==='settings.capacity')).toHaveLength(0);
    const before=(await app.inject(`${prefix}/revision?actorId=zhou`)).json().data;
    expect((await app.inject({method:'POST',url:`${prefix}/notifications/read`,headers:headers(manager.writeToken),payload:{all:true}})).statusCode).toBe(200);
    const after=(await app.inject(`${prefix}/revision?actorId=zhou`)).json().data; expect(after.revision).toBe(before.revision); expect(after.unread).toBe(0);
  });
  test('a failure after queue capture rolls back task, seen markers, notifications and all durable followups', async () => {
    const before=persisted(); db.exec("CREATE TRIGGER fail_task_receipt BEFORE INSERT ON task_idempotency BEGIN SELECT RAISE(ABORT,'fixture rollback after queue capture'); END");
    const {response}=await createTask(); expect(response.statusCode).toBe(500); expect(persisted()).toEqual(before);
    db.exec('DROP TRIGGER fail_task_receipt'); expect((await createTask()).response.statusCode).toBe(200);
  });
  test('restart delivers committed pending work once and replayed business request never duplicates notification', async () => {
    // Crash boundary: prevent delivery while allowing the business transaction and enqueue to commit.
    db.exec("CREATE TRIGGER pause_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'fixture delivery unavailable'); END");
    const {response,body,key}=await createTask(); expect(response.statusCode,response.body).toBe(200); const task=response.json().data.task;
    expect((await notifications()).notifications.filter(n=>n.target.id===task.id)).toHaveLength(0);
    await app.close(); db.exec('DROP TRIGGER pause_notification'); db.prepare("UPDATE background_jobs SET due_at=? WHERE kind='notification' AND status='pending'").run(now.toISOString());
    app=start(); await app.ready(); expect((await notifications()).notifications.filter(n=>n.target.id===task.id)).toHaveLength(1);
    const w=await workspace(); const replay=await app.inject({method:'POST',url:`${prefix}/tasks`,headers:headers(w.writeToken,key),payload:body}); expect(replay.statusCode,replay.body).toBe(200);
    expect((await notifications()).notifications.filter(n=>n.target.id===task.id)).toHaveLength(1);
    await app.close(); app=start(); await app.ready(); expect((await notifications()).notifications.filter(n=>n.target.id===task.id)).toHaveLength(1);
  });
  test('all GET routes preserve initialized queue, notifications, audit and business state', async () => {
    await createTask(); const before=persisted();
    for (const suffix of ['/tasks','/settings','/risks','/overview','/analytics','/notifications?actorId=chen','/revision?actorId=chen','/activities','/activities?category=task&range=all']) expect((await app.inject(`${prefix}${suffix}`)).statusCode).toBe(200);
    expect(persisted()).toEqual(before);
  });
});
