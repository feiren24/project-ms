import { managementCapabilities, memberCanViewManagement } from '../auth/project-access.js';
import { collaborationPlanActions, managementEvent } from '../activities/privacy.js';
import { activityVersion } from '../activities/repository.js';
import { isExistingDatabase } from '../../db/lifecycle.js';
import { taskIsDeleted } from '../tasks/recycle-store.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readProjectSnapshot } from '../projects/context.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NotificationWorkspace, ProjectNotification, ProjectRevision } from '../../../../shared/src/notifications.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { hasTable, readActors } from '../settings/store.js';
import { listJobs, retryFailedJob } from '../../jobs/store.js';
import type { NotificationPayload } from './events.js';

export function initializeNotifications(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES homepage_projects(id), recipient_id TEXT NOT NULL,
    event_key TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), read_at TEXT,
    UNIQUE(project_id,event_key,recipient_id));
    CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications(project_id,recipient_id,read_at);
    CREATE TABLE IF NOT EXISTS notification_seen(project_id TEXT NOT NULL,event_key TEXT NOT NULL,PRIMARY KEY(project_id,event_key));
    CREATE TABLE IF NOT EXISTS notification_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_idempotency(project_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(project_id,request_key));
    CREATE TABLE IF NOT EXISTS notification_job_retries(project_id TEXT NOT NULL,job_id TEXT NOT NULL,actor_id TEXT NOT NULL,retried_at TEXT NOT NULL,request_key TEXT NOT NULL,PRIMARY KEY(project_id,request_key));`);
}
function context(db: Database.Database, projectId: string, actorId: unknown) {
  const row = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(projectId) as { snapshot_json: string } | undefined;
  if (!row) throw new PlanError(404, 'PROJECT_NOT_FOUND', '未找到此项目。');
  const actors = readActors(db, projectId).map(({ id, name, role, assignable }) => ({ id, name, role, assignable: assignable !== false }));
  const actor = actors.find(item => item.id === actorId);
  if (!actor) throw new PlanError(403, 'NOTIFICATIONS_FORBIDDEN', '请切换为当前项目已启用的成员身份。');
  const { id, name, isDemo } = readProjectSnapshot(db, projectId)!.project;
  return { actor, actors, project: { id, name, isDemo } };
}
export function deliverNotification(db: Database.Database, projectId: string, payload: unknown, now: Date): { delivered: boolean; reason?: string } {
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'INVALID_NOTIFICATION', '通知内容不完整。');
  const item = payload as NotificationPayload;
  requireValue(typeof item.recipientId === 'string' && typeof item.eventKey === 'string' && typeof item.kind === 'string' && typeof item.title === 'string' && typeof item.message === 'string' && item.target && ['task', 'milestone', 'risk', 'plan', 'settings', 'workstreams'].includes(item.target.kind), 'INVALID_NOTIFICATION', '通知内容不完整。');
  if (!readActors(db, projectId).some(actor => actor.id === item.recipientId)) return { delivered: false, reason: '接收成员已停用或离开项目，已跳过站内通知。' };
  if (managementEvent(item.kind, item.target.kind) && !memberCanViewManagement(db, projectId, item.recipientId)) return { delivered: false, reason: '接收成员当前无权查看此管理信息，已跳过站内通知。' };
  if(item.target.kind==='task' && item.target.id && !['task.delete','task.restore'].includes(item.kind) && hasTable(db,'task_recycle') && taskIsDeleted(db,projectId,item.target.id))return {delivered:false,reason:'任务已删除，停止发送待处理通知和提醒。'};
  const notification: ProjectNotification = { id: `notification-${randomUUID()}`, recipientId: item.recipientId, kind: item.kind, title: item.title, message: item.message, createdAt: now.toISOString(), readAt: null, target: item.target };
  db.prepare('INSERT OR IGNORE INTO notifications(id,project_id,recipient_id,event_key,snapshot_json,read_at) VALUES (?,?,?,?,?,NULL)').run(notification.id, projectId, item.recipientId, item.eventKey, JSON.stringify({ ...notification, ...(item.formatVersion === 1 ? { formatVersion: 1 } : {}) }));
  return { delivered: true };
}
function visibleNotifications(db: Database.Database, projectId: string, actorId: string, isDemo: boolean, canViewManagement: boolean): ProjectNotification[] {
  return (db.prepare('SELECT snapshot_json,read_at,event_key FROM notifications WHERE project_id=? AND recipient_id=? ORDER BY rowid DESC').all(projectId, actorId) as { snapshot_json: string; read_at: string | null; event_key: string }[]).flatMap(row => {
    const { formatVersion, ...notification } = JSON.parse(row.snapshot_json) as ProjectNotification & { formatVersion?: number };
    // Apply to old rows as well as new delivery; a role downgrade takes effect immediately.
    if (!canViewManagement && (managementEvent(notification.kind, notification.target.kind) || /^(risk_records|risk_alerts|settings_events):/.test(row.event_key))) return [];
    if (!isDemo && formatVersion === undefined && /^(task|risk_records|risk_alerts|plan_history|settings_events|workstream_events):/.test(row.event_key) && notification.message.startsWith('DEMO · ')) notification.message = notification.message.slice('DEMO · '.length);
    return [{ ...notification, readAt: row.read_at }];
  });
}
export function readNotifications(db: Database.Database, projectId: string, actorId: unknown, token: string, canViewManagement = memberCanViewManagement(db, projectId, actorId)): NotificationWorkspace {
  const { actor, actors, project } = context(db, projectId, actorId);
  const notifications = visibleNotifications(db, projectId, actor.id, project.isDemo, canViewManagement);
  const canManageJobs = canViewManagement && isProjectManager(actor.role);
  return { mode: project.isDemo ? 'demo' : 'standard', project, actorId: actor.id, actors, writeToken: token, unread: notifications.filter(item => !item.readAt).length, notifications, jobs: canManageJobs ? listJobs(db, projectId) : [], canManageJobs };
}
/** Settings also bump plan.version. Hash only collaboration state for restricted readers. */
function collaborationRevision(db: Database.Database, projectId: string): unknown[] {
  const plan = hasTable(db, 'plan_projects') ? db.prepare('SELECT nodes_json,dependencies_json FROM plan_projects WHERE project_id=?').get(projectId) : null;
  const tasks = hasTable(db, 'task_meta') ? db.prepare('SELECT task_id,meta_json FROM task_meta WHERE project_id=? ORDER BY task_id').all(projectId) : [];
  const history = hasTable(db, 'plan_history') ? db.prepare("SELECT id FROM plan_history WHERE project_id=? AND (json_extract(snapshot_json,'$.action') IN (SELECT value FROM json_each(?)) OR json_extract(snapshot_json,'$.action') LIKE '里程碑：%') ORDER BY id").all(projectId, JSON.stringify(collaborationPlanActions)) : [];
  const versions = [['plan_order_projects', 'version'], ['workstream_projects', 'version']].map(([table, field]) => hasTable(db, table!) ? db.prepare(`SELECT ${field} AS version FROM ${table} WHERE project_id=?`).get(projectId) ?? null : null);
  return [plan, tasks, history, versions, activityVersion(db, projectId, false)];
}
export function readProjectRevision(db: Database.Database, projectId: string, actorId: unknown, canViewManagement = memberCanViewManagement(db, projectId, actorId)): ProjectRevision & { capabilities: ReturnType<typeof managementCapabilities> } {
  const { actor, actors, project } = context(db, projectId, actorId);
  const values = canViewManagement ? [['plan_order_projects', 'version'], ['plan_projects', 'version'], ['risk_projects', 'revision'], ['settings_projects', 'version'], ['workstream_projects', 'version'], ['activity_versions', 'version']].map(([table, field]) => hasTable(db, table!) ? db.prepare(`SELECT ${field} AS version FROM ${table} WHERE project_id=?`).get(projectId) ?? null : null) : collaborationRevision(db, projectId);
  const capabilities = managementCapabilities(canViewManagement);
  const revision = createHash('sha256').update(JSON.stringify([values, capabilities, actors])).digest('hex');
  const unread = visibleNotifications(db, projectId, actor.id, project.isDemo, canViewManagement).filter(item => !item.readAt).length;
  return { revision, unread, actorId: actor.id, actors, capabilities };
}
export function writeNotifications(db: Database.Database, projectId: string, operation: 'read' | 'retry', jobId: string | undefined, body: unknown, actorId: unknown, key: unknown, now: Date, token: string, canViewManagement = memberCanViewManagement(db, projectId, actorId)): NotificationWorkspace {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST', '请提供有效操作内容。');
  const fields = body as Record<string, unknown>;
  requireValue(typeof key === 'string' && /^[\w:.-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。');
  if (operation === 'retry') requireValue(Object.keys(fields).length === 0, 'UNKNOWN_FIELD', '重试请求不支持额外字段。');
  else requireValue((Object.keys(fields).length === 1 && fields.all === true) || (Object.keys(fields).length === 1 && Array.isArray(fields.ids) && fields.ids.length > 0 && fields.ids.length <= 1000 && fields.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) && new Set(fields.ids).size === fields.ids.length), 'INVALID_NOTIFICATION_IDS', '请选择不重复的通知，或标记全部已读。');
  const hash = createHash('sha256').update(JSON.stringify({ operation, jobId, body, actorId })).digest('hex');
  return db.transaction(() => {
    const { actor } = context(db, projectId, actorId);
    if (actor.role === 'viewer') throw new PlanError(403, 'NOTIFICATIONS_FORBIDDEN', '只读成员不能修改通知状态。');
    if (operation === 'retry' && (!canViewManagement || !isProjectManager(actor.role))) throw new PlanError(403, 'JOBS_FORBIDDEN', '只有当前项目负责人或管理员可以重试失败作业。');
    const receipt = db.prepare('SELECT request_hash FROM notification_idempotency WHERE project_id=? AND request_key=?').get(projectId, key) as { request_hash: string } | undefined;
    if (receipt) {
      if (receipt.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请重新核对。');
      return readNotifications(db, projectId, actor.id, token, canViewManagement);
    }
    if (operation === 'retry') {
      if (!jobId || !retryFailedJob(db, projectId, jobId, now)) throw new PlanError(409, 'JOB_NOT_RETRYABLE', '当前项目中此作业不存在或不是失败状态，请刷新核对。');
      db.prepare('INSERT INTO notification_job_retries VALUES (?,?,?,?,?)').run(projectId, jobId, actor.id, now.toISOString(), key);
    } else {
      const visible = new Set(readNotifications(db, projectId, actor.id, token, canViewManagement).notifications.map(item => item.id));
      const ids = fields.all === true ? [...visible] : fields.ids as string[];
      if (!ids.every(id => visible.has(id))) throw new PlanError(403, 'NOTIFICATION_FORBIDDEN', '只能标记当前项目中属于自己的通知。');
      const mark = db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND project_id=? AND recipient_id=? AND read_at IS NULL');
      for (const id of ids) mark.run(now.toISOString(), id, projectId, actor.id);
    }
    db.prepare('INSERT INTO notification_idempotency VALUES (?,?,?)').run(projectId, key, hash);
    return readNotifications(db, projectId, actor.id, token, canViewManagement);
  })();
}
