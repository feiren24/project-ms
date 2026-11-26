import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import { applyRiskEvaluation } from '../../server/src/modules/risks/service.js';
import type { ManagedRisk, RiskDraft, RiskWorkspace } from '../../shared/src/risks.js';
const prefix = '/api/v1/projects/phase-one';
const draft: RiskDraft = { title: 'DEMO · 联调风险', description: '虚构风险', workstreamId: 'system-bottom', ownerId: 'zhou', probability: 4, impact: 5, due: '2026-10-01', reviewDate: null, response: '检查接口', taskIds: [], closeReviewerId: null };
describe('risk ledger, independent review and automatic alert lifecycle', () => {
  let app: FastifyInstance; let directory: string; let dbPath: string; let now: Date;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'goodwork-risks-')); dbPath = join(directory, 'risks.sqlite'); now = new Date('2026-09-23T02:00:00Z'); app = buildApp({ dbPath, clock: () => now }); const db = new Database(dbPath); db.prepare("UPDATE project_members SET role='project_admin' WHERE id='lin'").run(); db.close(); });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function workspace(): Promise<RiskWorkspace> { const r = await app.inject(`${prefix}/risks`); expect(r.statusCode, r.body).toBe(200); return r.json().data; }
  async function send(path: string, body: object, actor = 'zhou', method: 'POST' | 'PATCH' = 'POST', key: string = randomUUID()) { const w = await workspace(); return app.inject({ method, url: `${prefix}/risks${path}`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': actor, 'idempotency-key': key }, payload: body }); }
  async function create(extra: Partial<RiskDraft> = {}): Promise<ManagedRisk> { const w = await workspace(); const r = await send('', { ...draft, workstreamId: w.workstreams[0]!.id, ...extra }); expect(r.statusCode, r.body).toBe(200); return r.json().data.risk; }
  async function transition(risk: ManagedRisk, action: string, extra = {}, actor = 'zhou'): Promise<ManagedRisk> { const r = await send(`/${risk.id}/transition`, { expectedVersion: risk.version, reason: 'DEMO · 已核对', action, ...extra }, actor); expect(r.statusCode, r.body).toBe(200); return r.json().data.risk; }
  test('seeds historical IDs and levels without invented scores; GET is readonly, risk writes leave plan untouched', async () => {
    const w = await workspace(); expect(w.risks).toHaveLength(4); expect(w.risks.find(r => r.id === 'risk-04')).toMatchObject({ ownerId: 'xu', probability: null, impact: null, level: 'medium', legacyLevel: 'medium' });
    expect(w.risks.every(r => r.probability === null && r.status === 'identified')).toBe(true); expect(w.today).toBe('2026-09-23'); expect(w.project.asOf).toBe('2026-09-21');
    expect(w.rules.find(r => r.key === 'capacity_overload')?.status).toBe('unknown'); expect(w.lastEvaluatedAt).toBeTruthy(); expect(await workspace()).toEqual(w);
    const risk = await create(); expect(risk).toMatchObject({ score: 20, level: 'critical', legacyLevel: null }); expect((await workspace()).planVersion).toBe(w.planVersion);
    const overview = (await app.inject(`${prefix}/overview`)).json().data; expect(overview.summary.highRisks).toBe(4); expect(overview.risks.find((r: { id: string }) => r.id === risk.id)).toBeTruthy();
  });
  test('validates token/origin/actor/key, fields and ownership, rejects stale versions and persists replay across restart', async () => {
    const w = await workspace(); const risk = w.risks[0]!;
    expect((await app.inject({ method: 'POST', url: `${prefix}/risks`, payload: draft })).statusCode).toBe(403);
    for (const actor of ['chen', 'xu', 'missing']) expect((await send('', draft, actor)).statusCode).toBe(403);
    expect((await send('', draft, 'zhou', 'POST', 'bad')).statusCode).toBe(422);
    const foreign = await app.inject({ method: 'POST', url: `${prefix}/risks`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID(), origin: 'https://evil.example' }, payload: draft }); expect(foreign.statusCode).toBe(403);
    for (const extra of [{ probability: 0 }, { probability: null }, { due: '2026-02-30' }, { ownerId: 'xu' }, { taskIds: ['foreign-task'] }, { status: 'closed' }, { closeReviewerId: 'chen' }]) expect((await send('', { ...draft, ...extra })).statusCode).toBe(422);
    expect((await send(`/${risk.id}/transition`, { expectedVersion: 1, action: 'occur', reason: '测试' }, 'chen')).statusCode).toBe(403);
    const created = await create(); const key = randomUUID(); const body = { expectedVersion: created.version, action: 'assess', reason: '评分完成' };
    const first = await send(`/${created.id}/transition`, body, 'zhou', 'POST', key); expect(first.statusCode, first.body).toBe(200);
    expect((await send(`/${created.id}/transition`, body, 'zhou')).statusCode).toBe(409);
    await app.close(); app = buildApp({ dbPath, clock: () => now });
    expect((await send(`/${created.id}/transition`, body, 'zhou', 'POST', key)).json()).toEqual(first.json());
    expect((await send(`/${created.id}/transition`, { ...body, reason: '不同' }, 'zhou', 'POST', key)).statusCode).toBe(409);
    expect((await send(`/${created.id}/transition`, body, 'lin', 'POST', key)).statusCode).toBe(409);
  });
  test('requires scoring and future acceptance review; owner submits, manager independently reviews, pending draft locks and reopen keeps audit', async () => {
    let risk = await create({ probability: null, impact: null });
    expect((await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'assess', reason: '评估' }, 'zhou')).statusCode).toBe(422);
    const edit = await send(`/${risk.id}`, { ...draft, workstreamId: risk.workstreamId, expectedVersion: risk.version, reason: '人工评估' }, 'zhou', 'PATCH'); expect(edit.statusCode, edit.body).toBe(200); risk = edit.json().data.risk;
    risk = await transition(risk, 'assess'); risk = await transition(risk, 'mitigate');
    expect((await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'accept', reason: '接受', reviewDate: '2026-09-23' }, 'zhou')).statusCode).toBe(422);
    risk = await transition(risk, 'accept', { reviewDate: '2026-10-05' }); expect(risk.status).toBe('monitoring');
    expect((await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'submit_close', reason: '关闭' }, 'chen')).statusCode).toBe(403);
    risk = await transition(risk, 'submit_close'); expect(risk.closure?.submittedBy).toBe('zhou');
    expect((await send(`/${risk.id}`, { ...draft, expectedVersion: risk.version, reason: '锁定期间改' }, 'zhou', 'PATCH')).statusCode).toBe(422);
    expect((await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'approve_close', reason: '' }, 'zhou')).statusCode).toBe(422);
    risk = await transition(risk, 'reject_close', {}, 'zhou'); expect(risk.status).toBe('monitoring'); risk = await transition(risk, 'submit_close'); risk = await transition(risk, 'approve_close', {}, 'zhou');
    expect(risk.status).toBe('closed'); expect((await app.inject(`${prefix}/overview`)).json().data.summary.highRisks).toBe(3);
    risk = await transition(risk, 'reopen'); expect(risk.status).toBe('monitoring'); expect(risk.events.some(e => e.action === 'approve_close' && e.actor === '周亦安')).toBe(true);
    let self = await create({ ownerId: 'zhou', closeReviewerId: 'lin' }); self = await transition(self, 'assess', {}, 'zhou'); self = await transition(self, 'mitigate', {}, 'zhou'); self = await transition(self, 'monitor', {}, 'zhou'); self = await transition(self, 'submit_close', {}, 'zhou');
    const reviewed = await transition(self, 'approve_close', { reason: '管理者确认自审依据' }, 'zhou');
    expect(reviewed.status).toBe('closed'); expect(reviewed.closure).toMatchObject({ reviewedById: 'zhou', selfReview: true });
    expect(reviewed.closeReviewerId).toBe('lin');
  });
  test('creates response tasks atomically and snapshots task versions before independent closure', async () => {
    let risk = await create(); const w = await workspace(); const taskDraft = { title: 'DEMO · 风险应对', description: '', workstreamId: risk.workstreamId, ownerId: 'chen', parentId: null, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null };
    const body = { expectedVersion: risk.version, expectedPlanVersion: w.planVersion, draft: taskDraft };
    expect((await send(`/${risk.id}/actions/create`, body, 'chen')).statusCode).toBe(403);
    const fixture = new Database(dbPath); fixture.exec("CREATE TRIGGER reject_risk_update BEFORE UPDATE ON risk_records BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;"); fixture.close();
    expect((await send(`/${risk.id}/actions/create`, body)).statusCode).toBe(500); expect((await workspace()).tasks).toHaveLength(w.tasks.length); expect((await workspace()).planVersion).toBe(w.planVersion);
    const repair = new Database(dbPath); repair.exec('DROP TRIGGER reject_risk_update'); repair.close();
    const created = await send(`/${risk.id}/actions/create`, body); expect(created.statusCode, created.body).toBe(200); risk = created.json().data.risk; const task = created.json().data.task; expect(risk.actionTaskIds).toEqual([task.id]);
    risk = await transition(risk, 'assess'); risk = await transition(risk, 'mitigate'); risk = await transition(risk, 'monitor');
    expect((await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'submit_close', reason: '尚未处理' }, 'zhou')).statusCode).toBe(422);
    risk = await transition(risk, 'submit_close', { residualReasons: { [task.id]: '接受本条剩余风险，下期跟进' } });
    const taskEdit = await app.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/comments`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'chen', 'idempotency-key': randomUUID() }, payload: { expectedVersion: task.version, expectedPlanVersion: (await workspace()).planVersion, text: '任务已有新证据' } }); expect(taskEdit.statusCode).toBe(200);
    const stale = await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'approve_close', reason: '复核' }); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('ACTION_TASK_CHANGED');
    risk = await transition(risk, 'reject_close', {}, 'zhou'); risk = await transition(risk, 'submit_close', { residualReasons: { [task.id]: '核对新证据仍接受' } }); expect((await transition(risk, 'approve_close', {}, 'zhou')).status).toBe('closed');
  });
  test('de-duplicates evidence, snoozes until a future day, resolves and reopens same alert; conversions never invent scores', async () => {
    let w = await workspace(); const alert = w.alerts.find(a => a.rule === 'overdue')!; expect(alert).toBeTruthy();
    await send('/evaluate', {}); const repeated = (await workspace()).alerts.find(a => a.id === alert.id)!; expect(repeated.events).toEqual(alert.events); expect(repeated.version).toBe(alert.version);
    expect((await send(`/alerts/${alert.id}/snooze`, { expectedVersion: alert.version, reason: '等待反馈', until: w.today })).statusCode).toBe(422);
    const snooze = await send(`/alerts/${alert.id}/snooze`, { expectedVersion: alert.version, reason: '等待反馈', until: '2026-09-24' }); expect(snooze.statusCode, snooze.body).toBe(200);
    await send('/evaluate', {}); expect((await workspace()).alerts.find(a => a.id === alert.id)?.status).toBe('snoozed'); now = new Date('2026-09-24T01:00:00Z'); await send('/evaluate', {}); expect((await workspace()).alerts.find(a => a.id === alert.id)?.status).toBe('open');
    const fixture = new Database(dbPath); fixture.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id=?").run(alert.objectId); const row = fixture.prepare('SELECT nodes_json FROM plan_projects').get() as { nodes_json: string }; const nodes = JSON.parse(row.nodes_json); const node = nodes.find((n: { id: string }) => n.id === alert.objectId); const oldStatus = node.status; node.status = 'done'; node.progress = 100; fixture.prepare('UPDATE plan_projects SET nodes_json=?').run(JSON.stringify(nodes)); fixture.close();
    await send('/evaluate', {}); expect((await workspace()).alerts.find(a => a.id === alert.id)?.status).toBe('resolved');
    const restore = new Database(dbPath); restore.prepare('UPDATE homepage_tasks SET status=?,progress=20 WHERE id=?').run(oldStatus, alert.objectId); node.status = oldStatus; node.progress = 20; restore.prepare('UPDATE plan_projects SET nodes_json=?').run(JSON.stringify(nodes)); restore.close();
    await send('/evaluate', {}); w = await workspace(); expect(w.alerts.filter(a => a.rule === alert.rule && a.objectId === alert.objectId)).toHaveLength(1); expect(w.alerts.find(a => a.id === alert.id)?.status).toBe('open');
    const convert = await send('', { ...draft, probability: null, impact: null, sourceAlertId: alert.id }); expect(convert.statusCode, convert.body).toBe(200); expect(convert.json().data.risk).toMatchObject({ probability: null, impact: null, level: null, sourceAlertId: alert.id });
    expect((await send('', { ...draft, probability: null, impact: null, sourceAlertId: alert.id })).statusCode).toBe(409);
  });
  test('unknown rule inputs preserve old alerts and reads never expire snoozes or run evaluation', async () => {
    const w = await workspace(); const fixture = new Database(dbPath);
    const rules = [{ key: 'capacity_overload' as const, name: '个人周容量', status: 'evaluated' as const, message: '显式测试容量', triggered: 1 }];
    applyRiskEvaluation(fixture, 'phase-one', { candidates: [{ rule: 'capacity_overload', objectId: 'chen:2026-09-21', title: 'DEMO 容量测试', evidence: '40 / 32 小时', workstreamId: w.workstreams[0]!.id, taskIds: ['task-006'] }], rules, unknown: [] }, now);
    const triggered = (await workspace()).alerts.find(a => a.rule === 'capacity_overload')!;
    applyRiskEvaluation(fixture, 'phase-one', { candidates: [], rules: [{ ...rules[0]!, status: 'unknown', triggered: 0 }], unknown: [{ rule: 'capacity_overload', objectId: null }] }, now);
    fixture.close(); expect((await workspace()).alerts.find(a => a.id === triggered.id)).toEqual(triggered);
    const response = await send(`/alerts/${triggered.id}/snooze`, { expectedVersion: triggered.version, reason: '待配置真实容量', until: '2026-09-24' }); expect(response.statusCode).toBe(200);
    now = new Date('2026-09-25T01:00:00Z'); const read = await workspace(); expect(read.alerts.find(a => a.id === triggered.id)?.status).toBe('snoozed'); expect(read.lastEvaluatedAt).toBe(w.lastEvaluatedAt);
    await send('/evaluate', {}); expect((await workspace()).alerts.find(a => a.id === triggered.id)?.status).toBe('snoozed');
    expect((await send('/evaluate', {}, 'xu')).statusCode).toBe(403);
  });
  test('successful task writes evaluate immediately; failed sweeps preserve business writes and expose retry warning; timers use system day', async () => {
    const w = await workspace(); const fixture = new Database(dbPath);
    fixture.exec("CREATE TRIGGER fail_evaluation BEFORE UPDATE OF last_evaluated_at ON risk_projects BEGIN SELECT RAISE(ABORT, 'fixture evaluation failure'); END;"); fixture.close();
    const task = w.tasks.find(t => t.ownerId === 'chen' && t.taskKind !== 'summary')!;
    const result = await app.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/comments`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'chen', 'idempotency-key': randomUUID() }, payload: { expectedVersion: task.version, expectedPlanVersion: w.planVersion, text: 'DEMO · 巡检故障不能回滚业务' } }); expect(result.statusCode).toBe(200);
    let current = await workspace(); expect(current.tasks.find(t => t.id === task.id)?.version).toBe(task.version + 1); expect(current.warnings.some(w => w.includes('巡检失败'))).toBe(true);
    expect((await send('/evaluate', {})).statusCode).toBe(503); expect((await workspace()).lastEvaluatedAt).toBe(w.lastEvaluatedAt);
    const repair = new Database(dbPath); repair.exec('DROP TRIGGER fail_evaluation'); repair.close();
    await send('/evaluate', {}); expect((await workspace()).warnings.some(w => w.includes('巡检失败'))).toBe(false);
    const taskDraft = { title: 'DEMO · 逾期应对', description: '', workstreamId: w.workstreams[0]!.id, ownerId: 'chen', parentId: null, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-09-08', end: '2026-09-09', expectedPlanVersion: current.planVersion };
    const created = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: taskDraft }); expect(created.statusCode, created.body).toBe(200);
    expect((await workspace()).alerts.some(a => a.objectId === created.json().data.task.id && a.rule === 'overdue')).toBe(true);
    await app.close(); app = buildApp({ dbPath, clock: () => now, riskIntervalMs: 15 }); await workspace(); now = new Date('2026-09-24T02:00:00Z');
    await new Promise(resolve => setTimeout(resolve, 60)); current = await workspace(); expect(current.lastEvaluatedAt).toBe(now.toISOString());
  });
  test('retains cancelled historical references, permits residual acceptance and validates unlink note types', async () => {
    const w = await workspace(); const taskDraft = { title: 'DEMO · 后续取消的措施', description: '', workstreamId: w.workstreams[0]!.id, ownerId: 'chen', parentId: null, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null, expectedPlanVersion: w.planVersion };
    const headers = { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() };
    const created = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers, payload: taskDraft }); expect(created.statusCode, created.body).toBe(200); const task = created.json().data.task;
    let risk = await create({ taskIds: [task.id] }); const linked = await send(`/${risk.id}/actions`, { expectedVersion: risk.version, taskId: task.id, reason: '关联措施' }, 'zhou'); expect(linked.statusCode).toBe(200); risk = linked.json().data.risk;
    const cancelled = await app.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/transition`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { expectedVersion: task.version, expectedPlanVersion: (await workspace()).planVersion, action: 'cancel', reason: '措施已调整' } }); expect(cancelled.statusCode).toBe(200);
    const updated = await send(`/${risk.id}`, { ...draft, taskIds: [task.id], description: '保留已取消任务作为历史影响证据', expectedVersion: risk.version, reason: '更新说明' }, 'zhou', 'PATCH'); expect(updated.statusCode, updated.body).toBe(200); risk = updated.json().data.risk;
    expect((await send('', { ...draft, taskIds: [task.id] })).statusCode).toBe(422);
    expect((await send(`/${risk.id}/actions`, { expectedVersion: risk.version, taskId: task.id, remove: true, reason: 42 }, 'zhou')).statusCode).toBe(422);
    risk = await transition(risk, 'assess'); risk = await transition(risk, 'mitigate'); risk = await transition(risk, 'monitor'); risk = await transition(risk, 'submit_close', { residualReasons: { [task.id]: '措施取消但接受剩余风险' } }); expect((await transition(risk, 'approve_close', {}, 'zhou')).status).toBe('closed');
  });

  test('accepted risks retain required review dates while unrelated edits preserve overdue history', async () => {
    let risk = await create(); risk = await transition(risk, 'assess'); risk = await transition(risk, 'accept', { reviewDate: '2026-09-24' });
    const update = (reviewDate: string | null) => send(`/${risk.id}`, { ...draft, closeReviewerId: risk.closeReviewerId, reviewDate, expectedVersion: risk.version, reason: '补充风险说明' }, 'zhou', 'PATCH');
    for (const date of [null, '2026-09-23', '2026-09-22']) expect((await update(date)).statusCode).toBe(422);
    now = new Date('2026-09-25T02:00:00Z');
    const preserved = await update('2026-09-24'); expect(preserved.statusCode, preserved.body).toBe(200); risk = preserved.json().data.risk;
    expect((await app.inject(`${prefix}/overview`)).json().data.risks.find((r: { id: string }) => r.id === risk.id).reviewOverdue).toBe(true);
    expect((await update('2026-09-25')).statusCode).toBe(422); expect((await update(null)).statusCode).toBe(422);
    const future = await update('2026-09-26'); expect(future.statusCode, future.body).toBe(200); expect(future.json().data.risk.reviewDate).toBe('2026-09-26');
  });
  test('stable hits refresh latest trigger time without duplicating events or changing alert revision', async () => {
    const w = await workspace(); const alert = w.alerts.find(a => a.rule === 'overdue')!;
    now = new Date(now.getTime() + 60 * 60_000); await send('/evaluate', {});
    const current = await workspace(); const repeated = current.alerts.find(a => a.id === alert.id)!;
    expect(repeated.lastTriggeredAt).toBe(now.toISOString()); expect(repeated.firstTriggeredAt).toBe(alert.firstTriggeredAt);
    expect(repeated.events).toEqual(alert.events); expect(repeated.version).toBe(alert.version); expect(current.version).toBe(w.version);
  });

  test('stable observation survives restart/backup and snooze without rewriting audit snapshots', async()=>{
    const initial=await workspace(),alert=initial.alerts.find(a=>a.rule==='overdue')!;
    const db=new Database(dbPath);const original=db.prepare('SELECT snapshot_json FROM risk_alerts WHERE id=?').get(alert.id);
    now=new Date(now.getTime()+60*60_000);const response=await send('/evaluate',{});expect(response.statusCode,response.body).toBe(200);
    expect(db.prepare('SELECT snapshot_json FROM risk_alerts WHERE id=?').get(alert.id)).toEqual(original);
    const backup=join(directory,'observation-restore.sqlite');await db.backup(backup);db.close();
    await app.close();app=buildApp({dbPath,clock:()=>now});
    expect((await workspace()).alerts.find(a=>a.id===alert.id)).toEqual({...alert,lastTriggeredAt:now.toISOString()});
    await app.close();app=buildApp({dbPath:backup,clock:()=>now});
    expect((await workspace()).alerts.find(a=>a.id===alert.id)).toEqual({...alert,lastTriggeredAt:now.toISOString()});
    const snooze=await send(`/alerts/${alert.id}/snooze`,{expectedVersion:alert.version,reason:'观察后暂缓',until:'2026-09-25'});expect(snooze.statusCode,snooze.body).toBe(200);
    expect((await workspace()).alerts.find(a=>a.id===alert.id)).toMatchObject({status:'snoozed',lastTriggeredAt:now.toISOString(),version:alert.version+1});
  });
  test('failed risk-state commit rolls back the batched observation timestamps',async()=>{
    const initial=await workspace(),db=new Database(dbPath);
    const before=db.prepare('SELECT * FROM risk_alert_observations ORDER BY alert_id').all();
    const snapshots=db.prepare('SELECT * FROM risk_alerts ORDER BY id').all();
    db.exec("CREATE TRIGGER fail_observation_commit BEFORE UPDATE ON risk_projects BEGIN SELECT RAISE(ABORT,'fixture observation failure'); END");
    try {
      const evaluation={candidates:initial.alerts.filter(a=>a.status==='open').map(({rule,objectId,title,evidence,workstreamId,taskIds})=>({rule,objectId,title,evidence,workstreamId,taskIds})),unknown:[],rules:initial.rules};
      expect(()=>applyRiskEvaluation(db,'phase-one',evaluation,new Date(now.getTime()+1000))).toThrow('fixture observation failure');
      expect(db.prepare('SELECT * FROM risk_alert_observations ORDER BY alert_id').all()).toEqual(before);expect(db.prepare('SELECT * FROM risk_alerts ORDER BY id').all()).toEqual(snapshots);
    } finally {db.exec('DROP TRIGGER fail_observation_commit');db.close();}
  });

  test('project administrators manage, submit and review risk closure with default management reviewer and actual audit identity', async () => {
    const fixture = new Database(dbPath); fixture.prepare("UPDATE project_members SET role='project_admin' WHERE id='lin'").run(); fixture.close();
    let risk = await create({ ownerId: 'lin', closeReviewerId: null });
    risk = await transition(risk, 'assess', {}, 'lin'); risk = await transition(risk, 'mitigate', {}, 'lin'); risk = await transition(risk, 'monitor', {}, 'lin');
    risk = await transition(risk, 'submit_close', {}, 'zhou');
    expect(risk.closure?.submittedBy).toBe('zhou'); expect(risk.closeReviewerId).toBe('zhou');
    expect((await send(`/${risk.id}/transition`, { expectedVersion: risk.version, action: 'approve_close', reason: '' }, 'lin')).statusCode).toBe(422);
    risk = await transition(risk, 'approve_close', { reason: '项目管理员核验并说明自审依据' }, 'lin');
    expect(risk.status).toBe('closed'); expect(risk.closure).toMatchObject({ submittedBy: 'zhou', reviewedById: 'lin', selfReview: true });
    expect(risk.closeReviewerId).toBe('zhou');
  });

});
