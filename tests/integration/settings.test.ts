import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { ProjectMember, SettingsWorkspace } from '../../shared/src/settings.js';
import { openHomepageDatabase } from '../../server/src/db/connection.js';
import { initializePlanning } from '../../server/src/modules/planning/repository.js';
import { initializeTasks, readTasks } from '../../server/src/modules/tasks/repository.js';
import { readMembers, readCapacities } from '../../server/src/modules/settings/store.js';
const prefix = '/api/v1/projects/phase-one';
describe('persistent project settings and dynamic member permissions', () => {
  let app: FastifyInstance; let directory: string; let dbPath: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'goodwork-settings-')); dbPath = join(directory, 'settings.sqlite'); app = buildApp({ dbPath, clock: () => new Date('2026-09-23T02:00:00Z'), snapshotIntervalMs: 0, riskIntervalMs: 0 }); });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function workspace(): Promise<SettingsWorkspace> { const response = await app.inject(`${prefix}/settings`); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
  async function send(operation: string, fields: object, actor = 'zhou', key: string = randomUUID(), overrides: object = {}) { const w = await workspace(); return app.inject({ method: 'POST', url: `${prefix}/settings/${operation}`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': actor, 'idempotency-key': key }, payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: 'DEMO · 核对范围后确认', ...fields, ...overrides } }); }
  async function create(name = 'DEMO 成员甲', role: ProjectMember['role'] = 'member') { const r = await send('member_create', { member: { name, role, active: true } }); expect(r.statusCode, r.body).toBe(200); return (r.json().data as SettingsWorkspace).members.find(m => m.name === name)!; }
  async function update(member: ProjectMember, patch: Partial<ProjectMember>, actor = 'zhou') { return send('member_update', { member: { id: member.id, name: member.name, role: member.role, active: member.active, ...patch } }, actor); }
  test('seeds stable members; read is readonly and legacy standalone initialization is isolated', async () => {
    const w = await workspace(); expect(w.members.map(m => m.id)).toEqual(['zhou', 'chen', 'lin', 'xu']); expect(w.capacities.every(c => c.hoursPerDay === null)).toBe(true); expect(await workspace()).toEqual(w);
    const independent = openHomepageDatabase(':memory:'); initializePlanning(independent); initializeTasks(independent);
    const copied = readMembers(independent, 'phase-one'); copied[0]!.active = false; expect(readTasks(independent, 'phase-one', '').actors).toHaveLength(4); expect(readCapacities(independent, 'phase-one')[0]!.hoursPerDay).toBeNull(); expect(independent.prepare("SELECT name FROM sqlite_master WHERE name='project_members'").get()).toBeUndefined(); independent.close();
    expect((await app.inject('/api/v1/projects/missing/settings')).statusCode).toBe(404);
  });
  test('protects tokens/origins/roles, strict payloads, dates, capacity and versions', async () => {
    const w = await workspace(); const fields = { member: { name: 'DEMO 校验', role: 'member', active: true } };
    expect((await app.inject({ method: 'POST', url: `${prefix}/settings/member_create`, payload: fields })).statusCode).toBe(403);
    for (const actor of ['xu', 'chen', 'lin', 'missing']) expect((await send('member_create', fields, actor)).statusCode).toBe(403);
    expect((await send('member_create', fields, 'zhou', 'bad')).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: `${prefix}/settings/member_create`, headers: { 'x-preview-token': w.writeToken, origin: 'https://evil.example' }, payload: fields })).statusCode).toBe(403);
    for (const extra of [{ member: { ...fields.member, unexpected: 1 } }, { ...fields, capacity: {} }, { ...fields, unexpected: 1 }, { member: { ...fields.member, role: 'admin' } }, { member: { ...fields.member, role: ['manager'] } }, { member: { ...fields.member, active: 'true' } }]) expect((await send('member_create', extra)).statusCode).toBe(422);
    for (const calendar of [{ ...w.calendar, weekdays: [] }, { ...w.calendar, weekdays: [1, 1] }, { ...w.calendar, hoursPerDay: 0 }, { ...w.calendar, exceptions: { '2026-02-30': true } }, { ...w.calendar, exceptions: { '2026-09-01': 1 } }]) expect((await send('calendar', { calendar })).statusCode).toBe(422);
    for (const capacity of [{ memberId: 'missing', hoursPerDay: 8, exceptions: {} }, { memberId: 'chen', hoursPerDay: -1, exceptions: {} }, { memberId: 'chen', hoursPerDay: 25, exceptions: {} }, { memberId: 'chen', hoursPerDay: 8, exceptions: { '2026-02-30': 0 } }]) expect((await send('capacity', { capacity })).statusCode).toBe(422);
    expect((await send('other', fields)).statusCode).toBe(422); expect((await send('member_create', fields, 'zhou', randomUUID(), { expectedVersion: 99 })).statusCode).toBe(409); expect((await send('member_create', fields, 'zhou', randomUUID(), { expectedPlanVersion: 99 })).statusCode).toBe(409); expect(await workspace()).toEqual(w);
  });
  test('member validation uses neutral name guidance and leaves settings unchanged', async () => {
    const before = await workspace();
    const invalid = await update(before.members[0]!, { name: '   ' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error).toMatchObject({ code: 'INVALID_TEXT', message: '成员姓名必填且最多 60 字。' });
    const duplicate = await send('member_create', { member: { name: before.members[0]!.name, role: 'member', active: true } });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json().error).toMatchObject({ code: 'DUPLICATE_MEMBER_NAME', message: '此姓名已存在，请使用可区分的姓名。' });
    expect(await workspace()).toEqual(before);
  });
  test('persists membership, calendar, capacity and replay across restart without duplicate events', async () => {
    const w = await workspace(); const key = randomUUID(); const fields = { member: { name: 'DEMO 新成员', role: 'member', active: true } }; const versions = { expectedVersion: w.version, expectedPlanVersion: w.planVersion };
    const first = await send('member_create', fields, 'zhou', key, versions); expect(first.statusCode, first.body).toBe(200); const member = first.json().data.members.at(-1);
    const capacity = { memberId: member.id, hoursPerDay: 0, exceptions: { '2026-09-24': 3 } }; expect((await send('capacity', { capacity })).statusCode).toBe(200);
    const calendar = { ...w.calendar, confirmed: true, exceptions: { '2026-09-26': true } }; expect((await send('calendar', { calendar })).statusCode).toBe(200);
    const written = await workspace(); expect(written.version).toBe(w.version + 3); expect(written.planVersion).toBe(w.planVersion + 3); expect(written.events).toHaveLength(3); expect(written.events[0]).toMatchObject({ actor: '周亦安', action: 'calendar', reason: 'DEMO · 核对范围后确认' });
    await app.close(); app = buildApp({ dbPath, snapshotIntervalMs: 0, riskIntervalMs: 0 }); const restarted = await workspace(); expect(restarted.capacities.find(c => c.memberId === member.id)).toEqual(capacity); expect(restarted.calendar).toEqual(calendar); expect(restarted.members).toEqual(written.members);
    const replay = await send('member_create', fields, 'zhou', key, versions); expect(replay.statusCode).toBe(200); expect(replay.json().data.members).toEqual(first.json().data.members); expect((await workspace()).events).toHaveLength(3);
    expect((await send('member_create', { member: { ...fields.member, name: '不同请求' } }, 'zhou', key, versions)).statusCode).toBe(409);
    expect((await update(member, { name: '改名' })).json().error.code).toBe('MEMBER_NAME_IMMUTABLE');
    expect((await send('member_create', fields)).json().error.code).toBe('DUPLICATE_MEMBER_NAME');
  });
  test('rolls back calendar, version, audit and idempotency on transaction failure', async () => {
    const w = await workspace(); const fixture = new Database(dbPath); fixture.exec("CREATE TRIGGER reject_settings_event BEFORE INSERT ON settings_events BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;"); fixture.close();
    const key = randomUUID(); const fields = { calendar: { ...w.calendar, confirmed: true } }; const response = await send('calendar', fields, 'zhou', key); expect(response.statusCode).toBe(500); expect(await workspace()).toEqual(w);
    const repaired = new Database(dbPath); expect(repaired.prepare('SELECT count(*) AS n FROM settings_idempotency').get()).toEqual({ n: 0 }); repaired.exec('DROP TRIGGER reject_settings_event'); repaired.close(); expect((await send('calendar', fields, 'zhou', key)).statusCode).toBe(200);
  });
  test('blocks last-manager/self changes and dangling task/review/risk responsibilities', async () => {
    const w = await workspace(); expect((await update(w.members[0]!, { active: false })).json().error.code).toBe('LAST_MANAGER_REQUIRED');
    await create('DEMO 第二负责人', 'manager'); expect((await update(w.members[0]!, { role: 'member' })).json().error.code).toBe('SELF_DEMOTION_FORBIDDEN');
    for (const [id, patch] of [['chen', { active: false }], ['chen', { role: 'viewer' }], ['lin', { role: 'viewer' }], ['xu', { active: false }]] as const) { const response = await update(w.members.find(m => m.id === id)!, patch); expect(response.statusCode, response.body).toBe(422); expect(response.json().error.code).toBe('MEMBER_HAS_RESPONSIBILITIES'); }
  });
  test('ordinary members execute tasks but cannot manage risks; inactive management cannot write/replay', async () => {
    const member = await create(); const w = await workspace(); const taskWorkspace = (await app.inject(`${prefix}/tasks`)).json().data; const headers = { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() };
    const draft = { title: 'DEMO 新成员任务', description: '', workstreamId: taskWorkspace.workstreams[0].id, ownerId: member.id, parentId: null, priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null };
    const taskResponse = await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers, payload: { ...draft, expectedPlanVersion: w.planVersion } }); expect(taskResponse.statusCode, taskResponse.body).toBe(200); const task = taskResponse.json().data.task;
    const comment = await app.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/comments`, headers: { ...headers, 'x-demo-actor': member.id, 'idempotency-key': randomUUID() }, payload: { expectedVersion: task.version, expectedPlanVersion: taskResponse.json().data.planVersion, text: '新成员已接手' } }); expect(comment.statusCode, comment.body).toBe(200);
    const risk = await app.inject({ method: 'POST', url: `${prefix}/risks`, headers: { ...headers, 'x-demo-actor': member.id, 'idempotency-key': randomUUID() }, payload: { title: '新成员风险', description: '', workstreamId: draft.workstreamId, ownerId: member.id, probability: 2, impact: 2, due: '2026-10-01', reviewDate: null, response: '', taskIds: [], closeReviewerId: 'zhou' } }); expect(risk.statusCode, risk.body).toBe(403);
    expect((await app.inject(`${prefix}/risks`)).json().data.responsibilityCandidates.some((candidate: ProjectMember) => candidate.id === member.id)).toBe(false);
    expect((await update(member, { active: false })).statusCode).toBe(422);
    const spare = await create('DEMO 无责任管理成员', 'project_admin'); const riskHeaders = { ...headers, 'x-demo-actor': spare.id, 'idempotency-key': randomUUID() }; expect((await app.inject({ method: 'POST', url: `${prefix}/risks/evaluate`, headers: riskHeaders, payload: {} })).statusCode).toBe(200);
    expect((await update(spare, { active: false })).statusCode).toBe(200); expect((await app.inject(`${prefix}/tasks`)).json().data.actors.some((a: ProjectMember) => a.id === spare.id)).toBe(false); expect((await app.inject(`${prefix}/risks`)).json().data.actors.some((a: ProjectMember) => a.id === spare.id)).toBe(false);
    expect((await app.inject({ method: 'POST', url: `${prefix}/risks/evaluate`, headers: riskHeaders, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers: { ...headers, 'x-demo-actor': spare.id }, payload: { ...draft, expectedPlanVersion: (await workspace()).planVersion } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${prefix}/tasks`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { ...draft, ownerId: spare.id, expectedPlanVersion: (await workspace()).planVersion } })).statusCode).toBe(422);
  });
  test('historical task/risk owners and reviewers may be disabled but reopening must restore eligible responsibilities first', async () => {
    const owner = await create('DEMO 历史责任人'); const reviewer = await create('DEMO 历史验收人', 'member'); const w = await workspace();
    const fixture = new Database(dbPath); const row = fixture.prepare("SELECT meta_json FROM task_meta WHERE task_id='task-006'").get() as { meta_json: string }; const meta = JSON.parse(row.meta_json);
    meta.ownerId = owner.id; meta.reviewerId = reviewer.id; meta.requiresReview = true; meta.reviewStatus = 'accepted';
    fixture.prepare("UPDATE task_meta SET meta_json=? WHERE task_id='task-006'").run(JSON.stringify(meta)); fixture.prepare("UPDATE homepage_tasks SET owner=?,status='done',progress=100 WHERE id='task-006'").run(owner.name);
    const planRow = fixture.prepare("SELECT nodes_json FROM plan_projects WHERE project_id='phase-one'").get() as { nodes_json: string }; const nodes = JSON.parse(planRow.nodes_json); Object.assign(nodes.find((n: { id: string }) => n.id === 'task-006'), { owner: owner.name, status: 'done', progress: 100 }); fixture.prepare("UPDATE plan_projects SET nodes_json=? WHERE project_id='phase-one'").run(JSON.stringify(nodes));
    const riskRow = fixture.prepare("SELECT snapshot_json FROM risk_records WHERE id='risk-01'").get() as { snapshot_json: string }; const risk = JSON.parse(riskRow.snapshot_json); Object.assign(risk, { status: 'closed', ownerId: owner.id, owner: owner.name, closeReviewerId: 'zhou' }); fixture.prepare("UPDATE risk_records SET snapshot_json=? WHERE id='risk-01'").run(JSON.stringify(risk)); fixture.close();
    expect((await update(owner, { active: false })).statusCode).toBe(200); expect((await update(reviewer, { active: false })).statusCode).toBe(200);
    const reopen = async () => app.inject({ method: 'POST', url: `${prefix}/tasks/task-006/transition`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: { expectedVersion: meta.version, expectedPlanVersion: (await workspace()).planVersion, action: 'reopen', reason: 'DEMO 重新检查', progress: 50 } });
    expect((await reopen()).json().error.code).toBe('INACTIVE_TASK_RESPONSIBILITY');
    const riskReopen = await app.inject({ method: 'POST', url: `${prefix}/risks/risk-01/transition`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: { expectedVersion: risk.version, action: 'reopen', reason: 'DEMO 重新检查' } }); expect(riskReopen.json().error.code).toBe('INACTIVE_RISK_RESPONSIBILITY');
    expect((await update(owner, { active: true })).statusCode).toBe(200); expect((await reopen()).json().error.code).toBe('INACTIVE_TASK_RESPONSIBILITY'); expect((await update(reviewer, { active: true })).statusCode).toBe(200); const restored = await reopen(); expect(restored.statusCode, restored.body).toBe(200);
  });
  test('role changes cannot break an explicit independent risk reviewer', async () => {
    const manager = await create('DEMO 风险复核负责人', 'manager'); const w = await workspace();
    const fixture = new Database(dbPath); const row = fixture.prepare("SELECT snapshot_json FROM risk_records WHERE id='risk-02'").get() as { snapshot_json: string }; const risk = JSON.parse(row.snapshot_json); Object.assign(risk, { ownerId: 'chen', closeReviewerId: manager.id }); fixture.prepare("UPDATE risk_records SET snapshot_json=? WHERE id='risk-02'").run(JSON.stringify(risk)); fixture.close();
    expect((await update(manager, { role: 'member' })).json().error.code).toBe('MEMBER_HAS_RESPONSIBILITIES'); expect((await update(manager, { active: false })).json().error.code).toBe('MEMBER_HAS_RESPONSIBILITIES'); expect((await workspace()).version).toBe(w.version);
  });

  test('reopening closed risks never silently replaces an explicitly assigned disabled reviewer', async () => {
    const reviewer = await create('DEMO 历史风险复核人', 'manager'); const w = await workspace();
    const fixture = new Database(dbPath); const row = fixture.prepare("SELECT snapshot_json FROM risk_records WHERE id='risk-02'").get() as { snapshot_json: string }; const risk = JSON.parse(row.snapshot_json); Object.assign(risk, { status: 'closed', ownerId: 'zhou', owner: '周亦安', closeReviewerId: reviewer.id }); fixture.prepare("UPDATE risk_records SET snapshot_json=? WHERE id='risk-02'").run(JSON.stringify(risk)); fixture.close();
    expect((await update(reviewer, { active: false })).statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: `${prefix}/risks/risk-02/transition`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': randomUUID() }, payload: { expectedVersion: risk.version, action: 'reopen', reason: 'DEMO 重新检查' } });
    expect(response.statusCode, response.body).toBe(422); expect(response.json().error.code).toBe('INACTIVE_RISK_RESPONSIBILITY');
    const after = (await app.inject(`${prefix}/risks`)).json().data.risks.find((item: { id: string }) => item.id === risk.id); expect(after).toMatchObject({ status: 'closed', closeReviewerId: reviewer.id, version: risk.version });
  });

  test('management self-review assignments must be handed off before downgrade, including pending review with a stored done status', async () => {
    const manager = await create('DEMO 自审管理者', 'project_admin');
    const fixture = new Database(dbPath);
    const meta = JSON.parse((fixture.prepare("SELECT meta_json FROM task_meta WHERE task_id='task-006'").get() as { meta_json: string }).meta_json);
    Object.assign(meta, { ownerId: manager.id, reviewerId: manager.id, requiresReview: true, reviewStatus: 'submitted' });
    fixture.prepare("UPDATE task_meta SET meta_json=? WHERE task_id='task-006'").run(JSON.stringify(meta));
    fixture.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id='task-006'").run();
    expect((await update(manager, { role: 'member' })).json().error.code).toBe('MEMBER_HAS_RESPONSIBILITIES');
    expect((await update(manager, { active: false })).json().error.code).toBe('MEMBER_HAS_RESPONSIBILITIES');
    meta.reviewerId = 'lin'; fixture.prepare("UPDATE task_meta SET meta_json=? WHERE task_id='task-006'").run(JSON.stringify(meta));
    expect((await update(manager, { role: 'member' })).statusCode).toBe(200);
    fixture.close();
  });

});
