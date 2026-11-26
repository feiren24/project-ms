import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import { captureSnapshot } from '../../server/src/modules/analytics/snapshots.js';
import type { AnalyticsReport } from '../../shared/src/analytics.js';
import type { ManagedTask, TaskWorkspace } from '../../shared/src/tasks.js';
const prefix = '/api/v1/projects/phase-one';
describe('analytics API snapshots and completion evidence', () => {
  let app: FastifyInstance; let directory: string; let dbPath: string; let now: Date;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(),'goodwork-analytics-')); dbPath = join(directory,'test.sqlite'); now = new Date('2026-09-07T15:50:00Z'); app = buildApp({dbPath,clock:() => now}); });
  afterEach(async () => { await app.close(); await rm(directory,{recursive:true,force:true}); });
  const workspace = async (): Promise<TaskWorkspace> => (await app.inject(`${prefix}/tasks`)).json().data;
  const report = async (query = ''): Promise<AnalyticsReport> => { const response = await app.inject(`${prefix}/analytics${query}`); expect(response.statusCode,response.body).toBe(200); return response.json().data; };
  async function create(extra: object = {}) { const state = await workspace(); const response = await app.inject({method:'POST',url:`${prefix}/tasks`,headers:{'x-preview-token':state.writeToken,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{title:'DEMO · 统计测试',description:'虚构测试',workstreamId:state.workstreams[0]!.id,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:'2026-09-08',end:'2026-09-09',...extra,expectedPlanVersion:state.planVersion}}); expect(response.statusCode,response.body).toBe(200); return response.json().data.task as ManagedTask; }
  async function transition(id: string,action: string,extra: object = {},actor = 'chen') { const state = await workspace(); const task = state.tasks.find(t => t.id === id)!; return app.inject({method:'POST',url:`${prefix}/tasks/${id}/transition`,headers:{'x-preview-token':state.writeToken,'x-demo-actor':actor,'idempotency-key':randomUUID()},payload:{expectedPlanVersion:state.planVersion,expectedVersion:task.version,action,reason:'DEMO · 统计证据测试',...extra}}); }
  function snapshotRows() { const db = new Database(dbPath); try { return db.prepare('SELECT * FROM analytics_daily_snapshots ORDER BY date').all() as Array<{date:string;captured_at:string;snapshot_json:string}>; } finally { db.close(); } }
  test('normalized defaults retain 48 executions, 18 unknown actual completions, milestone separation and unknown capacity', async () => {
    const result = await report(); expect(result.tasks).toHaveLength(48); expect(result.metrics.completion).toMatchObject({value:.375,numerator:18,denominator:48}); expect(result.metrics.onTime).toMatchObject({value:null,denominator:0,missing:18}); expect(result.counts.unknownActual).toBe(18);
    expect(result.metricVersion).toBe('1.2.0');
    expect(result.personnel.summary.metrics.completion.value).toBe(result.metrics.completion.value);
    expect(result.personnel.summary.metrics.onTime.value).toBe(result.metrics.onTime.value);
    expect(result.personnel.summary.metrics.overdue.numerator).toBe(result.counts.overdue);
    expect(result.personnel.members.reduce((n,m)=>n+m.counts.total,0)).toBe(48);
    expect(result.milestones.length).toBeGreaterThan(0); expect(result.deviations).toHaveLength(48);
    expect(result.capacity.members.flatMap(m => m.cells).every(c => c.availableHours === null && c.ratio === null && c.status === 'unknown')).toBe(true);
    expect(result.dataAsOf).toBe('2026-09-21'); expect(result.warnings.join()).toContain('2026-09-07'); expect(result.warnings.join()).toContain('历史无凭证达成不计已验收');
    expect(snapshotRows()).toHaveLength(1); expect(result.trend.points.find(p => p.date === '2026-09-07')?.actual).not.toBeNull();
  });
  test('validates dates, maximum window, unknown/repeated parameters, IDs and enums; missing project is 404', async () => {
    for (const query of ['from=2026-02-30','from=2026-10-01&to=2026-09-01','from=2026-01-01&to=2027-01-02','ownerId=bad','baselineId=bad','workstreamId=bad','capacityMode=real','ownerId=chen&ownerId=zhou','asOf=2026-09-01']) expect((await app.inject(`${prefix}/analytics?${query}`)).statusCode,query).toBe(422);
    expect((await app.inject('/api/v1/projects/missing/analytics')).statusCode).toBe(404);
    expect((await app.inject(`${prefix}/analytics?from=2026-01-01&to=2027-01-01`)).statusCode).toBe(200);
    const empty = await report('?from=2028-01-01&to=2028-01-31'); expect(empty.metrics.completion.value).toBeNull(); expect(empty.tasks).toHaveLength(0);
  });
  test('GET is read only after startup; same day updates latest, historical days persist and missing days remain gaps', async () => {
    await app.ready(); const first = snapshotRows(); now = new Date('2026-09-07T15:59:00Z'); await report(); expect(snapshotRows()).toEqual(first);
    const created = await create(); const updated = snapshotRows(); expect(updated).toHaveLength(1); expect(JSON.parse(updated[0]!.snapshot_json).tasks.some((t:ManagedTask) => t.id === created.id)).toBe(true);
    now = new Date('2026-09-09T16:05:00Z'); await transition(created.id,'start'); const later = snapshotRows(); expect(later.map(s => s.date)).toEqual(['2026-09-07','2026-09-10']); expect(later[0]).toEqual(updated[0]);
    const result = await report(); expect(result.trend.points.find(p => p.date === '2026-09-08')).toMatchObject({actual:null,capturedAt:null}); expect(result.trend.points.find(p => p.date === '2026-09-10')?.capturedAt).toBe(now.toISOString());
    const db = new Database(dbPath); expect(captureSnapshot(db,'phase-one',new Date('2026-09-07T03:00:00Z'))).toBe(false); db.close(); expect(snapshotRows()).toEqual(later);
  });
  test('freezes actual Shanghai completion date and plan end; reopening clears current evidence but keeps history', async () => {
    const created = await create(); now = new Date('2026-09-09T16:05:00Z'); const completed = await transition(created.id,'complete'); expect(completed.statusCode,completed.body).toBe(200); expect(completed.json().data.task).toMatchObject({actualEnd:'2026-09-10',completionPlanEnd:'2026-09-09'});
    const result = await report(); expect(result.metrics.onTime).toMatchObject({value:0,denominator:1,numerator:0,missing:18});
    expect(result.personnel.summary.metrics.late.numeratorTaskIds).toContain(created.id);
    const db = new Database(dbPath); const row = db.prepare('SELECT nodes_json FROM plan_projects').get() as {nodes_json:string}; const nodes = JSON.parse(row.nodes_json); nodes.find((n:{id:string}) => n.id === created.id).end = '2026-09-30'; db.prepare('UPDATE plan_projects SET nodes_json=?').run(JSON.stringify(nodes)); db.close();
    expect((await report()).metrics.onTime.value).toBe(0);
    expect((await transition(created.id,'reopen',{progress:20})).json().data.task).toMatchObject({actualEnd:null,completionPlanEnd:null});
    const after = (await workspace()).tasks.find(t => t.id === created.id)!; expect(after.events.find(e => e.action === 'complete')?.text).toContain('完成时计划结束日：2026-09-09'); expect(after.events.find(e => e.action === 'complete')?.text).toContain('实际完成日：2026-09-10');
    expect((await report()).personnel.summary.metrics.late.numeratorTaskIds).not.toContain(created.id);
  });
  test('independent acceptance freezes completion and reopening predecessor invalidates current downstream evidence only', async () => {
    const upstream = await create(); const downstream = await create({requiresReview:true,reviewerId:'lin',acceptanceCriteria:'可检查成果',evidence:'DEMO 成果'});
    const db = new Database(dbPath); const row = db.prepare('SELECT dependencies_json FROM plan_projects').get() as {dependencies_json:string}; const edges = JSON.parse(row.dependencies_json); edges.push({predecessorId:upstream.id,successorId:downstream.id,type:'FS',lagDays:0}); db.prepare('UPDATE plan_projects SET dependencies_json=?').run(JSON.stringify(edges)); db.close();
    await transition(upstream.id,'complete'); await transition(downstream.id,'start'); const submitted = await transition(downstream.id,'submit'); const accepted = await transition(downstream.id,'accept',{submissionId:submitted.json().data.task.submissions[0].id},'lin'); expect(accepted.statusCode,accepted.body).toBe(200); expect(accepted.json().data.task).toMatchObject({completionPlanEnd:'2026-09-09',actualEnd:'2026-09-07'});
    await transition(upstream.id,'reopen',{progress:0}); const task = (await workspace()).tasks.find(t => t.id === downstream.id)!; expect(task).toMatchObject({completionPlanEnd:null,actualEnd:null,reviewStatus:'needs_review'}); expect(task.events.find(e => e.action === 'accept')?.text).toContain('完成时计划结束日：2026-09-09'); expect(task.submissions[0]!.status).toBe('accepted');
    const personnel=(await report()).personnel;
    expect(personnel.summary.groups.review).toContain(downstream.id);
    expect(personnel.summary.groups.done).not.toContain(downstream.id);
  });
  test('personnel filters preserve totals, reassignment uses current owner and removed history remains', async () => {
    const created = await create({ start:null, end:null });
    const initial = await report('?ownerId=chen');
    expect(initial.personnel.members.map(m=>m.id)).toEqual(['chen']);
    expect(initial.personnel.summary.taskIds).toContain(created.id);
    expect(initial.personnel.summary.counts.total).toBe(initial.counts.total);
    const ws=await workspace();
    const transfer=await app.inject({method:'POST',url:`${prefix}/tasks/batch`,headers:{'x-preview-token':ws.writeToken,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{expectedPlanVersion:ws.planVersion,items:[{id:created.id,expectedVersion:created.version}],patch:{ownerId:'lin'},reason:'移交统计测试'}});
    expect(transfer.statusCode,transfer.body).toBe(200);
    expect((await report('?ownerId=chen')).personnel.summary.taskIds).not.toContain(created.id);
    expect((await report('?ownerId=lin')).personnel.members[0]?.taskIds).toContain(created.id);
    const db=new Database(dbPath);
    db.prepare("UPDATE project_members SET removed_at='2026-09-01',active=0 WHERE project_id='phase-one' AND id='lin'").run();
    const before=db.prepare("SELECT meta_json FROM task_meta WHERE project_id='phase-one' ORDER BY task_id").all();
    const r=await report(`?workstreamId=${created.workstreamId}`);
    expect(r.personnel.members.find(m=>m.id==='lin')).toMatchObject({availability:'removed'});
    expect(r.personnel.members.reduce((n,m)=>n+m.counts.total,0)).toBe(r.counts.total);
    expect(r.personnel.tasks.map(t=>t.taskId)).toEqual(r.tasks.map(t=>t.id));
    expect(db.prepare("SELECT meta_json FROM task_meta WHERE project_id='phase-one' ORDER BY task_id").all()).toEqual(before);
    db.close();
  });

  test('snapshot storage failure keeps successful writes and produces freshness warning; retry captures the new version', async () => {
    await app.ready(); const db = new Database(dbPath); db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON analytics_daily_snapshots BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    const created = await create(); const stale = await report(); expect(stale.tasks.some(t => t.id === created.id)).toBe(true); expect(stale.warnings.join()).toContain('最新采集缺失');
    db.exec('DROP TRIGGER fail_snapshot'); db.close(); await transition(created.id,'start'); expect((await report()).warnings.join()).not.toContain('最新采集缺失');
  });

  test('summary conversion and cancelled descendants never double count current reports or snapshots', async () => {
    const original = await create(); const state = await workspace();
    const response = await app.inject({method:'POST',url:`${prefix}/tasks`,headers:{'x-preview-token':state.writeToken,'x-demo-actor':'zhou','idempotency-key':randomUUID()},payload:{title:'DEMO · 子任务',description:'虚构测试',workstreamId:original.workstreamId,parentId:original.id,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:null,end:null,expectedPlanVersion:state.planVersion,confirmParentConversion:true,expectedParentVersion:original.version}});
    expect(response.statusCode,response.body).toBe(200); const {task:child,parentTask} = response.json().data;
    const converted = await report(); expect(converted.counts.total).toBe(50); expect(converted.tasks.some(t => t.id === parentTask.id)).toBe(false); expect(converted.counts.unplanned).toBe(1);
    for (const id of [original.id,child.id]) expect((await transition(id,'cancel',{},'zhou')).statusCode).toBe(200);
    await app.close(); app = buildApp({dbPath,clock:() => now});
    const result = await report(); expect(result.counts.total).toBe(48); expect(result.tasks.some(t => t.id === parentTask.id)).toBe(false); expect(result.deviations.filter(d => d.state === 'cancelled')).toHaveLength(2); expect(result.deviations.filter(d => d.state === 'cancelled').every(d => d.canOpen)).toBe(true); expect(result.deviations.some(d => d.taskId === parentTask.id)).toBe(false);
    expect(JSON.parse(snapshotRows()[0]!.snapshot_json).tasks.some((t:ManagedTask) => t.id === parentTask.id)).toBe(false);
  });

  test('periodic capture starts a new Shanghai day without writes and timer is cleared on close', async () => {
    await app.close(); app = buildApp({dbPath,clock:() => now,snapshotIntervalMs:20}); await app.ready(); now = new Date('2026-09-07T16:01:00Z');
    await new Promise(resolve => setTimeout(resolve,65)); expect(snapshotRows().map(s => s.date)).toEqual(['2026-09-07','2026-09-08']);
    await app.close(); const before = snapshotRows(); await new Promise(resolve => setTimeout(resolve,40)); expect(snapshotRows()).toEqual(before);
  });
});
