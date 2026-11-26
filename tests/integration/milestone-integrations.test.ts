import { invalidateTasksForMilestone } from '../../server/src/modules/tasks/milestone-invalidation.js';
import { reconcileMilestones } from '../../server/src/modules/milestones/store.js';
import { deliverNotification, readNotifications } from '../../server/src/modules/notifications/repository.js';
import { readTasks, writeTask } from '../../server/src/modules/tasks/repository.js';
import { forecastMilestone } from '../../server/src/modules/planning/forecast.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import { initializeMilestones, readMilestoneRecords, readMilestoneTaskFacts } from '../../server/src/modules/milestones/store.js';
import { readPlan, publishBaseline, previewSchedule } from '../../server/src/modules/planning/repository.js';
import { readAnalytics } from '../../server/src/modules/analytics/repository.js';
import { readProjectOverview } from '../../server/src/modules/overview/repository.js';
import { captureProjectEvents } from '../../server/src/modules/notifications/events.js';
import { writeSettings, readSettings } from '../../server/src/modules/settings/repository.js';

const projectId = 'phase-one';
const now = new Date('2026-09-21T08:00:00.000Z');
describe('milestone cross-module projections', () => {
  let directory: string; let app: FastifyInstance; let db: Database.Database;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'goodwork-milestone-integration-')); const dbPath = join(directory, 'test.sqlite'); app = buildLegacyApp({ dbPath, clock: () => now }); db = new Database(dbPath); initializeMilestones(db, now); });
  afterEach(async () => { db.close(); await app.close(); await rm(directory, {recursive:true,force:true}); });
  const records = () => readMilestoneRecords(db, projectId);
  function patch(id: string, update: Record<string,unknown>) { const record = records().find(item => item.id === id)!; db.prepare('UPDATE milestone_records SET record_json=? WHERE project_id=? AND id=?').run(JSON.stringify({...record,...update}), projectId, id); db.prepare('UPDATE plan_projects SET version=version+1 WHERE project_id=?').run(projectId); }
  test('legacy completion is retained as unverified history and never counted as accepted', () => {
    expect(records().some(item => item.state === 'legacy_achieved')).toBe(true);
    const analytics = readAnalytics(db,projectId,{},now);
    expect(analytics.metrics.milestoneAchievement.numerator).toBe(0);
    expect(analytics.metricVersion).toBe('1.2.0');
    const old = records().find(item => item.state === 'legacy_achieved')!;
    expect(readPlan(db,projectId,'',now).nodes.find(node => node.id === old.id)).toMatchObject({status:'review',milestoneState:'legacy_achieved',acceptedAt:null});
    expect(readProjectOverview(db,projectId,now)!.milestones.find(item => item.id === old.id)).toMatchObject({status:'review',milestoneState:'legacy_achieved'});
  });
  test('accepted-only numerator, cancelled exclusion and original baseline immutability agree', () => {
    const before = readPlan(db,projectId,'',now).baselines;
    patch('milestone-01',{state:'accepted',acceptedAt:now.toISOString(),ownerId:'chen'});
    db.prepare('UPDATE project_members SET active=0 WHERE project_id=? AND id=?').run(projectId,'chen');
    patch('milestone-02',{state:'cancelled'});
    patch('milestone-03',{state:'needs_review',acceptedAt:now.toISOString()});
    const analytics = readAnalytics(db,projectId,{},now);
    expect(analytics.metrics.milestoneAchievement).toMatchObject({numerator:1,denominator:5});
    expect(analytics.milestones.find(item=>item.id==='milestone-01')!.owner).toBeTruthy();
    expect(readPlan(db,projectId,'',now).nodes.find(node => node.id === 'milestone-02')).toMatchObject({status:'todo',milestoneState:'cancelled'});
    expect(readPlan(db,projectId,'',now).criticalIds).not.toContain('milestone-02');
    expect(readPlan(db,projectId,'',now).baselines).toEqual(before);
  });
  test('formal baselines reject missing milestone identities and freeze configured conditions', () => {
    const request = () => ({expectedPlanVersion:readPlan(db,projectId,'',now).planVersion,name:'明确承诺',reason:'确认完整范围',calendarConfirmed:true,excludedIds:['gap-operations'],exclusionReason:'范围待细化'});
    expect(() => publishBaseline(db,projectId,request(),now)).toThrow(/里程碑/);
    const actors = readSettings(db,projectId,'').actors.filter(actor => actor.role !== 'viewer');
    for (const record of records()) patch(record.id,{ownerId:actors[0]!.id,reviewerId:actors[1]!.id,criteria:[{id:'evidence',title:'验收报告',kind:'evidence',taskId:null}]});
    patch('milestone-03',{state:'cancelled'});
    expect(() => publishBaseline(db,projectId,request(),now)).toThrow(/已取消里程碑仍有关联依赖/);
    const plan = readPlan(db,projectId,'',now);
    db.prepare('UPDATE plan_projects SET dependencies_json=? WHERE project_id=?').run(JSON.stringify(plan.dependencies.filter(edge => edge.predecessorId !== 'milestone-03' && edge.successorId !== 'milestone-03')),projectId);
    const baseline = publishBaseline(db,projectId,request(),now);
    expect(baseline.excludedIds).toContain('milestone-03');
    expect(baseline.entries.some(entry => entry.taskId === 'milestone-03')).toBe(false);
    expect(baseline.entries.find(entry => entry.taskId === 'milestone-01')!.milestone).toMatchObject({ownerId:actors[0]!.id,reviewerId:actors[1]!.id,criteria:[{id:'evidence',title:'验收报告'}]});
  });
  test('submitted and cancelled milestone dates cannot be changed through scheduling', () => {
    for (const state of ['submitted','cancelled']) {
      patch('milestone-03',{state});
      expect(() => previewSchedule(db,projectId,{expectedPlanVersion:readPlan(db,projectId,'',now).planVersion,changes:[{taskId:'milestone-03',start:'2026-10-01',end:'2026-10-01'}],mode:'push_successors'},now)).toThrow(/里程碑/);
    }
  });
  test('unresolved milestone ownership prevents member disabling and notifications deduplicate with deep links', () => {
    db.prepare('INSERT INTO project_members(project_id,id,name,role,active) VALUES(?,?,?,?,?)').run(projectId,'milestone-only-member','里程碑专属成员','member',1);
    const settings = readSettings(db,projectId,''); const owner = settings.members.find(member => member.id === 'milestone-only-member')!; const manager = settings.actors.find(actor => actor.role === 'manager')!;
    patch('milestone-03',{ownerId:owner.id,reviewerId:manager.id,events:[{id:'invalidation-1',action:'needs_review',actorId:manager.id,actor:manager.name,text:'必要任务重开',createdAt:now.toISOString()}]});
    const current=readSettings(db,projectId,'');
    expect(() => writeSettings(db,projectId,'member_update',{expectedVersion:current.version,expectedPlanVersion:current.planVersion,member:{id:owner.id,name:owner.name,role:owner.role,active:false},reason:'职责移交检查'},manager.id,'milestone-disable',now)).toThrow(/里程碑.*移交/);
    captureProjectEvents(db,projectId,now,['task-006']);
    const jobs = () => db.prepare("SELECT payload_json FROM background_jobs WHERE kind='notification' AND json_extract(payload_json,'$.target.kind')='milestone'").all() as {payload_json:string}[];
    expect(jobs().length).toBeGreaterThan(0); const count=jobs().length;
    expect(JSON.parse(jobs()[0]!.payload_json).target).toEqual({kind:'milestone',id:'milestone-03'});
    captureProjectEvents(db,projectId,now,['task-006']); expect(jobs()).toHaveLength(count);
    const payload = JSON.parse(jobs()[0]!.payload_json);
    deliverNotification(db,projectId,payload,now); deliverNotification(db,projectId,payload,now);
    expect(readNotifications(db,projectId,payload.recipientId,'').notifications.filter(item => item.target.id === 'milestone-03')).toHaveLength(1);
  });
  test('task reopening invalidates accepted evidence atomically and failed receipt restores all state', () => {
    const task = readTasks(db,projectId,'',now).tasks.find(task => task.status === 'done' && !task.requiresReview)!;
    const record = records()[0]!; const fact = readMilestoneTaskFacts(db,projectId).get(task.id)!;
    const criteria = [{id:'required-task',kind:'task' as const,title:'必要交付',taskId:task.id}];
    const submission = {id:'accepted-submission',submitterId:'zhou',createdAt:now.toISOString(),snapshot:{...record,...record.delivery,criteria},taskVersions:{[task.id]:fact.fingerprint},invalidatedAt:null,reviews:[]};
    patch(record.id,{state:'accepted',acceptedAt:now.toISOString(),criteria,submissions:[submission]});
    const workspace = readTasks(db,projectId,'',now); const initial = records().find(item => item.id === record.id)!;
    const body={expectedPlanVersion:workspace.planVersion,expectedVersion:task.version,action:'reopen',progress:50,reason:'必要成果修订'};
    db.exec("CREATE TRIGGER milestone_receipt_failure BEFORE INSERT ON task_idempotency BEGIN SELECT RAISE(ABORT,'fixture receipt unavailable'); END;");
    expect(() => writeTask(db,projectId,'transition',task.id,body,'zhou','milestone-reopen-atomic',now)).toThrow(/fixture/);
    expect(records().find(item => item.id === record.id)).toEqual(initial);
    expect(readTasks(db,projectId,'',now).tasks.find(item => item.id === task.id)?.status).toBe('done');
    db.exec('DROP TRIGGER milestone_receipt_failure');
    writeTask(db,projectId,'transition',task.id,body,'zhou','milestone-reopen-atomic',now);
    const invalidated=records().find(item => item.id === record.id)!;
    expect(invalidated).toMatchObject({state:'needs_review',acceptedAt:null});
    expect(invalidated.submissions[0]!.snapshot).toEqual(submission.snapshot);
    expect(invalidated.submissions[0]!.invalidatedAt).toBe(now.toISOString());
    expect(invalidated.events.at(-1)!.action).toBe('invalidated');
    expect(db.prepare("SELECT 1 FROM background_jobs WHERE kind='notification' AND json_extract(payload_json,'$.target.kind')='milestone' LIMIT 1").get()).toBeTruthy();
  });
  test('cancelled milestone never satisfies task completion and forecast uses actual acceptance dates', () => {
    const task=readTasks(db,projectId,'',now).tasks.find(item => item.status === 'in_progress' && !item.requiresReview && !item.blocked)!;
    const record=records()[0]!;
    patch(record.id,{state:'cancelled',acceptedAt:now.toISOString()});
    db.prepare('UPDATE plan_projects SET dependencies_json=? WHERE project_id=?').run(JSON.stringify([{predecessorId:record.id,successorId:task.id,type:'FS',lagDays:0}]),projectId);
    const workspace=readTasks(db,projectId,'',now);
    expect(() => writeTask(db,projectId,'transition',task.id,{expectedPlanVersion:workspace.planVersion,expectedVersion:task.version,action:'complete'},'zhou','cancelled-predecessor',now)).toThrow(/前置/);
    let plan=readPlan(db,projectId,'',now);plan.calendar.confirmed=true;
    expect(forecastMilestone(plan,workspace.tasks,record.id,'2026-09-21')).toBeNull();
    patch(record.id,{state:'accepted',acceptedAt:'2026-09-20T17:00:00.000Z'});
    plan=readPlan(db,projectId,'',now);plan.calendar.confirmed=true;
    expect(forecastMilestone(plan,workspace.tasks,record.id,'2026-09-21')?.end).toBe('2026-09-21');
  });

  test('milestone invalidation cascades through critical task reviews atomically while preserving ordinary execution', () => {
    const workspace=readTasks(db,projectId,'',now), critical=[workspace.tasks.find(item=>item.requiresReview)!,workspace.tasks.find(item=>!item.requiresReview&&item.status==='in_progress')!], ordinary=workspace.tasks.find(item=>item.status==='done'&&!item.requiresReview)!;
    expect(critical).toHaveLength(2);
    for(const [index,task] of critical.entries()) {
      const meta=JSON.parse((db.prepare('SELECT meta_json FROM task_meta WHERE project_id=? AND task_id=?').get(projectId,task.id) as {meta_json:string}).meta_json);
      const status=index===0?'accepted':'submitted';
      Object.assign(meta,{requiresReview:true,ownerId:'chen',reviewerId:'lin',reviewStatus:status,actualEnd:'2026-09-20',completionPlanEnd:'2026-09-20',submissions:[{id:`critical-${index}`,taskId:task.id,version:1,submitterId:meta.ownerId,reviewerId:meta.reviewerId,evidence:'原始验收证据',status,comment:'保留验收记录',createdAt:now.toISOString(),reviewedAt:index===0?now.toISOString():null}]});
      db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify(meta),projectId,task.id);
      db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE project_id=? AND id=?").run(projectId,task.id);
    }
    const edge=(from:string,to:string)=>({predecessorId:from,successorId:to,type:'FS',lagDays:0});
    db.prepare('UPDATE plan_projects SET dependencies_json=? WHERE project_id=?').run(JSON.stringify([edge('milestone-01',critical[0]!.id),edge(critical[0]!.id,ordinary.id),edge('milestone-03',critical[1]!.id)]),projectId);
    patch('milestone-01',{state:'cancelled'});
    patch('milestone-03',{state:'accepted',acceptedAt:now.toISOString(),criteria:[{id:'required',kind:'task',title:'必要成果',taskId:critical[0]!.id}]});
    const before=readTasks(db,projectId,'',now), planVersion=before.planVersion;
    const jobs=db.prepare('SELECT * FROM background_jobs').all();
    db.prepare('UPDATE project_members SET active=0 WHERE project_id=? AND id=?').run(projectId,'lin');
    expect(()=>invalidateTasksForMilestone(db,projectId,'milestone-01',now,'项目管理者')).toThrow(/验收人.*停用/);
    db.prepare('UPDATE project_members SET active=1 WHERE project_id=? AND id=?').run(projectId,'lin');
    db.exec(`CREATE TRIGGER critical_invalidation_failure BEFORE UPDATE ON task_meta WHEN OLD.task_id='${critical[1]!.id}' BEGIN SELECT RAISE(ABORT,'fixture downstream unavailable'); END;`);
    expect(()=>db.transaction(()=>invalidateTasksForMilestone(db,projectId,'milestone-01',now,'项目管理者'))()).toThrow(/fixture downstream/);
    expect(readTasks(db,projectId,'',now).tasks).toEqual(before.tasks);
    db.exec('DROP TRIGGER critical_invalidation_failure');
    const changed=db.transaction(()=>{const ids=invalidateTasksForMilestone(db,projectId,'milestone-01',now,'项目管理者');reconcileMilestones(db,projectId,now,'项目管理者');return ids;})();
    expect(changed.sort()).toEqual(critical.map(item=>item.id).sort());
    const after=readTasks(db,projectId,'',now);
    for(const task of critical) expect(after.tasks.find(item=>item.id===task.id)).toMatchObject({status:'in_progress',progress:99,actualEnd:null,completionPlanEnd:null,reviewStatus:'needs_review',version:task.version+1});
    expect(after.tasks.find(item=>item.id===critical[0]!.id)!.submissions[0]!.status).toBe('accepted');
    expect(after.tasks.find(item=>item.id===critical[1]!.id)!.submissions[0]!.status).toBe('invalidated');
    expect(after.tasks.find(item=>item.id===ordinary.id)).toEqual(ordinary);
    expect(after.planVersion).toBe(planVersion);expect(db.prepare('SELECT * FROM background_jobs').all()).toEqual(jobs);
    expect(records().find(item=>item.id==='milestone-03')!.state).toBe('needs_review');
    expect(invalidateTasksForMilestone(db,projectId,'milestone-01',now,'项目管理者')).toEqual([]);
  });

});
