import { recordActivity } from '../activities/repository.js';
import { activityChanges } from '../activities/hooks.js';
import { readMilestoneRecords } from '../milestones/store.js';
import { readOperationReason } from '../../operation-reasons.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readProjectSnapshot } from '../projects/context.js';
import { captureBusinessJobs } from '../../job-integration.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PersonalCapacity, ProjectMember, SettingsEvent, SettingsOperation, SettingsWorkspace } from '../../../../shared/src/settings.js';
import type { PlanningCalendar } from '../../../../shared/src/planning.js';
import type { ManagedRisk } from '../../../../shared/src/risks.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { validDate } from '../planning/calendar.js';
import { hasTable, readActors, readCapacities, readMembers } from './store.js';

function strict(value: unknown, keys?: string[]): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', '请提供有效设置内容。');
  if (keys) requireValue(Object.keys(value).every(key => keys.includes(key)), 'UNKNOWN_FIELD', '包含不支持的字段，请保留草稿并刷新核对。');
}
function textValue(value: unknown, label: string, max: number) { requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_TEXT', `${label}必填且最多 ${max} 字。`); return value.trim(); }
export function readSettings(db: Database.Database, projectId: string, token: string): SettingsWorkspace {
  const state = db.prepare('SELECT version FROM settings_projects WHERE project_id=?').get(projectId) as { version: number } | undefined;
  if (!state) throw new PlanError(404, 'PROJECT_NOT_FOUND', '未找到此项目。');
  const plan = db.prepare('SELECT version,calendar_json FROM plan_projects WHERE project_id=?').get(projectId) as { version: number; calendar_json: string };
  const snapshot = readProjectSnapshot(db, projectId)!;
  const { id, name, start, end, isDemo } = snapshot.project;
  return { mode: snapshot.mode, project: { isDemo, id, name, start, end }, version: state.version, planVersion: plan.version, writeToken: token, actors: readActors(db, projectId), members: readMembers(db, projectId), capacities: readCapacities(db, projectId), calendar: JSON.parse(plan.calendar_json),
    events: (db.prepare('SELECT snapshot_json FROM settings_events WHERE project_id=? ORDER BY rowid DESC LIMIT 100').all(projectId) as { snapshot_json: string }[]).map(row => JSON.parse(row.snapshot_json)) };
}
const roles: Record<ProjectMember['role'], string> = { manager: '项目负责人', member: '项目成员', project_admin: '项目管理员', viewer: '只读成员' };
const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function exceptionSummary<T>(before: Record<string, T>, after: Record<string, T>, label: (value: T) => string): string {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(date => before[date] !== after[date]);
  return changed.length ? changed.map(date => `${date}：${Object.hasOwn(before, date) ? label(before[date]!) : '按默认规则'} → ${Object.hasOwn(after, date) ? label(after[date]!) : '按默认规则'}`).join('；') : '日期例外不变';
}
function hoursLabel(hours: number | null): string { return hours === null ? '未配置' : `${hours} 小时/日`; }
function calendarValue(value: unknown): PlanningCalendar {
  strict(value, ['weekdays', 'hoursPerDay', 'confirmed', 'exceptions']);
  requireValue(Array.isArray(value.weekdays) && value.weekdays.length > 0 && value.weekdays.length <= 7 && new Set(value.weekdays).size === value.weekdays.length && value.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6), 'INVALID_WEEKDAYS', '每周至少选择一个工作日，且不能重复。');
  requireValue(typeof value.hoursPerDay === 'number' && Number.isFinite(value.hoursPerDay) && value.hoursPerDay > 0 && value.hoursPerDay <= 24, 'INVALID_HOURS', '每天工时须大于 0 且不超过 24。');
  requireValue(typeof value.confirmed === 'boolean', 'INVALID_CALENDAR_CONFIRMATION', '请明确日历是否已确认。');
  strict(value.exceptions); requireValue(Object.keys(value.exceptions).length <= 1000 && Object.entries(value.exceptions).every(([date, workday]) => validDate(date) && typeof workday === 'boolean'), 'INVALID_EXCEPTIONS', '日历例外须为有效日期和工作/休息状态，最多 1000 条。');
  return { weekdays: [...value.weekdays].sort(), hoursPerDay: value.hoursPerDay, confirmed: value.confirmed, exceptions: { ...value.exceptions } as Record<string, boolean> };
}
function capacityValue(value: unknown, workspace: SettingsWorkspace): PersonalCapacity {
  strict(value, ['memberId', 'hoursPerDay', 'exceptions']);
  requireValue(workspace.members.some(member => member.id === value.memberId && member.active), 'INVALID_MEMBER', '请选择当前项目已启用的成员。');
  const hours = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 24;
  requireValue(value.hoursPerDay === null || hours(value.hoursPerDay), 'INVALID_HOURS', '每日容量须为 0–24 小时，未配置时留空。');
  strict(value.exceptions); requireValue(Object.keys(value.exceptions).length <= 1000 && Object.entries(value.exceptions).every(([date, available]) => validDate(date) && hours(available)), 'INVALID_EXCEPTIONS', '个人例外须为有效日期及 0–24 小时，最多 1000 条。');
  return { memberId: String(value.memberId), hoursPerDay: value.hoursPerDay as number | null, exceptions: { ...value.exceptions } as Record<string, number> };
}
function checkResponsibilities(db: Database.Database, projectId: string, before: ProjectMember, after: ProjectMember, members: ProjectMember[]) {
  if (before.active === after.active && before.role === after.role) return;
  if (hasTable(db, 'task_meta')) {
    const tasks = db.prepare('SELECT m.meta_json,h.status,h.title FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.project_id=?').all(projectId) as { meta_json: string; status: string; title: string }[];
    for (const row of tasks) {
      const task = JSON.parse(row.meta_json); if (task.cancelled || task.taskKind === 'summary' || task.isContainer || (row.status === 'done' && task.reviewStatus !== 'submitted')) continue;
      requireValue(task.ownerId !== before.id || (after.active && after.role !== 'viewer'), 'MEMBER_HAS_RESPONSIBILITIES', `成员仍负责未完成任务「${row.title}」，请先移交。`);
      requireValue(!task.requiresReview || task.ownerId !== before.id || task.reviewerId !== before.id || isProjectManager(after.role), 'MEMBER_HAS_RESPONSIBILITIES', `任务「${row.title}」的负责人和指定验收人是同一管理者，请先指定其他验收人再调整角色。`);
      requireValue(!task.requiresReview || task.reviewerId !== before.id || (after.active && after.role !== 'viewer'), 'MEMBER_HAS_RESPONSIBILITIES', `成员仍负责任务「${row.title}」的指定验收，请先移交。`);
    }
  }
  for (const milestone of readMilestoneRecords(db, projectId).filter(item => !['accepted','cancelled'].includes(item.state))) {
    const eligible = after.active && !after.removedAt && after.accountActive !== false && after.role !== 'viewer';
    requireValue(![milestone.ownerId, milestone.reviewerId].includes(before.id) || eligible, 'MEMBER_HAS_RESPONSIBILITIES', `成员仍负责里程碑「${milestone.title}」的交付或验收，请先移交。`);
    requireValue(milestone.ownerId !== before.id || milestone.reviewerId !== before.id || isProjectManager(after.role), 'MEMBER_HAS_RESPONSIBILITIES', `里程碑「${milestone.title}」由同一管理者负责和验收，请先指定其他验收人再调整角色。`);
  }
  if (hasTable(db, 'risk_records')) {
    const candidates = members.map(member => member.id === after.id ? after : member).filter(member => member.active && !member.removedAt && member.accountActive !== false && isProjectManager(member.role));
    const records = db.prepare('SELECT snapshot_json FROM risk_records WHERE project_id=?').all(projectId) as { snapshot_json: string }[];
    for (const row of records) {
      const risk = JSON.parse(row.snapshot_json) as ManagedRisk; if (risk.status === 'closed') continue;
      const owner = candidates.find(member => member.id === risk.ownerId);
      if (risk.ownerId === before.id) requireValue(owner, 'MEMBER_HAS_RESPONSIBILITIES', `成员仍负责未关闭风险「${risk.title}」，请先移交。`);
      // Explicit reviewers must retain eligibility; implicit manager fallback must remain available when its manager changes.
      if (risk.closeReviewerId === before.id || risk.ownerId === before.id || (isProjectManager(before.role) && !risk.closeReviewerId)) {
        const reviewer = candidates.find(member => member.id === risk.closeReviewerId) ?? (!risk.closeReviewerId ? (candidates.find(member => isProjectManager(member.role) && member.id !== risk.ownerId) ?? candidates.find(member => isProjectManager(member.role))) : undefined);
        requireValue(reviewer, 'MEMBER_HAS_RESPONSIBILITIES', `变更会使风险「${risk.title}」失去符合权限要求的关闭复核人，请先移交。`);
      }
    }
  }
  if (hasTable(db, 'workstreams') && before.active && !after.active) {
    const owned = db.prepare('SELECT name FROM workstreams WHERE project_id=? AND owner_id=? AND active=1 ORDER BY position LIMIT 1').get(projectId, before.id) as { name: string } | undefined;
    requireValue(!owned, 'MEMBER_HAS_WORKSTREAMS', `成员仍是启用工作分组「${owned?.name ?? ''}」的协调负责人，请先移交。`);
  }
}
export function writeSettings(db: Database.Database, projectId: string, operation: SettingsOperation, body: unknown, actorId: unknown, key: unknown, now: Date, effectiveManager = false, actorDisplayName?: string): SettingsWorkspace {
  requireValue(['member_create', 'member_update', 'calendar', 'capacity'].includes(operation), 'INVALID_OPERATION', '不支持此设置操作。');
  const field = operation.startsWith('member_') ? 'member' : operation;
  strict(body, ['expectedVersion', 'expectedPlanVersion', 'reason', field]);
  requireValue(typeof key === 'string' && /^[\w:.-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。');
  const hash = createHash('sha256').update(JSON.stringify({ operation, body, actorId })).digest('hex');
  return db.transaction(() => {
    const workspace = readSettings(db, projectId, '');
    const actor = workspace.actors.find(member => member.id === actorId);
    if (!actor || (!isProjectManager(actor.role) && !effectiveManager)) throw new PlanError(403, 'SETTINGS_FORBIDDEN', '成员与设置仅允许当前项目已启用的负责人或管理员修改。');
    const eventActor = actorDisplayName ?? actor.name;
    const receipt = db.prepare('SELECT request_hash,response_json FROM settings_idempotency WHERE project_id=? AND request_key=?').get(projectId, key) as { request_hash: string; response_json: string } | undefined;
    if (receipt) { if (receipt.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请重新核对并确认。'); return JSON.parse(receipt.response_json); }
    requireValue(Number.isInteger(body.expectedVersion) && Number(body.expectedVersion) > 0 && Number.isInteger(body.expectedPlanVersion) && Number(body.expectedPlanVersion) > 0, 'VERSION_REQUIRED', '请提供当前设置和计划版本。');
    if (body.expectedVersion !== workspace.version) throw new PlanError(409, 'SETTINGS_VERSION_CONFLICT', '设置已更新，请保留草稿并读取新版本，重新核对确认。', { latestVersion: workspace.version });
    if (body.expectedPlanVersion !== workspace.planVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '计划已更新，请保留草稿并读取新版本，重新核对确认。', { latestPlanVersion: workspace.planVersion });
    let reason = readOperationReason(body.reason, { domain: 'settings', action: operation }, 1500); let summary: string;
    if (field === 'member') {
      strict(body.member, operation === 'member_create' ? ['name', 'role', 'active'] : ['id', 'name', 'role', 'active']);
      const name = textValue(body.member.name, '成员姓名', 60);
      requireValue(typeof body.member.role === 'string' && ['manager', 'project_admin', 'member', 'viewer'].includes(body.member.role), 'INVALID_ROLE', '请选择有效的项目角色。');
      requireValue(typeof body.member.active === 'boolean', 'INVALID_ACTIVE', '请明确成员启用状态。');
      let member: ProjectMember;
      if (operation === 'member_create') {
        reason = readOperationReason(body.reason, { domain: 'settings', action: operation, role: body.member.role }, 1500);
        requireValue(!workspace.members.some(member => member.name === name), 'DUPLICATE_MEMBER_NAME', '此姓名已存在，请使用可区分的姓名。');
        member = { id: `member-${randomUUID()}`, name, role: body.member.role as ProjectMember['role'], active: body.member.active };
        db.prepare('INSERT INTO project_members (project_id,id,name,role,active) VALUES (?,?,?,?,?)').run(projectId, member.id, name, member.role, Number(member.active));
        db.prepare('INSERT INTO member_capacities VALUES (?,?,?)').run(projectId, member.id, JSON.stringify({ memberId: member.id, hoursPerDay: null, exceptions: {} }));
        summary = `新增成员 ${name}；角色 ${roles[member.role]}；${member.active ? '启用' : '停用'}`;
      } else {
        const memberId = body.member.id;
        const previous = workspace.members.find(member => member.id === memberId);
        requireValue(previous, 'INVALID_MEMBER', '未找到当前项目成员。');
        requireValue(!previous.removedAt, 'MEMBER_REMOVED', '成员已移除，请通过添加成员明确重新加入。');
        requireValue(previous.name === name, 'MEMBER_NAME_IMMUTABLE', '姓名创建后不可修改，以保留历史任务与基线对应关系。');
        reason = readOperationReason(body.reason, { domain: 'settings', action: operation, previousRole: previous.role, role: body.member.role, previousActive: previous.active, active: body.member.active }, 1500);
        member = { ...previous, role: body.member.role as ProjectMember['role'], active: body.member.active };
        if (previous.role === 'manager' && previous.active && (!member.active || member.role !== 'manager')) {
          requireValue(workspace.members.some(other => other.id !== member.id && other.active && !other.removedAt && other.accountActive !== false && other.role === 'manager'), 'LAST_MANAGER_REQUIRED', '项目必须保留至少一名已启用的负责人。');
          requireValue(actor.id !== member.id, 'SELF_DEMOTION_FORBIDDEN', '不能自行降级或停用当前操作者，请由其他项目负责人或管理员处理。');
        }
        requireValue(actor.id !== member.id || (member.active && (member.role === previous.role || (member.role === 'manager' && previous.role !== 'manager') || (member.role === 'project_admin' && !isProjectManager(previous.role)))), 'SELF_DEMOTION_FORBIDDEN', '不能自行变更角色或停用当前操作者。');
        checkResponsibilities(db, projectId, previous, member, workspace.members);
        db.prepare('UPDATE project_members SET role=?,active=? WHERE project_id=? AND id=?').run(member.role, Number(member.active), projectId, member.id);
        summary = `${name}：${roles[previous.role]}/${previous.active ? '启用' : '停用'} → ${roles[member.role]}/${member.active ? '启用' : '停用'}`;
      }
    } else if (operation === 'calendar') {
      const calendar = calendarValue(body.calendar);
      db.prepare('UPDATE plan_projects SET calendar_json=? WHERE project_id=?').run(JSON.stringify(calendar), projectId);
      const history = { id: randomUUID(), action: 'calendar', actor: eventActor, reason: reason || '更新项目工作日历', createdAt: now.toISOString(), affectedCount: 0 };
      db.prepare('INSERT INTO plan_history VALUES (?,?,?,?)').run(history.id, projectId, JSON.stringify(history), history.createdAt);
      summary = `每周工作日：${workspace.calendar.weekdays.map(day => days[day]).join('、')} → ${calendar.weekdays.map(day => days[day]).join('、')}；每天工时：${workspace.calendar.hoursPerDay} → ${calendar.hoursPerDay} 小时；确认状态：${workspace.calendar.confirmed ? '已确认' : '未确认'} → ${calendar.confirmed ? '已确认' : '未确认'}；${exceptionSummary(workspace.calendar.exceptions, calendar.exceptions, value => value ? '工作日' : '休息日')}；计划版本 ${workspace.planVersion} → ${workspace.planVersion + 1}，原任务日期与历史基线保留`;
    } else {
      const capacity = capacityValue(body.capacity, workspace); const previous = workspace.capacities.find(item => item.memberId === capacity.memberId);
      db.prepare('INSERT INTO member_capacities VALUES (?,?,?) ON CONFLICT(project_id,member_id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(projectId, capacity.memberId, JSON.stringify(capacity));
      summary = `${workspace.members.find(member => member.id === capacity.memberId)!.name}容量：${hoursLabel(previous?.hoursPerDay ?? null)} → ${hoursLabel(capacity.hoursPerDay)}；${exceptionSummary(previous?.exceptions ?? {}, capacity.exceptions, value => `${value} 小时`)}；不回填历史实际快照`;
    }
    const event: SettingsEvent = { id: randomUUID(), actor: eventActor, action: operation, reason: reason || summary, createdAt: now.toISOString(), summary };
    db.prepare('INSERT INTO settings_events VALUES (?,?,?)').run(event.id, projectId, JSON.stringify(event));
    db.prepare('UPDATE settings_projects SET version=version+1 WHERE project_id=?').run(projectId);
    db.prepare('UPDATE plan_projects SET version=version+1 WHERE project_id=?').run(projectId);
    const result = readSettings(db, projectId, '');
    if (field === 'member') {
      const selected = operation === 'member_create' ? result.members.find(item => !workspace.members.some(previous => previous.id === item.id)) : result.members.find(item => item.id === (body.member as Record<string,unknown>).id);
      if (selected) {
        const previous = workspace.members.find(item => item.id === selected.id);
        const changes = activityChanges(previous, selected, ['active','role']);
        if (!previous || changes.length) recordActivity(db,{projectId,sourceKey:`settings:${event.id}`,type:previous?'member.update':'member.join',category:'member',actor:{id:actor.id,name:eventActor},occurredAt:now.toISOString(),target:{kind:'member',id:selected.id,name:selected.name},summary:`${previous?'调整成员角色或状态':'成员加入项目'}「${selected.name}」`,changes});
      }
    } else if (operation === 'calendar') {
      const changes = activityChanges(workspace.calendar,result.calendar,['weekdays','hoursPerDay','confirmed','exceptions']);
      if (changes.length) recordActivity(db,{projectId,sourceKey:`settings:${event.id}`,type:'project.calendar',category:'project',actor:{id:actor.id,name:eventActor},occurredAt:now.toISOString(),target:{kind:'project',id:projectId,name:workspace.project.name},summary:'更新项目工作日历',changes});
    }
    captureBusinessJobs(db, projectId, now);
    db.prepare('INSERT INTO settings_idempotency VALUES (?,?,?,?)').run(projectId, key, hash, JSON.stringify(result)); return result;
  })();
}
