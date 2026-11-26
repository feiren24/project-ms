import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ManagedTask, TaskActor, TaskWorkspace, WorkstreamChangePreview } from '../../../../shared/src/tasks.js';
import type { PlanNode } from '../../../../shared/src/planning.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readMembers } from '../settings/store.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { readPlanOrder } from '../planning/order.js';
import { recordActivity } from '../activities/repository.js';
import { readTasks } from './repository.js';

// Previews are intentionally invalid after a process restart; receipts remain durable.
const previewSecret = randomBytes(32);
export function canChangeWorkstream(db: Database.Database, projectId: string, actorId: unknown, accountId?: string | null): boolean {
  return readMembers(db, projectId).some(a => a.id === actorId && (accountId === undefined || (accountId !== null && a.userId === accountId)) && a.active && !a.removedAt && a.accountActive !== false && isProjectManager(a.role));
}
export function requireWorkstreamManager(db: Database.Database, projectId: string, actorId: unknown, accountId?: string | null) {
  if (!canChangeWorkstream(db, projectId, actorId, accountId)) throw new PlanError(403, 'TASK_FORBIDDEN', '仅当前项目有效的项目负责人或项目管理员可以调整工作分组。');
}
function previewState(db: Database.Database, w: TaskWorkspace, taskId: string, workstreamId: unknown, actorId: unknown, accountId?: string | null): WorkstreamChangePreview {
  requireWorkstreamManager(db, w.project.id, actorId, accountId);
  const root = w.tasks.find(t => t.id === taskId);
  if (!root) throw new PlanError(404, 'TASK_NOT_FOUND', '任务不存在或已删除。');
  requireValue(root.parentId === null, 'WORKSTREAM_ROOT_REQUIRED', '子任务跟随根任务调整工作分组，请从根任务操作。');
  const target = w.workstreams.find(s => s.id === workstreamId);
  requireValue(target, 'WORKSTREAM_REQUIRED', '请选择当前项目的工作分组。');
  requireValue(target.active !== false, 'WORKSTREAM_INACTIVE', '目标工作分组已停用，请选择启用的分组。');
  requireValue(target.id !== root.workstreamId, 'WORKSTREAM_UNCHANGED', '请选择不同的工作分组。');
  const children = new Map<string, ManagedTask[]>();
  for (const task of w.tasks) if (task.parentId) { const list = children.get(task.parentId) ?? []; list.push(task); children.set(task.parentId, list); }
  const tree: ManagedTask[] = [], seen = new Set<string>();
  const visit = (task: ManagedTask) => {
    requireValue(!seen.has(task.id), 'PARENT_CYCLE', '任务层级存在循环，请先修复。');
    seen.add(task.id); tree.push(task); for (const child of children.get(task.id) ?? []) visit(child);
  };
  visit(root);
  const projectId = w.project.id;
  const plan = db.prepare('SELECT version,nodes_json,dependencies_json,calendar_json FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string};
  const groups = db.prepare('SELECT * FROM workstreams WHERE project_id=? ORDER BY id').all(projectId);
  const groupVersion = db.prepare('SELECT version FROM workstream_projects WHERE project_id=?').get(projectId);
  // PATCH may synchronize legacy order projections; hash their read-only normalized
  // representation so that synchronization itself cannot invalidate a fresh preview.
  const order = readPlanOrder(db, projectId, JSON.parse(plan.nodes_json));
  const previewToken = createHmac('sha256', previewSecret).update(JSON.stringify({projectId, actorId, accountId, taskId, workstreamId, tree, plan, groups, groupVersion, order})).digest('hex');
  return {workstreamId: target.id, sourceWorkstreamId: root.workstreamId, previewToken, tasks: tree.map(({id,title,status,reviewStatus,taskKind}) => ({id,title,status,reviewStatus,taskKind}))};
}
export function previewWorkstreamChange(db: Database.Database, projectId: string, taskId: string, body: unknown, actorId: unknown, now: Date, accountId?: string | null): WorkstreamChangePreview {
  return db.transaction(() => {
    requireWorkstreamManager(db, projectId, actorId, accountId);
    requireValue(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST', '请选择目标工作分组。');
    const input = body as Record<string, unknown>;
    requireValue(Object.keys(input).length === 1 && typeof input.workstreamId === 'string', 'INVALID_REQUEST', '请仅提供目标工作分组。');
    return previewState(db, readTasks(db, projectId, '', now), taskId, input.workstreamId, actorId, accountId);
  })();
}
export function validateWorkstreamChange(db: Database.Database, w: TaskWorkspace, taskId: string, workstreamId: unknown, token: unknown, actorId: unknown, accountId?: string | null) {
  const preview = previewState(db, w, taskId, workstreamId, actorId, accountId);
  requireValue(typeof token === 'string' && token.length > 0, 'WORKSTREAM_PREVIEW_REQUIRED', '请先预览工作分组调整范围。');
  if (preview.previewToken !== token) throw new PlanError(409, 'WORKSTREAM_PREVIEW_STALE', '任务树或工作分组已变化，请保留草稿并重新预览。');
  return preview;
}
/** Caller owns the PATCH transaction. Only classification and audit/version fields change. */
export function applyWorkstreamChange(db: Database.Database, w: TaskWorkspace, nodes: PlanNode[], preview: WorkstreamChangePreview, actor: TaskActor, now: Date) {
  const target = w.workstreams.find(s => s.id === preview.workstreamId)!;
  const source = w.workstreams.find(s => s.id === preview.sourceWorkstreamId);
  const changed = preview.tasks.map(item => w.tasks.find(t => t.id === item.id)!);
  const text = `工作分组：${source?.name ?? preview.sourceWorkstreamId} → ${target.name}；根任务及 ${changed.length - 1} 个子任务一起调整。`;
  for (const task of changed) {
    task.workstreamId = target.id;
    task.version++; task.updatedAt = now.toISOString();
    task.events.push({id:randomUUID(),taskId:task.id,actor:actor.name,action:'workstream_change',text,createdAt:task.updatedAt});
    const raw = db.prepare('SELECT meta_json FROM task_meta WHERE project_id=? AND task_id=?').get(w.project.id,task.id) as {meta_json:string};
    const meta = JSON.parse(raw.meta_json);
    db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify({...meta,version:task.version,updatedAt:task.updatedAt,events:task.events}),w.project.id,task.id);
    db.prepare('UPDATE homepage_tasks SET workstream_id=? WHERE project_id=? AND id=?').run(target.id,w.project.id,task.id);
    const node = nodes.find(n => n.id === task.id)!;
    Object.assign(node, {workstreamId:target.id,color:target.color});
    if (task.parentId === null) node.parentId = `group-${target.id}`;
  }
  db.prepare('UPDATE plan_order_projects SET version=version+1 WHERE project_id=?').run(w.project.id);
  db.prepare('UPDATE workstream_projects SET version=version+1 WHERE project_id=?').run(w.project.id);
  db.prepare('UPDATE workstreams SET version=version+1 WHERE project_id=? AND id IN (?,?)').run(w.project.id,preview.sourceWorkstreamId,target.id);
  const root = changed[0]!, event = root.events.at(-1)!;
  db.prepare('INSERT INTO plan_history VALUES(?,?,?,?)').run(event.id,w.project.id,JSON.stringify({id:event.id,action:'调整任务工作分组',actor:actor.name,reason:text,affectedCount:changed.length,createdAt:event.createdAt,taskIds:changed.map(t=>t.id),sourceWorkstreamId:preview.sourceWorkstreamId,workstreamId:target.id}),event.createdAt);
  recordActivity(db,{projectId:w.project.id,sourceKey:`task-workstream:${event.id}`,type:'task.workstream_change',category:'task',actor,occurredAt:event.createdAt,target:{kind:'task',id:root.id,name:root.title},summary:text,changes:[{field:'workstreamId',before:preview.sourceWorkstreamId,after:target.id}]});
  return changed;
}
