import { isExistingDatabase } from '../../db/lifecycle.js';
import { recordActivity } from '../activities/repository.js';
import { activityChanges } from '../activities/hooks.js';
import { readMilestoneRecords } from '../milestones/store.js';
import { readOperationReason } from '../../operation-reasons.js';
import { isProjectManager, projectRoleLabels } from '../../../../shared/src/permissions.js';
import { projectIsDemo, projectSourceLabel } from './context.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuthUser } from '../../../../shared/src/auth.js';
import type { MembershipCreate, MembershipWorkspace, MembershipRemovalPreview, ProjectCreate, ProjectDirectory, ProjectInfo, ProjectUpdate } from '../../../../shared/src/projects.js';
import type { PlanNode } from '../../../../shared/src/planning.js';
import type { ProjectMember, SettingsEvent } from '../../../../shared/src/settings.js';
import { captureBusinessJobs } from '../../job-integration.js';
import { ensureProjectSchedules } from '../../jobs/runner.js';
import { projectsForUser, type UserRow } from '../auth/store.js';
import { defaultCalendar, validDate } from '../planning/calendar.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { hasTable, readMembers } from '../settings/store.js';
import { shanghaiDate } from '../analytics/dates.js';
import { initializeProjectWorkstream } from '../workstreams/repository.js';

type ReceiptRow = { request_hash: string; response_json: string };
const roles: ProjectMember['role'][] = ['manager', 'project_admin', 'member', 'viewer'];

export function initializeProjects(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS project_events (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES homepage_projects(id), actor_id TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id,created_at);
  CREATE TABLE IF NOT EXISTS project_idempotency (
    actor_id TEXT NOT NULL, scope TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK(json_valid(response_json)), PRIMARY KEY(actor_id,scope,request_key)
  );`);
}

function strict(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(Boolean(value) && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY', '请求内容无效，请核对后重试。');
  const actual = Object.keys(value as object);
  requireValue(keys.filter(key => key !== 'reason').every(key => actual.includes(key)) && actual.every(key => keys.includes(key)), 'INVALID_BODY', '请求字段不完整或包含不支持的内容。');
}
function textValue(value: unknown, label: string, max: number): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_TEXT', `${label}必填且最多 ${max} 字。`);
  return value.trim();
}
function version(value: unknown, code: string) {
  requireValue(Number.isSafeInteger(value) && Number(value) > 0, code, '请刷新项目资料后重试。');
}
function keyValue(value: unknown): string {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(value), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。');
  return value;
}
function createInput(value: unknown): ProjectCreate {
  strict(value, ['name', 'goal', 'start', 'end']);
  const input = { name: textValue(value.name, '项目名称', 120), goal: textValue(value.goal, '项目目标', 2000), start: value.start, end: value.end };
  requireValue(validDate(input.start) && validDate(input.end) && input.start <= input.end, 'INVALID_PROJECT_DATES', '请选择真实有效的项目起止日期，且开始日期不能晚于结束日期。');
  return input as ProjectCreate;
}
function updateInput(value: unknown): ProjectUpdate & { reason: string } {
  strict(value, ['expectedVersion', 'expectedPlanVersion', 'name', 'goal', 'start', 'end', 'reason']);
  version(value.expectedVersion, 'PROJECT_VERSION_REQUIRED');
  version(value.expectedPlanVersion, 'PLAN_VERSION_REQUIRED');
  const input = createInput({ name: value.name, goal: value.goal, start: value.start, end: value.end });
  return { ...input, expectedVersion: Number(value.expectedVersion), expectedPlanVersion: Number(value.expectedPlanVersion), reason: readOperationReason(value.reason, { domain: 'project', action: 'update' }, 500) };
}
function receipt(db: Database.Database, actorId: string, scope: string, key: string, input: unknown) {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const previous = db.prepare('SELECT request_hash,response_json FROM project_idempotency WHERE actor_id=? AND scope=? AND request_key=?').get(actorId, scope, key) as ReceiptRow | undefined;
  if (previous && previous.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请重新核对。');
  return {
    previous: previous ? JSON.parse(previous.response_json) : undefined,
    save: (response: unknown) => db.prepare('INSERT INTO project_idempotency VALUES(?,?,?,?,?)').run(actorId, scope, key, hash, JSON.stringify(response)),
  };
}
function snapshotRow(db: Database.Database, projectId: string) {
  const row = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(projectId) as { snapshot_json: string } | undefined;
  if (!row) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  return JSON.parse(row.snapshot_json);
}
function projectInfo(db: Database.Database, user: AuthUser, projectId: string): ProjectInfo {
  const access = projectsForUser(db, user).find(project => project.id === projectId);
  if (!access) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  const snapshot = snapshotRow(db, projectId);
  const state = db.prepare('SELECT version FROM settings_projects WHERE project_id=?').get(projectId) as { version: number } | undefined;
  if (!state) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  return { id: projectId, name: snapshot.project.name, goal: snapshot.project.description, start: snapshot.project.start, end: snapshot.project.end, version: state.version,
    memberId: access.memberId, role: access.role, isDemo: projectIsDemo(snapshot.project, projectId) };
}
export function readProjectDirectory(db: Database.Database, user: AuthUser): ProjectDirectory {
  return { projects: projectsForUser(db, user).map(project => projectInfo(db, user, project.id)), canCreate: user.systemRole === 'admin' || user.canCreateProjects };
}
export function readProject(db: Database.Database, user: AuthUser, projectId: string): ProjectInfo { return projectInfo(db, user, projectId); }

function projectEvent(db: Database.Database, projectId: string, user: AuthUser, action: string, reason: string, snapshot: unknown, now: Date) {
  db.prepare('INSERT INTO project_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), projectId, user.id, action, reason, JSON.stringify(snapshot), now.toISOString());
}
function settingsEvent(db: Database.Database, projectId: string, user: AuthUser, action: string, reason: string, summary: string, now: Date) {
  const event: SettingsEvent = { id: randomUUID(), actor: user.name, action, reason, summary, createdAt: now.toISOString() };
  db.prepare('INSERT INTO settings_events VALUES(?,?,?)').run(event.id, projectId, JSON.stringify(event));
}

export function createProject(db: Database.Database, user: AuthUser, body: unknown, requestKey: unknown, now: Date): ProjectInfo {
  if (user.systemRole !== 'admin' && !user.canCreateProjects) throw new PlanError(403, 'PROJECT_CREATE_FORBIDDEN', '当前账号没有创建项目权限。');
  const input = createInput(body);
  const key = keyValue(requestKey);
  return db.transaction(() => {
    const replay = receipt(db, user.id, 'create', key, input);
    if (replay.previous) return replay.previous as ProjectInfo;
    const id = `p_${randomBytes(18).toString('base64url')}`;
    const group: PlanNode = { id: 'group-general', parentId: null, workstreamId: 'general', wbs: '1', kind: 'group', title: '通用工作', description: '项目默认工作分组', owner: user.name, color: 'blue', status: 'todo', start: null, end: null, durationDays: null, effortHours: null, progress: 0, blocked: false };
    const snapshot = { mode: 'standard', project: { id, name: input.name, description: input.goal, status: '规划中', start: input.start, end: input.end, asOf: shanghaiDate(now), sourceLabel: projectSourceLabel(false), isDemo: false },
      workstreams: [{ id: 'general', name: '通用工作', description: '项目默认工作分组', color: 'blue', start: input.start, end: input.end, owner: user.name, icon: 'layers' }], tasks: [], milestones: [], risks: [], activities: [] };
    db.prepare('INSERT INTO homepage_projects(id,snapshot_json) VALUES(?,?)').run(id, JSON.stringify(snapshot));
    db.prepare('INSERT INTO plan_projects(project_id,version,nodes_json,dependencies_json,calendar_json) VALUES(?,1,?,?,?)').run(id, JSON.stringify([group]), '[]', JSON.stringify(defaultCalendar));
    db.prepare('INSERT INTO settings_projects(project_id,version) VALUES(?,1)').run(id);
    db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES(?,?,?,?,?)').run(id, user.id, user.name, 'manager', 1);
    db.prepare('INSERT INTO member_capacities VALUES(?,?,?)').run(id, user.id, JSON.stringify({ memberId: user.id, hoursPerDay: null, exceptions: {} }));
    db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run(id, user.id, user.id);
    initializeProjectWorkstream(db, id, user.id);
    db.prepare("INSERT INTO risk_projects VALUES(?,1,'[]',NULL,NULL)").run(id);
    ensureProjectSchedules(db, id, now);
    projectEvent(db, id, user, 'project_create', '创建空白项目', { name: input.name, start: input.start, end: input.end }, now);
    recordActivity(db,{projectId:id,sourceKey:`project:create:${key}`,type:'project.create',category:'project',actor:{id:user.id,name:user.name},occurredAt:now.toISOString(),target:{kind:'project',id,name:input.name},summary:`创建项目「${input.name}」`,changes:activityChanges(undefined,{goal:input.goal,start:input.start,end:input.end},['goal','start','end'])});
    const result = projectInfo(db, user, id);
    replay.save(result);
    return result;
  })();
}

export function updateProject(db: Database.Database, user: AuthUser, projectId: string, body: unknown, requestKey: unknown, now: Date): ProjectInfo {
  const access = projectsForUser(db, user).find(project => project.id === projectId);
  if (!access) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  if (user.systemRole !== 'admin' && !isProjectManager(access.role)) throw new PlanError(403, 'PROJECT_UPDATE_FORBIDDEN', '仅项目负责人或管理员可以修改项目资料。');
  const input = updateInput(body);
  const key = keyValue(requestKey);
  return db.transaction(() => {
    const replay = receipt(db, user.id, `project:${projectId}:update`, key, input);
    if (replay.previous) return replay.previous as ProjectInfo;
    const state = db.prepare('SELECT version FROM settings_projects WHERE project_id=?').get(projectId) as { version: number };
    const plan = db.prepare('SELECT version,nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as { version: number; nodes_json: string };
    if (state.version !== input.expectedVersion) throw new PlanError(409, 'PROJECT_VERSION_CONFLICT', '项目资料已更新，请刷新后重新核对。', { latestVersion: state.version });
    if (plan.version !== input.expectedPlanVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '项目计划已更新，请刷新后重新核对。', { latestPlanVersion: plan.version });
    const scheduled = (JSON.parse(plan.nodes_json) as PlanNode[]).filter(node => node.kind !== 'group' && node.start && node.end);
    requireValue(!scheduled.some(node => node.start! < input.start || node.end! > input.end), 'PROJECT_DATE_CONFLICT', '新项目周期会挤掉已排期任务或里程碑，请先调整任务日期。');
    const snapshot = snapshotRow(db, projectId);
    const activityBefore = { ...snapshot.project };
    Object.assign(snapshot.project, { name: input.name, description: input.goal, start: input.start, end: input.end });
    db.prepare('UPDATE homepage_projects SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), projectId);
    db.prepare('UPDATE settings_projects SET version=version+1 WHERE project_id=?').run(projectId);
    db.prepare('UPDATE plan_projects SET version=version+1 WHERE project_id=?').run(projectId);
    const summary = `项目资料已更新；周期 ${input.start} 至 ${input.end}；历史基线保持不变`;
    settingsEvent(db, projectId, user, 'project_update', input.reason || summary, summary, now);
    projectEvent(db, projectId, user, 'project_update', input.reason || summary, { name: input.name, goal: input.goal, start: input.start, end: input.end }, now);
    const changes = activityChanges(activityBefore,snapshot.project,['description','start','end']);
    if(changes.length) recordActivity(db,{projectId,sourceKey:`project:update:${user.id}:${key}`,type:'project.update',category:'project',actor:{id:user.id,name:user.name},occurredAt:now.toISOString(),target:{kind:'project',id:projectId,name:input.name},summary:'调整项目目标或周期',changes});
    captureBusinessJobs(db, projectId, now);
    const result = projectInfo(db, user, projectId);
    replay.save(result);
    return result;
  })();
}

function membershipInput(value: unknown): MembershipCreate & { reason: string } {
  requireValue(Boolean(value) && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY', '请求内容无效，请核对后重试。');
  const keys = ['expectedVersion', 'expectedPlanVersion', 'userId', 'role', 'reason', ...(Object.hasOwn(value as object, 'legacyMemberId') ? ['legacyMemberId'] : [])];
  strict(value, keys);
  version(value.expectedVersion, 'PROJECT_VERSION_REQUIRED');
  version(value.expectedPlanVersion, 'PLAN_VERSION_REQUIRED');
  requireValue(typeof value.userId === 'string' && value.userId.length > 0 && value.userId.length <= 100, 'INVALID_USER', '请选择有效账号。');
  requireValue(typeof value.role === 'string' && roles.includes(value.role as ProjectMember['role']), 'INVALID_ROLE', '请选择有效的项目角色。');
  if (Object.hasOwn(value, 'legacyMemberId')) requireValue(typeof value.legacyMemberId === 'string' && value.legacyMemberId.length > 0 && value.legacyMemberId.length <= 100, 'INVALID_MEMBER', '请选择有效的旧成员。');
  return { expectedVersion: Number(value.expectedVersion), expectedPlanVersion: Number(value.expectedPlanVersion), userId: value.userId, role: value.role as ProjectMember['role'], ...(value.legacyMemberId ? { legacyMemberId: value.legacyMemberId as string } : {}), reason: readOperationReason(value.reason, { domain: 'membership', action: 'add', role: String(value.role), legacy: Boolean(value.legacyMemberId) }, 500) };
}
function canManage(db: Database.Database, user: AuthUser, projectId: string): boolean {
  return user.systemRole === 'admin' || projectsForUser(db, user).some(project => project.id === projectId && isProjectManager(project.role));
}
export function readMemberships(db: Database.Database, user: AuthUser, projectId: string): MembershipWorkspace {
  if (!projectsForUser(db, user).some(project => project.id === projectId)) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  const state = db.prepare('SELECT version FROM settings_projects WHERE project_id=?').get(projectId) as { version: number };
  const plan = db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get(projectId) as { version: number };
  const manageable = canManage(db, user, projectId);
  const accounts = manageable ? db.prepare(`SELECT id,username,name FROM auth_users WHERE active=1
    AND id NOT IN (SELECT l.user_id FROM project_user_links l JOIN project_members m ON m.project_id=l.project_id AND m.id=l.member_id WHERE l.project_id=? AND m.removed_at IS NULL) ORDER BY name,username`).all(projectId) as MembershipWorkspace['accounts'] : [];
  return { projectId, version: state.version, planVersion: plan.version, members: readMembers(db, projectId), accounts, canManage: manageable, canLinkLegacy: user.systemRole === 'admin' };
}
export function addMembership(db: Database.Database, user: AuthUser, projectId: string, body: unknown, requestKey: unknown, now: Date): MembershipWorkspace {
  if (!projectsForUser(db, user).some(project => project.id === projectId)) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  if (!canManage(db, user, projectId)) throw new PlanError(403, 'MEMBERSHIP_FORBIDDEN', '仅项目负责人或管理员可以添加项目成员。');
  const input = membershipInput(body);
  if (input.legacyMemberId && user.systemRole !== 'admin') throw new PlanError(403, 'LEGACY_LINK_ADMIN_REQUIRED', '只有系统管理员可以明确关联旧成员。');
  const key = keyValue(requestKey);
  return db.transaction(() => {
    const replay = receipt(db, user.id, `project:${projectId}:membership`, key, input);
    if (replay.previous) return replay.previous as MembershipWorkspace;
    const workspace = readMemberships(db, user, projectId);
    if (workspace.version !== input.expectedVersion) throw new PlanError(409, 'PROJECT_VERSION_CONFLICT', '成员资料已更新，请刷新后重新核对。', { latestVersion: workspace.version });
    if (workspace.planVersion !== input.expectedPlanVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '项目计划已更新，请刷新后重新核对。', { latestPlanVersion: workspace.planVersion });
    const account = db.prepare('SELECT * FROM auth_users WHERE id=?').get(input.userId) as UserRow | undefined;
    requireValue(account, 'INVALID_USER', '账号不存在，请刷新候选账号。');
    requireValue(Boolean(account.active), 'ACCOUNT_INACTIVE', '账号已停用，暂不能加入项目。');
    const existing = workspace.members.find(member => member.userId === account.id);
    if (existing && !existing.removedAt) throw new PlanError(409, 'ACCOUNT_ALREADY_LINKED', '此账号已经关联当前项目成员。');
    let memberId: string;
    let role = input.role;
    if (existing?.removedAt) {
      requireValue(!input.legacyMemberId, 'INVALID_MEMBER', '重新加入请保留原账号关联，不要选择其他旧成员。');
      memberId = existing.id;
      db.prepare('UPDATE project_members SET active=1,removed_at=NULL,role=? WHERE project_id=? AND id=?').run(role, projectId, memberId);
    } else if (input.legacyMemberId) {
      const legacy = workspace.members.find(member => member.id === input.legacyMemberId);
      requireValue(legacy, 'INVALID_MEMBER', '旧成员不存在，请刷新后重新选择。');
      requireValue(!legacy.removedAt, 'MEMBER_REMOVED', '已移除成员不能通过关联旧成员恢复。');
      requireValue(!legacy.userId, 'MEMBER_ALREADY_LINKED', '此旧成员已经关联登录账号。');
      requireValue(legacy.role === input.role, 'LEGACY_ROLE_MISMATCH', '关联旧成员必须保留其原项目角色，请按当前角色重新确认。');
      memberId = legacy.id;
      role = legacy.role;
    } else {
      const sameName = workspace.members.find(member => member.name === account.name);
      if (sameName?.userId) throw new PlanError(409, 'ACCOUNT_NAME_CONFLICT', '项目中已有同名成员且已关联其他账号；请先把待加入账号的显示姓名改为可区分姓名或别名后重试。');
      requireValue(!sameName, 'LEGACY_MEMBER_MATCH_REQUIRED', '项目中已有未关联的同名成员；请由系统管理员明确选择是否关联该旧成员。');
      memberId = `member-${randomUUID()}`;
      db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES(?,?,?,?,1)').run(projectId, memberId, account.name, role);
      db.prepare('INSERT INTO member_capacities VALUES(?,?,?)').run(projectId, memberId, JSON.stringify({ memberId, hoursPerDay: null, exceptions: {} }));
    }
    if (!existing) db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run(projectId, memberId, account.id);
    db.prepare('UPDATE settings_projects SET version=version+1 WHERE project_id=?').run(projectId);
    db.prepare('UPDATE plan_projects SET version=version+1 WHERE project_id=?').run(projectId);
    const summary = input.legacyMemberId ? `账号 ${account.username} 已明确关联旧成员 ${memberId}，保留角色 ${projectRoleLabels[role]}` : `账号 ${account.username} 已${existing?.removedAt ? '重新' : ''}加入项目，角色 ${projectRoleLabels[role]}`;
    settingsEvent(db, projectId, user, 'membership_add', input.reason || summary, summary, now);
    projectEvent(db, projectId, user, 'membership_add', input.reason || summary, { userId: account.id, memberId, role, legacy: Boolean(input.legacyMemberId) }, now);
    recordActivity(db,{projectId,sourceKey:`member:join:${user.id}:${key}`,type:'member.join',category:'member',actor:{id:user.id,name:user.name},occurredAt:now.toISOString(),target:{kind:'member',id:memberId,name:account.name},summary:`${input.legacyMemberId?'关联项目成员':'成员加入项目'}「${account.name}」`,changes:activityChanges(existing,{active:true,role},['active','role'])});
    captureBusinessJobs(db, projectId, now);
    const result = readMemberships(db, user, projectId);
    replay.save(result);
    return result;
  })();
}

export function previewMembershipRemoval(db: Database.Database, user: AuthUser, projectId: string, memberId: string): MembershipRemovalPreview {
  const workspace = readMemberships(db, user, projectId);
  if (!workspace.canManage) throw new PlanError(403, 'MEMBERSHIP_FORBIDDEN', '仅项目负责人或管理员可以移除成员。');
  const member = workspace.members.find(item => item.id === memberId);
  if (!member) throw new PlanError(404, 'MEMBER_NOT_FOUND', '未找到此项目成员。');
  const blockers: MembershipRemovalPreview['blockers'] = [];
  const add = (kind: MembershipRemovalPreview['blockers'][number]['kind'], id: string, title: string, message: string) => blockers.push({ kind, id, title, message });
  const current = projectsForUser(db, user).find(project => project.id === projectId);
  if (member.removedAt) add('protection', memberId, member.name, '成员已经移除。');
  if (current?.memberId === memberId || member.userId === user.id) add('protection', memberId, member.name, '不能移除自己，请由其他管理者处理。');
  if (member.role === 'manager' && !workspace.members.some(other => other.id !== memberId && other.role === 'manager' && other.active && !other.removedAt && other.accountActive !== false)) add('protection', memberId, member.name, '必须保留至少一名有效项目负责人。');
  if (hasTable(db, 'task_meta')) for (const row of db.prepare('SELECT m.task_id,m.meta_json,h.title,h.status FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id WHERE m.project_id=?').all(projectId) as { task_id: string; meta_json: string; title: string; status: string }[]) {
    const task = JSON.parse(row.meta_json);
    if (task.cancelled || task.taskKind === 'summary' || task.isContainer || (row.status === 'done' && task.reviewStatus !== 'submitted')) continue;
    if (task.ownerId === memberId) add('task', row.task_id, row.title, '未完成任务仍由此成员负责，请先移交或结束任务。');
    if (task.requiresReview && task.reviewerId === memberId) add('review', row.task_id, row.title, task.reviewStatus === 'submitted' ? '有待验收成果，请由管理者先退回，再修改验收人。' : '任务仍指定此成员验收，请先移交验收职责。');
  }
  for (const milestone of readMilestoneRecords(db, projectId)) {
    if (!['accepted','cancelled'].includes(milestone.state) && [milestone.ownerId,milestone.reviewerId].includes(memberId)) add('milestone', milestone.id, milestone.title, '此成员仍负责里程碑交付或指定验收，请先移交。');
  }
  if (hasTable(db, 'risk_records')) for (const row of db.prepare('SELECT snapshot_json FROM risk_records WHERE project_id=?').all(projectId) as { snapshot_json: string }[]) {
    const risk = JSON.parse(row.snapshot_json);
    if (risk.status !== 'closed' && (risk.ownerId === memberId || risk.closeReviewerId === memberId)) add('risk', risk.id, risk.title, '此成员仍负责未关闭风险或关闭复核，请先移交。');
  }
  if (hasTable(db, 'workstreams')) for (const group of db.prepare('SELECT id,name FROM workstreams WHERE project_id=? AND owner_id=? AND active=1').all(projectId, memberId) as { id: string; name: string }[]) add('workstream', group.id, group.name, '此成员仍是启用分组的负责人，请先移交或停用分组。');
  return { projectId, memberId, version: workspace.version, planVersion: workspace.planVersion, canRemove: blockers.length === 0, blockers };
}

export function removeMembership(db: Database.Database, user: AuthUser, projectId: string, memberId: string, body: unknown, requestKey: unknown, now: Date): MembershipWorkspace {
  const workspace = readMemberships(db, user, projectId);
  if (!workspace.canManage) throw new PlanError(403, 'MEMBERSHIP_FORBIDDEN', '仅项目负责人或管理员可以移除成员。');
  strict(body, ['expectedVersion', 'expectedPlanVersion', 'reason']);
  version(body.expectedVersion, 'PROJECT_VERSION_REQUIRED'); version(body.expectedPlanVersion, 'PLAN_VERSION_REQUIRED');
  const reason = readOperationReason(body.reason, { domain: 'membership', action: 'remove' }, 500); const key = keyValue(requestKey);
  return db.transaction(() => {
    const replay = receipt(db, user.id, `project:${projectId}:remove:${memberId}`, key, body);
    if (replay.previous) return replay.previous as MembershipWorkspace;
    const preview = previewMembershipRemoval(db, user, projectId, memberId);
    if (preview.version !== body.expectedVersion) throw new PlanError(409, 'PROJECT_VERSION_CONFLICT', '成员资料已更新，请重新预览。');
    if (preview.planVersion !== body.expectedPlanVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '任务或计划已更新，请重新预览。');
    if (!preview.canRemove) throw new PlanError(409, 'MEMBER_REMOVAL_BLOCKED', '成员仍有职责或受到保护，请先处理阻塞项。', { blockers: preview.blockers });
    db.prepare('UPDATE project_members SET active=0,removed_at=? WHERE project_id=? AND id=?').run(now.toISOString(), projectId, memberId);
    db.prepare('UPDATE settings_projects SET version=version+1 WHERE project_id=?').run(projectId);
    db.prepare('UPDATE plan_projects SET version=version+1 WHERE project_id=?').run(projectId);
    settingsEvent(db, projectId, user, 'membership_remove', reason, `成员 ${workspace.members.find(member => member.id === memberId)?.name ?? memberId}（${memberId}）已移除；账号关联、容量和历史记录保留`, now);
    projectEvent(db, projectId, user, 'membership_remove', reason, { memberId, removedAt: now.toISOString() }, now);
    const memberName = workspace.members.find(member => member.id === memberId)?.name ?? '历史成员';
    recordActivity(db,{projectId,sourceKey:`member:remove:${user.id}:${key}`,type:'member.remove',category:'member',actor:{id:user.id,name:user.name},occurredAt:now.toISOString(),target:{kind:'member',id:memberId,name:memberName},summary:`成员退出项目「${memberName}」`,changes:[{field:'removed',before:false,after:true}]});
    captureBusinessJobs(db, projectId, now);
    const result = readMemberships(db, user, projectId); replay.save(result); return result;
  })();
}
