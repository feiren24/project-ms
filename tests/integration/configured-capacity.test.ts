import { analyticsCsv } from '../../client/src/features/analytics/export';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AnalyticsReport } from '../../shared/src/analytics.js';
import type { PlanNode, ProjectPlan } from '../../shared/src/planning.js';
import type { RiskWorkspace } from '../../shared/src/risks.js';
import type { SettingsWorkspace } from '../../shared/src/settings.js';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import { initializeSettings } from '../../server/src/modules/settings/store.js';
import { evaluateProjectRisks } from '../../server/src/modules/risks/service.js';
import { applySchedule, readPlan, previewSchedule } from '../../server/src/modules/planning/repository.js';

const prefix = '/api/v1/projects/phase-one';
describe('settings capacity feeds analytics and automatic risks', () => {
  let app: FastifyInstance; let directory: string; let db: Database.Database;
  const now = new Date('2026-09-09T02:00:00Z'); // Wednesday: week capacity must not shrink to Wednesday–Friday.
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-configured-capacity-'));
    const path = join(directory, 'test.sqlite');
    app = buildApp({ dbPath: path, clock: () => now, riskIntervalMs: 0 }); await app.ready();
    db = new Database(path); initializeSettings(db);
    // Isolated fixture: remove seed execution state and retain one complete working week.
    const row = db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get('phase-one') as { nodes_json: string };
    const node = (JSON.parse(row.nodes_json) as PlanNode[]).find(node => node.id === 'task-008')!;
    Object.assign(node, { id: 'task-008', parentId: null, owner: '陈知远', start: '2026-09-07', end: '2026-09-11', durationDays: 5, effortHours: 40, status: 'todo' });
    db.prepare("UPDATE homepage_tasks SET owner='陈知远',status='todo' WHERE id='task-008'").run();
    db.prepare("UPDATE task_meta SET meta_json=json_set(meta_json, '$.ownerId', 'chen', '$.cancelled', 0) WHERE task_id='task-008'").run();
    db.prepare('UPDATE plan_projects SET nodes_json=?,dependencies_json=?,calendar_json=? WHERE project_id=?').run(JSON.stringify([node]), '[]', JSON.stringify({ weekdays: [1, 2, 3, 4, 5], hoursPerDay: 8, confirmed: true, exceptions: {} }), 'phase-one');
  });
  afterEach(async () => { db.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  function configure(hoursPerDay: number | null) { db.prepare('UPDATE member_capacities SET snapshot_json=? WHERE project_id=? AND member_id=?').run(JSON.stringify({ memberId: 'chen', hoursPerDay, exceptions: {} }), 'phase-one', 'chen'); }
  const risks = async (): Promise<RiskWorkspace> => (await app.inject(`${prefix}/risks`)).json().data;
  const analytics = async (): Promise<AnalyticsReport> => { const reply = await app.inject(`${prefix}/analytics?capacityMode=configured`); expect(reply.statusCode, reply.body).toBe(200); return reply.json().data; };

  test('unknown capacity explains calendar, personal configuration or incomplete tasks and provides a settings next step', async () => {
    const message = async () => (await risks()).rules.find(rule => rule.key === 'capacity_overload')!.message;
    evaluateProjectRisks(db, 'phase-one', now);
    expect(await message()).toContain('个人容量未配置完整'); expect(await message()).toContain('成员与设置');
    const plan = readPlan(db, 'phase-one', '');
    db.prepare('UPDATE plan_projects SET calendar_json=? WHERE project_id=?').run(JSON.stringify({ ...plan.calendar, confirmed: false }), 'phase-one');
    evaluateProjectRisks(db, 'phase-one', now);
    expect(await message()).toContain('日历尚未确认'); expect(await message()).toContain('容量');
    db.prepare('UPDATE plan_projects SET calendar_json=? WHERE project_id=?').run(JSON.stringify(plan.calendar), 'phase-one');
    // Every date explicitly configured: null base no longer means unknown in this window.
    const exceptions: Record<string, number> = {};
    for (let stamp = Date.parse(plan.project.start); stamp <= Date.parse(plan.project.end); stamp += 86400000) exceptions[new Date(stamp).toISOString().slice(0, 10)] = 8;
    for (const memberId of ['zhou', 'chen', 'lin', 'xu']) db.prepare('UPDATE member_capacities SET snapshot_json=? WHERE project_id=? AND member_id=?').run(JSON.stringify({ memberId, hoursPerDay: null, exceptions }), 'phase-one', memberId);
    evaluateProjectRisks(db, 'phase-one', now); expect(await message()).not.toContain('未配置');
    const nodes = plan.nodes.map(node => ({ ...node, effortHours: null }));
    db.prepare('UPDATE plan_projects SET nodes_json=? WHERE project_id=?').run(JSON.stringify(nodes), 'phase-one');
    evaluateProjectRisks(db, 'phase-one', now);
    expect(await message()).toContain('任务未分配完整'); expect(await message()).toContain('成员与设置');
  });

  test('confirmed configured capacity generates and recovers the same weekly ratio, without a midweek denominator', async () => {
    configure(8); evaluateProjectRisks(db, 'phase-one', now);
    expect((await risks()).alerts.filter(alert => alert.rule === 'capacity_overload' && alert.status !== 'resolved')).toHaveLength(0);
    configure(4); evaluateProjectRisks(db, 'phase-one', now);
    const alert = (await risks()).alerts.find(alert => alert.rule === 'capacity_overload')!;
    expect(alert).toMatchObject({ objectId: 'chen:2026-09-07', status: 'open', taskIds: ['task-008'] });
    expect(alert.evidence).toContain('40 小时'); expect(alert.evidence).toContain('20 小时');
    expect((await analytics()).capacity.members.find(member => member.id === 'chen')!.cells[0]).toMatchObject({ plannedHours: 40, availableHours: 20, ratio: 2 });
    configure(null); evaluateProjectRisks(db, 'phase-one', now);
    expect((await risks()).alerts.find(item => item.id === alert.id)!.status).toBe('open');
    configure(8); evaluateProjectRisks(db, 'phase-one', now);
    expect((await risks()).alerts.find(item => item.id === alert.id)!.status).toBe('resolved');
  });

  test('configured capacity CSV preserves measured ratios and uses configured capacity labels', async () => {
    configure(4);
    const overloaded = await analytics();
    const csv = analyticsCsv(overloaded, 'capacity');
    expect(csv).toContain('按已配置个人容量计算，缺失项不估算');
    expect(csv).not.toContain('个人容量未知，不计算负荷比');
    expect(csv).toContain('"40","20","2","已配置容量超额"');
    expect(csv).not.toContain('试算超载');
    configure(8);
    expect(analyticsCsv(await analytics(), 'capacity')).toContain('"40","40","1","负荷正常"');
  });

  test('missing estimates and unconfirmed calendar preserve existing overload alerts; completed work stops contributing', async () => {
    configure(0); evaluateProjectRisks(db, 'phase-one', now);
    const alert = (await risks()).alerts.find(alert => alert.rule === 'capacity_overload')!; expect(alert).toBeDefined();
    const row = db.prepare('SELECT nodes_json,calendar_json FROM plan_projects WHERE project_id=?').get('phase-one') as { nodes_json: string; calendar_json: string };
    const nodes = JSON.parse(row.nodes_json); nodes[0].effortHours = null;
    db.prepare('UPDATE plan_projects SET nodes_json=? WHERE project_id=?').run(JSON.stringify(nodes), 'phase-one');
    evaluateProjectRisks(db, 'phase-one', now); expect((await risks()).alerts.find(item => item.id === alert.id)!.status).toBe('open');
    nodes[0].effortHours = 40;
    db.prepare('UPDATE plan_projects SET nodes_json=?,calendar_json=? WHERE project_id=?').run(JSON.stringify(nodes), JSON.stringify({ ...JSON.parse(row.calendar_json), confirmed: false }), 'phase-one');
    evaluateProjectRisks(db, 'phase-one', now); expect((await risks()).alerts.find(item => item.id === alert.id)!.status).toBe('open');
    nodes[0].status = 'done'; db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-008'").run();
    db.prepare('UPDATE plan_projects SET nodes_json=?,calendar_json=? WHERE project_id=?').run(JSON.stringify(nodes), row.calendar_json, 'phase-one');
    evaluateProjectRisks(db, 'phase-one', now); expect((await risks()).alerts.find(item => item.id === alert.id)!.status).toBe('resolved');
  });

  test('calendar reread derives current duration, preserves dates effort baselines and surfaces invalid endpoints', () => {
    const before = readPlan(db, 'phase-one', '');
    const calendar = { ...before.calendar, exceptions: { '2026-09-09': false, '2026-09-11': false } };
    db.prepare('UPDATE plan_projects SET calendar_json=?,version=version+1 WHERE project_id=?').run(JSON.stringify(calendar), 'phase-one');
    const after = readPlan(db, 'phase-one', '');
    expect(after.nodes[0]).toMatchObject({ start: '2026-09-07', end: '2026-09-11', effortHours: 40, durationDays: 3 });
    expect(after.baselines).toEqual(before.baselines);
    expect(after.issues.some(issue => issue.objectId === 'task-008' && issue.code === 'CALENDAR_DATE_CONFLICT')).toBe(true);
    const invalid = previewSchedule(db, 'phase-one', { expectedPlanVersion: after.planVersion, reason: 'DEMO 日历确认', mode: 'push_successors', changes: [], dependencyTargetId: 'task-008', incomingDependencies: [] }, now);
    expect(invalid.canApply).toBe(false);
    expect(invalid.issues.some(issue => issue.code === 'CALENDAR_DATE_CONFLICT' && issue.severity === 'error')).toBe(true);
    const corrected = previewSchedule(db, 'phase-one', { expectedPlanVersion: after.planVersion, reason: 'DEMO 修复休息日端点', mode: 'push_successors', changes: [{ taskId: 'task-008', start: '2026-09-07', end: '2026-09-10' }] }, now);
    expect(corrected.canApply).toBe(true);
    db.prepare('UPDATE plan_projects SET calendar_json=? WHERE project_id=?').run(JSON.stringify(before.calendar), 'phase-one');
    expect(readPlan(db, 'phase-one', '').nodes[0]!.durationDays).toBe(5);
  });

  test('new previews propagate successors using the changed calendar duration', () => {
    const before = readPlan(db, 'phase-one', '');
    const first = before.nodes[0]!;
    const successor = { ...first, id: 'calendar-successor', title: 'DEMO 后续任务' };
    const calendar = { ...before.calendar, exceptions: { '2026-09-09': false, '2026-09-11': false } };
    db.prepare('UPDATE plan_projects SET nodes_json=?,dependencies_json=?,calendar_json=? WHERE project_id=?').run(JSON.stringify([first, successor]), JSON.stringify([{ predecessorId: first.id, successorId: successor.id, type: 'FS', lagDays: 0 }]), JSON.stringify(calendar), 'phase-one');
    const preview = previewSchedule(db, 'phase-one', { expectedPlanVersion: before.planVersion, reason: 'DEMO 新日历下顺延', mode: 'push_successors', changes: [{ taskId: first.id, start: '2026-09-14', end: '2026-09-16' }] }, now);
    expect(preview.canApply).toBe(true);
    expect(preview.changes.find(change => change.taskId === successor.id)).toMatchObject({ start: '2026-09-17', end: '2026-09-21' });
    expect(readPlan(db, 'phase-one', '').nodes.find(node => node.id === successor.id)).toMatchObject({ start: '2026-09-07', end: '2026-09-11', effortHours: 40 });
  });

  test('applying another task preserves original duration when calendar temporarily gives an untouched task zero workdays', async () => {
    const before = readPlan(db, 'phase-one', '');
    const first = before.nodes[0]!;
    const other = { ...first, id: 'calendar-other', title: 'DEMO 另一任务', start: '2026-09-14', end: '2026-09-18' };
    db.prepare('UPDATE plan_projects SET nodes_json=? WHERE project_id=?').run(JSON.stringify([first, other]), 'phase-one');
    async function setCalendar(calendar: ProjectPlan['calendar']) {
      const state: SettingsWorkspace = (await app.inject(`${prefix}/settings`)).json().data;
      const result = await app.inject({ method: 'POST', url: `${prefix}/settings/calendar`, headers: { 'x-preview-token': state.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: { expectedVersion: state.version, expectedPlanVersion: state.planVersion, reason: 'DEMO 日历调整回归', calendar } });
      expect(result.statusCode, result.body).toBe(200);
    }
    await setCalendar({ ...before.calendar, exceptions: { '2026-09-07': false, '2026-09-08': false, '2026-09-09': false, '2026-09-10': false, '2026-09-11': false } });
    const current = readPlan(db, 'phase-one', ''); expect(current.nodes[0]!.durationDays).toBe(0);
    const preview = previewSchedule(db, 'phase-one', { expectedPlanVersion: current.planVersion, reason: 'DEMO 仅修改另一任务', mode: 'push_successors', changes: [{ taskId: other.id, start: '2026-09-16', end: '2026-09-18' }] }, now);
    expect(preview.canApply).toBe(true);
    applySchedule(db, 'phase-one', { previewId: preview.id, expectedPlanVersion: current.planVersion }, randomUUID(), now);
    await setCalendar(before.calendar);
    expect(readPlan(db, 'phase-one', '').nodes[0]).toMatchObject({ start: first.start, end: first.end, durationDays: 5, effortHours: 40 });
    expect(readPlan(db, 'phase-one', '').baselines).toEqual(before.baselines);
  });

  test('inactive historical members remain available to analytics owner filters and allocation', async () => {
    configure(8);
    db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-008'").run();
    db.prepare("UPDATE project_members SET active=0 WHERE project_id='phase-one' AND id='chen'").run();
    const response = await app.inject(`${prefix}/analytics?capacityMode=configured&ownerId=chen`);
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json().data as AnalyticsReport;
    expect(report.options.owners.some(owner => owner.id === 'chen')).toBe(true);
    expect(report.capacity.members[0]!.cells[0]).toMatchObject({ plannedHours: 40, availableHours: 40 });
    expect(report.capacity.unallocated).toHaveLength(0);
  });

  test('settings writes refresh both automatic alerts and today snapshot without rewriting prior days', async () => {
    const getSettings = async (): Promise<SettingsWorkspace> => (await app.inject(`${prefix}/settings`)).json().data;
    const first = await getSettings(); expect(first).toBeDefined();
    const snapshot = db.prepare('SELECT snapshot_json FROM analytics_daily_snapshots WHERE project_id=?').get('phase-one') as { snapshot_json: string };
    const historical = JSON.stringify({ ...JSON.parse(snapshot.snapshot_json), date: '2026-09-08', capturedAt: '2026-09-08T02:00:00.000Z' });
    db.prepare('INSERT INTO analytics_daily_snapshots(project_id,date,captured_at,data_as_of,snapshot_json) VALUES (?,?,?,?,?)').run('phase-one', '2026-09-08', '2026-09-08T02:00:00.000Z', '2026-09-21', historical);
    async function save(hoursPerDay: number) {
      const state = await getSettings();
      const response = await app.inject({ method: 'POST', url: `${prefix}/settings/capacity`, headers: { 'x-preview-token': state.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: { expectedVersion: state.version, expectedPlanVersion: state.planVersion, reason: 'DEMO 测试当前容量', capacity: { memberId: 'chen', hoursPerDay, exceptions: {} } } });
      expect(response.statusCode, response.body).toBe(200); return response.json().data as SettingsWorkspace;
    }
    await save(4);
    const alert = (await risks()).alerts.find(alert => alert.rule === 'capacity_overload')!; expect(alert.status).toBe('open');
    const saved = await save(8);
    expect((await risks()).alerts.find(item => item.id === alert.id)!.status).toBe('resolved');
    const rows = db.prepare('SELECT date,snapshot_json FROM analytics_daily_snapshots WHERE project_id=? ORDER BY date').all('phase-one') as Array<{ date: string; snapshot_json: string }>;
    expect(rows[0]!.snapshot_json).toBe(historical);
    expect(JSON.parse(rows.at(-1)!.snapshot_json).planVersion).toBe(saved.planVersion);
    expect((await analytics()).warnings.join()).not.toContain('落后当前计划版本');
  });
});
