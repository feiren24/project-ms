import { memberCanViewManagement } from '../auth/project-access.js';
import { managementEvent } from '../activities/privacy.js';
import { isExistingDatabase } from '../../db/lifecycle.js';
import { captureFeishuEvents } from '../feishu/events.js';
import { readMilestoneRecords } from '../milestones/store.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readProjectSnapshot } from '../projects/context.js';
import type Database from 'better-sqlite3';
import type { ManagedRisk, RiskAlert } from '../../../../shared/src/risks.js';
import type { ManagedTask, TaskEvent } from '../../../../shared/src/tasks.js';
import type { ProjectNotification } from '../../../../shared/src/notifications.js';
import { hasTable, readActors } from '../settings/store.js';
import { enqueueJob } from '../../jobs/store.js';

export interface NotificationPayload {
  formatVersion?: 1; eventKey: string; recipientId: string; kind: string; title: string; message: string; target: ProjectNotification['target'];
}
interface SourceEvent { key: string; kind: string; title: string; message: string; target: ProjectNotification['target']; recipientIds: string[] }
interface JsonRow { snapshot_json: string }
/** Read persisted audit events only. Repeated risk evidence updates without a new event never enqueue. */
function projectEvents(db: Database.Database, projectId: string, taskIds?: string[], planHistoryId?: string): SourceEvent[] {
  const prefix = readProjectSnapshot(db, projectId)?.project.isDemo ? 'DEMO · ' : '';
  const actors = readActors(db, projectId);
  if (planHistoryId) {
    const row = db.prepare('SELECT snapshot_json FROM plan_history WHERE project_id=? AND id=?').get(projectId,planHistoryId) as JsonRow | undefined;
    if (!row) return [];
    const event = JSON.parse(row.snapshot_json) as TaskEvent & { reason?: string };
    return [{key:`plan_history:${event.id}`,kind:`plan.${event.action}`,title:'项目计划已更新',message:`${prefix}${event.actor}：${event.reason ?? event.text ?? '请查看变更记录。'}`,target:{kind:'plan'},recipientIds:actors.map(actor=>actor.id)}];
  }
  const managers = actors.filter(actor => isProjectManager(actor.role)).map(actor => actor.id);
  const events: SourceEvent[] = [];
  const taskOwners = new Map<string, string[]>();
  if (hasTable(db, 'task_meta')) {
    const rows = db.prepare('SELECT m.task_id,m.meta_json,h.title FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.project_id=? AND (? IS NULL OR m.task_id IN (SELECT value FROM json_each(?)))').all(projectId,taskIds ? JSON.stringify(taskIds) : null,taskIds ? JSON.stringify(taskIds) : null) as { task_id: string; meta_json: string; title: string }[];
    for (const row of rows) {
      const task = JSON.parse(row.meta_json) as ManagedTask;
      const recipients = [task.ownerId, task.reviewerId, ...managers].filter((id): id is string => Boolean(id));
      taskOwners.set(row.task_id, recipients);
      for (const event of (task.events ?? []).filter(event=>!['delete','restore'].includes(event.action))) events.push({ key: `task:${row.task_id}:${event.id}`, kind: `task.${event.action}`, title: `任务更新 · ${row.title}`, message: `${prefix}${event.actor}：${event.text}`, target: { kind: 'task', id: row.task_id }, recipientIds: recipients });
    }
  }
  // Task writes can invalidate milestone acceptance. Scan their persisted events
  // even when task event capture is scoped; durable seen markers prevent repeats.
  for (const milestone of readMilestoneRecords(db, projectId)) {
    for (const event of milestone.events) events.push({ key: `milestone:${milestone.id}:${event.id}`, kind: `milestone.${event.action}`,
      title: `里程碑更新 · ${milestone.title}`, message: `${prefix}${event.actor}：${event.text}`,
      target: { kind: 'milestone', id: milestone.id }, recipientIds: [milestone.ownerId, milestone.reviewerId, ...managers].filter(Boolean) });
  }
  if (taskIds) return events;
  for (const table of ['risk_records', 'risk_alerts'] as const) {
    if (!hasTable(db, table)) continue;
    for (const row of db.prepare(`SELECT snapshot_json FROM ${table} WHERE project_id=?`).all(projectId) as JsonRow[]) {
      const risk = JSON.parse(row.snapshot_json) as ManagedRisk | RiskAlert;
      const recipients = ['ownerId' in risk ? risk.ownerId : null, 'closeReviewerId' in risk ? risk.closeReviewerId : null, ...managers, ...(risk.taskIds ?? []).flatMap(id => taskOwners.get(id) ?? [])].filter((id): id is string => Boolean(id));
      for (const event of risk.events ?? []) events.push({ key: `${table}:${risk.id}:${event.id}`, kind: `${table === 'risk_alerts' ? 'alert' : 'risk'}.${event.action}`, title: `${table === 'risk_alerts' ? '风险预警' : '风险更新'} · ${risk.title}`, message: `${prefix}${event.actor}：${event.text}`, target: { kind: 'risk', id: 'linkedRiskId' in risk ? risk.linkedRiskId ?? risk.id : risk.id }, recipientIds: recipients });
    }
  }
  for (const table of ['plan_history', 'settings_events'] as const) {
    if (!hasTable(db, table)) continue;
    for (const row of db.prepare(`SELECT snapshot_json FROM ${table} WHERE project_id=?`).all(projectId) as JsonRow[]) {
      const event = JSON.parse(row.snapshot_json) as TaskEvent & { summary?: string; reason?: string };
      const settings = table === 'settings_events';
      events.push({ key: `${table}:${event.id}`, kind: `${settings ? 'settings' : 'plan'}.${event.action}`, title: settings ? '成员与设置已更新' : '项目计划已更新', message: `${prefix}${event.actor}：${event.summary ?? event.reason ?? event.text ?? '请查看变更记录。'}`, target: { kind: settings ? 'settings' : 'plan' }, recipientIds: settings ? managers : actors.map(actor => actor.id) });
    }
  }
  if (hasTable(db, 'workstream_events')) {
    for (const row of db.prepare('SELECT workstream_id,snapshot_json FROM workstream_events WHERE project_id=?').all(projectId) as Array<{ workstream_id: string; snapshot_json: string }>) {
      const event = JSON.parse(row.snapshot_json) as { id: string; action: string; actor: string; reason: string };
      const owner = hasTable(db, 'workstreams') ? db.prepare('SELECT owner_id FROM workstreams WHERE project_id=? AND id=?').get(projectId, row.workstream_id) as { owner_id: string | null } | undefined : undefined;
      events.push({ key: `workstream_events:${event.id}`, kind: event.action, title: '工作分组已更新', message: `${prefix}${event.actor}：${event.reason}`, target: { kind: 'workstreams', id: row.workstream_id }, recipientIds: [...managers, ...(owner?.owner_id ? [owner.owner_id] : [])] });
    }
  }
  return events;
}
/** Separate durable marker: an empty seen table on restart must not swallow new events. */
export function initializeEventTracking(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  if (!hasTable(db, 'notification_state') || !hasTable(db, 'background_jobs')) return;
  db.transaction(() => {
    if (db.prepare("SELECT value FROM notification_state WHERE key='initial_events_seen'").get()) return;
    const insert = db.prepare('INSERT OR IGNORE INTO notification_seen(project_id,event_key) VALUES (?,?)');
    for (const row of db.prepare('SELECT id FROM homepage_projects').all() as { id: string }[]) for (const event of projectEvents(db, row.id)) insert.run(row.id, event.key);
    db.prepare("INSERT INTO notification_state(key,value) VALUES ('initial_events_seen','1')").run();
  })();
}
/** Called inside the business transaction; queue entries and seen markers share its rollback. */
export function captureProjectEvents(db: Database.Database, projectId: string, now: Date, taskIds?: string[]) {
  captureFeishuEvents(db,projectId,now,taskIds);
  captureEvents(db,projectId,now,taskIds);
}
/** Order-only writes need this audit event, not every historical task/risk event. */
export function capturePlanHistoryEvent(db: Database.Database, projectId: string, now: Date, eventId: string) {
  captureFeishuEvents(db,projectId,now,undefined,eventId);
  captureEvents(db,projectId,now,undefined,eventId);
}
function captureEvents(db: Database.Database, projectId: string, now: Date, taskIds?: string[], planHistoryId?: string) {
  if (!hasTable(db, 'notification_seen') || !hasTable(db, 'background_jobs')) return;
  const run = () => {
    const active = new Set(readActors(db, projectId).map(actor => actor.id));
    const seenRows = planHistoryId
      ? db.prepare('SELECT event_key FROM notification_seen WHERE project_id=? AND event_key=?').all(projectId,`plan_history:${planHistoryId}`)
      : db.prepare('SELECT event_key FROM notification_seen WHERE project_id=?').all(projectId);
    const seen = new Set((seenRows as {event_key:string}[]).map(row=>row.event_key));
    const mark = db.prepare('INSERT INTO notification_seen(project_id,event_key) VALUES (?,?)');
    for (const event of projectEvents(db, projectId, taskIds, planHistoryId)) {
      if (seen.has(event.key)) continue;
      for (const recipientId of new Set(event.recipientIds.filter(id => active.has(id)))) {
        if (managementEvent(event.kind, event.target.kind) && !memberCanViewManagement(db, projectId, recipientId)) continue;
        const { recipientIds: _recipients, key, ...content } = event;
        const payload: NotificationPayload = { ...content, formatVersion: 1, eventKey: key, recipientId };
        enqueueJob(db, { projectId, kind: 'notification', dedupeKey: JSON.stringify([projectId, key, recipientId]), payload, dueAt: now }, now);
      }
      mark.run(projectId, event.key); seen.add(event.key);
    }
  };
  // Standalone repair callers are atomic too; nested calls retain the caller's transaction.
  if (db.inTransaction) run(); else db.transaction(run)();
}
