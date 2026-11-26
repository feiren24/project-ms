import { isExistingDatabase } from '../../db/lifecycle.js';
import { recordActivity } from '../activities/repository.js';
import { activityChanges } from '../activities/hooks.js';
import { syncPlanOrder } from '../planning/order.js';
import { readOperationReason } from '../../operation-reasons.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readProjectSnapshot } from '../projects/context.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PlanNode } from '../../../../shared/src/planning.js';
import type { TaskActor } from '../../../../shared/src/tasks.js';
import type { ManagedWorkstream, WorkstreamColor, WorkstreamDraft, WorkstreamEvent, WorkstreamWorkspace } from '../../../../shared/src/workstreams.js';
import { captureBusinessJobs } from '../../job-integration.js';
import { readActors, readMembers } from '../settings/store.js';
import { PlanError, requireValue } from '../planning/errors.js';

type WorkstreamRow = {
  project_id: string; id: string; name: string; description: string; owner_id: string | null;
  color: WorkstreamColor; position: number; active: number; version: number;
};
type ReceiptRow = { request_hash: string; response_json: string };
const colors: WorkstreamColor[] = ['blue', 'cyan', 'purple', 'orange', 'green', 'slate'];

function hasTable(db: Database.Database, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function initializeWorkstreams(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS workstream_projects (
      project_id TEXT PRIMARY KEY REFERENCES homepage_projects(id), version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS workstreams (
      project_id TEXT NOT NULL REFERENCES workstream_projects(project_id), id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, owner_id TEXT, color TEXT NOT NULL CHECK(color IN ('blue','cyan','purple','orange','green','slate')),
      position INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(project_id,id), UNIQUE(project_id,name), UNIQUE(project_id,position)
    );
    CREATE TABLE IF NOT EXISTS workstream_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES workstream_projects(project_id), workstream_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workstream_events_project ON workstream_events(project_id,created_at);
    CREATE TABLE IF NOT EXISTS workstream_idempotency (
      project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK(json_valid(response_json)), PRIMARY KEY(project_id,actor_id,request_key)
    );`);
    for (const { project_id } of db.prepare('SELECT project_id FROM plan_projects').all() as { project_id: string }[]) {
      if (db.prepare('SELECT 1 FROM workstream_projects WHERE project_id=?').get(project_id)) continue;
      db.prepare('INSERT INTO workstream_projects(project_id,version) VALUES(?,1)').run(project_id);
      const snapshotRow = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(project_id) as { snapshot_json: string };
      const snapshot = JSON.parse(snapshotRow.snapshot_json);
      const planRow = db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(project_id) as { nodes_json: string };
      const nodes = JSON.parse(planRow.nodes_json) as PlanNode[];
      const groups = nodes.filter(node => node.kind === 'group' && node.parentId === null);
      const members = readMembers(db, project_id);
      const oldStreams = new Map<string, { id: string; name: string; description?: string; owner?: string; color?: string }>((snapshot.workstreams ?? []).map((item: { id: string; name: string }) => [item.id, item]));
      groups.forEach((group, position) => {
        const old = oldStreams.get(group.workstreamId);
        const ownerName = old?.owner ?? group.owner;
        const ownerId = members.find(member => member.name === ownerName && member.active)?.id ?? null;
        const color = colors.includes(group.color as WorkstreamColor) ? group.color as WorkstreamColor : colors.includes(old?.color as WorkstreamColor) ? old!.color as WorkstreamColor : 'blue';
        db.prepare('INSERT INTO workstreams VALUES(?,?,?,?,?,?,?,?,1)').run(project_id, group.workstreamId, old?.name ?? group.title, old?.description ?? group.description ?? '', ownerId, color, position, 1);
      });
    }
  })();
}

export function initializeProjectWorkstream(db: Database.Database, projectId: string, ownerId: string) {
  db.prepare('INSERT INTO workstream_projects(project_id,version) VALUES(?,1)').run(projectId);
  db.prepare("INSERT INTO workstreams VALUES(?,?,?,?,?,'blue',0,1,1)").run(projectId, 'general', '通用工作', '项目默认工作分组', ownerId);
}

function projectState(db: Database.Database, projectId: string) {
  const state = hasTable(db, 'workstream_projects') ? db.prepare('SELECT version FROM workstream_projects WHERE project_id=?').get(projectId) as { version: number } | undefined : undefined;
  const plan = db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get(projectId) as { version: number } | undefined;
  if (!state || !plan) throw new PlanError(404, 'PROJECT_NOT_FOUND', '项目不存在或当前账号无权访问。');
  return { version: state.version, planVersion: plan.version };
}

function counts(db: Database.Database, projectId: string) {
  const rows = hasTable(db,'task_meta')
    ? db.prepare("SELECT h.workstream_id AS id,count(*) AS taskCount,SUM(CASE WHEN h.status!='done' AND COALESCE(json_extract(m.meta_json,'$.cancelled'),0)!=1 THEN 1 ELSE 0 END) AS unfinishedCount FROM homepage_tasks h LEFT JOIN task_meta m ON m.project_id=h.project_id AND m.task_id=h.id WHERE h.project_id=? AND COALESCE(json_extract(m.meta_json,'$.taskKind'),'execution')!='summary' GROUP BY h.workstream_id").all(projectId)
    : db.prepare("SELECT workstream_id AS id,count(*) AS taskCount,SUM(CASE WHEN status!='done' THEN 1 ELSE 0 END) AS unfinishedCount FROM homepage_tasks WHERE project_id=? GROUP BY workstream_id").all(projectId);
  return new Map((rows as Array<{id:string;taskCount:number;unfinishedCount:number}>).map(({id,...values})=>[id,values]));
}

export function readWorkstreamList(db: Database.Database, projectId: string): Array<{ id: string; name: string; color: string; active?: boolean }> {
  if (!hasTable(db, 'workstreams')) return [];
  return (db.prepare('SELECT id,name,color,active FROM workstreams WHERE project_id=? ORDER BY position,id').all(projectId) as Array<{ id: string; name: string; color: string; active: number }>).map(row => ({ id: row.id, name: row.name, color: row.color, active: Boolean(row.active) }));
}

export function isWorkstreamActive(db: Database.Database, projectId: string, workstreamId: string) {
  if (!hasTable(db, 'workstreams')) return true;
  const row = db.prepare('SELECT active FROM workstreams WHERE project_id=? AND id=?').get(projectId, workstreamId) as { active: number } | undefined;
  return row ? Boolean(row.active) : false;
}

export function readWorkstreams(db: Database.Database, projectId: string, token: string, actorId: unknown, effectiveManager = false): WorkstreamWorkspace {
  const state = projectState(db, projectId);
  const actors = readActors(db, projectId);
  const actor = actors.find(item => item.id === actorId);
  const canManage = effectiveManager || isProjectManager(actor?.role);
  const members = new Map(readMembers(db, projectId).map(member => [member.id, member.name]));
  const taskCounts=counts(db,projectId);
  const workstreams = (db.prepare('SELECT * FROM workstreams WHERE project_id=? ORDER BY position,id').all(projectId) as WorkstreamRow[]).map(row => ({
    id: row.id, name: row.name, description: row.description, ownerId: row.owner_id, owner: row.owner_id ? members.get(row.owner_id) ?? null : null,
    color: row.color, position: row.position, active: Boolean(row.active), version: row.version, ...(taskCounts.get(row.id) ?? {taskCount:0,unfinishedCount:0}),
  }));
  const history = (db.prepare('SELECT snapshot_json FROM workstream_events WHERE project_id=? ORDER BY rowid DESC LIMIT 100').all(projectId) as { snapshot_json: string }[]).map(row => JSON.parse(row.snapshot_json) as WorkstreamEvent);
  const snapshot = readProjectSnapshot(db, projectId)!;
  return { mode: snapshot.mode, project: { id: projectId, name: snapshot.project.name, isDemo: snapshot.project.isDemo }, projectId, ...state, writeToken: token, canManage, actors, workstreams, history };
}

function strict(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(Boolean(value) && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY', '请求内容无效，请核对后重试。');
  const actual = Object.keys(value as object);
  requireValue(keys.filter(key => key !== 'reason').every(key => actual.includes(key)) && actual.every(key => keys.includes(key)), 'INVALID_BODY', '请求字段不完整或包含不支持的内容。');
}
function writeValue(value: Record<string, unknown>) {
  requireValue(Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) > 0 && Number.isSafeInteger(value.expectedPlanVersion) && Number(value.expectedPlanVersion) > 0, 'VERSION_REQUIRED', '请提供当前工作分组和计划版本。');
  const reason = readOperationReason(value.reason, { domain: 'workstream', action: 'write' }, 500);
  return { expectedVersion: Number(value.expectedVersion), expectedPlanVersion: Number(value.expectedPlanVersion), reason };
}
function draftValue(value: unknown, actors: TaskActor[]): WorkstreamDraft {
  strict(value, ['name', 'description', 'ownerId', 'color']);
  requireValue(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 80, 'INVALID_NAME', '工作分组名称必填且最多 80 字。');
  requireValue(typeof value.description === 'string' && value.description.length <= 1000, 'INVALID_DESCRIPTION', '工作分组描述最多 1000 字。');
  requireValue(value.ownerId === null || (typeof value.ownerId === 'string' && actors.some(actor => actor.id === value.ownerId && actor.assignable !== false)), 'INVALID_OWNER', '协调负责人须为当前项目已启用成员。');
  requireValue(colors.includes(value.color as WorkstreamColor), 'INVALID_COLOR', '请选择支持的工作分组颜色。');
  return { name: value.name.trim(), description: value.description.trim(), ownerId: value.ownerId as string | null, color: value.color as WorkstreamColor };
}

function syncProjection(db: Database.Database, projectId: string, rows: WorkstreamRow[]) {
  const planRow = db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as { nodes_json: string };
  const stored = JSON.parse(planRow.nodes_json) as PlanNode[];
  syncPlanOrder(db,projectId,stored);
  const ordered: PlanNode[] = [];
  for (const row of rows) {
    let group = stored.find(node => node.kind === 'group' && node.parentId === null && node.workstreamId === row.id);
    if (!group) {
      const maxWbs = stored.filter(node => node.kind === 'group' && /^\d+$/.test(node.wbs)).reduce((max, node) => Math.max(max, Number(node.wbs)), 0);
      group = { id: `group-${row.id}`, parentId: null, workstreamId: row.id, wbs: String(maxWbs + 1), kind: 'group', title: row.name, description: row.description, owner: '', color: row.color, status: 'todo', start: null, end: null, durationDays: null, effortHours: null, progress: 0, blocked: false };
      stored.push(group);
    }
    const owner = row.owner_id ? readMembers(db, projectId).find(member => member.id === row.owner_id)?.name ?? '' : '';
    Object.assign(group, { title: row.name, description: row.description, owner, color: row.color });
    for (const node of stored.filter(node => node.workstreamId === row.id)) node.color = row.color;
    ordered.push(group);
  }
  const groupIds = new Set(ordered.map(node => node.id));
  const nodes = [...ordered, ...stored.filter(node => !groupIds.has(node.id))];
  db.prepare('UPDATE plan_projects SET version=version+1,nodes_json=? WHERE project_id=?').run(JSON.stringify(nodes), projectId);
  syncPlanOrder(db,projectId,nodes);

  const snapshotRow = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(projectId) as { snapshot_json: string };
  const snapshot = JSON.parse(snapshotRow.snapshot_json);
  const old = new Map<string, Record<string, unknown>>((snapshot.workstreams ?? []).map((item: Record<string, unknown>) => [String(item.id), item]));
  snapshot.workstreams = rows.map(row => ({ ...(old.get(row.id) ?? {}), id: row.id, name: row.name, description: row.description, color: row.color,
    owner: row.owner_id ? readMembers(db, projectId).find(member => member.id === row.owner_id)?.name ?? '' : '', active: Boolean(row.active),
    start: old.get(row.id)?.start ?? '', end: old.get(row.id)?.end ?? '', icon: old.get(row.id)?.icon ?? 'layers' }));
  db.prepare('UPDATE homepage_projects SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), projectId);
}

function event(db: Database.Database, projectId: string, workstreamId: string, action: string, actorId: string, actorName: string, reason: string, now: Date) {
  const item: WorkstreamEvent = { id: randomUUID(), workstreamId, action, actor: actorName, reason, createdAt: now.toISOString() };
  db.prepare('INSERT INTO workstream_events VALUES(?,?,?,?,?,?)').run(item.id, projectId, workstreamId, actorId, JSON.stringify(item), item.createdAt);
}

export function writeWorkstream(db: Database.Database, projectId: string, operation: 'create'|'update'|'status'|'move', workstreamId: string | undefined, body: unknown, actorId: unknown, key: unknown, now: Date, token: string, effectiveManager = false, actorName?: string, accountId?: string): WorkstreamWorkspace {
  const keys = operation === 'create' || operation === 'update' ? ['expectedVersion','expectedPlanVersion','reason','workstream'] : operation === 'status' ? ['expectedVersion','expectedPlanVersion','reason','active'] : ['expectedVersion','expectedPlanVersion','reason','direction'];
  strict(body, keys);
  const write = writeValue(body);
  requireValue(typeof key === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。');
  const hash = createHash('sha256').update(JSON.stringify({ operation, workstreamId, body })).digest('hex');
  return db.transaction(() => {
    const before = readWorkstreams(db, projectId, token, actorId, effectiveManager);
    if (!before.canManage) throw new PlanError(403, 'WORKSTREAMS_FORBIDDEN', '仅项目负责人或管理员可以维护工作分组。');
    const idActor = accountId ?? (typeof actorId === 'string' ? actorId : '');
    const receipt = db.prepare('SELECT request_hash,response_json FROM workstream_idempotency WHERE project_id=? AND actor_id=? AND request_key=?').get(projectId, idActor, key) as ReceiptRow | undefined;
    if (receipt) {
      if (receipt.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请重新核对。');
      return JSON.parse(receipt.response_json) as WorkstreamWorkspace;
    }
    if (write.expectedVersion !== before.version) throw new PlanError(409, 'WORKSTREAM_VERSION_CONFLICT', '工作分组已更新，请保留草稿并刷新核对。', { latestVersion: before.version });
    if (write.expectedPlanVersion !== before.planVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '项目计划已更新，请保留草稿并刷新核对。', { latestPlanVersion: before.planVersion });
    const actors = before.actors;
    let id = workstreamId;
    let changed = true;
    if (operation === 'create') {
      const draft = draftValue(body.workstream, actors);
      requireValue(!before.workstreams.some(item => item.name === draft.name), 'DUPLICATE_WORKSTREAM_NAME', '当前项目已存在同名工作分组。');
      id = randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO workstreams VALUES(?,?,?,?,?,?,?,?,1)').run(projectId, id, draft.name, draft.description, draft.ownerId, draft.color, before.workstreams.length, 1);
    } else {
      const current = before.workstreams.find(item => item.id === workstreamId);
      if (!current) throw new PlanError(404, 'WORKSTREAM_NOT_FOUND', '未找到当前项目中的工作分组。');
      if (operation === 'update') {
        const draft = draftValue(body.workstream, actors);
        requireValue(!before.workstreams.some(item => item.id !== current.id && item.name === draft.name), 'DUPLICATE_WORKSTREAM_NAME', '当前项目已存在同名工作分组。');
        changed = current.name !== draft.name || current.description !== draft.description || current.ownerId !== draft.ownerId || current.color !== draft.color;
        if (changed) db.prepare('UPDATE workstreams SET name=?,description=?,owner_id=?,color=?,version=version+1 WHERE project_id=? AND id=?').run(draft.name, draft.description, draft.ownerId, draft.color, projectId, current.id);
      } else if (operation === 'status') {
        requireValue(typeof body.active === 'boolean', 'INVALID_STATUS', '请明确工作分组启用状态。');
        changed = current.active !== body.active;
        if (changed && body.active && current.ownerId) requireValue(before.actors.some(actor => actor.id === current.ownerId && actor.assignable !== false), 'WORKSTREAM_OWNER_INACTIVE', '协调负责人已停用或不可分配，请先清空或移交负责人再恢复工作分组。');
        if (changed) db.prepare('UPDATE workstreams SET active=?,version=version+1 WHERE project_id=? AND id=?').run(Number(body.active), projectId, current.id);
      } else {
        requireValue(body.direction === 'up' || body.direction === 'down', 'INVALID_DIRECTION', '请选择向上或向下移动。');
        const targetPosition = current.position + (body.direction === 'up' ? -1 : 1);
        const target = before.workstreams.find(item => item.position === targetPosition);
        changed = Boolean(target);
        if (target) {
          db.prepare('UPDATE workstreams SET position=-1 WHERE project_id=? AND id=?').run(projectId, current.id);
          db.prepare('UPDATE workstreams SET position=?,version=version+1 WHERE project_id=? AND id=?').run(current.position, projectId, target.id);
          db.prepare('UPDATE workstreams SET position=?,version=version+1 WHERE project_id=? AND id=?').run(target.position, projectId, current.id);
        }
      }
    }
    if (changed) {
      const rows = db.prepare('SELECT * FROM workstreams WHERE project_id=? ORDER BY position,id').all(projectId) as WorkstreamRow[];
      syncProjection(db, projectId, rows);
      db.prepare('UPDATE workstream_projects SET version=version+1 WHERE project_id=?').run(projectId);
      const action = operation === 'status' ? `workstream.${body.active ? 'enable' : 'disable'}` : `workstream.${operation}`;
      event(db, projectId, id!, action, idActor, actorName ?? before.actors.find(item => item.id === actorId)?.name ?? '项目操作者', write.reason || `${operation === 'create' ? '新增' : operation === 'update' ? '编辑' : operation === 'status' ? body.active ? '启用' : '停用' : body.direction === 'up' ? '上移' : '下移'}工作分组`, now);
      captureBusinessJobs(db, projectId, now);
    }
    const result = readWorkstreams(db, projectId, token, actorId, effectiveManager);
    const activityAfter = result.workstreams.find(item => item.id === id), activityBefore = before.workstreams.find(item => item.id === id);
    if (changed && activityAfter && operation !== 'move') {
      const changes = activityChanges(activityBefore, activityAfter, ['active','ownerId','owner']);
      if (operation === 'create' || changes.length) recordActivity(db,{projectId,sourceKey:`workgroup:${idActor}:${key}`,type:`workgroup.${operation}`,category:'workgroup',actor:{id:idActor,name:actorName??before.actors.find(item=>item.id===actorId)?.name??'项目操作者'},occurredAt:now.toISOString(),target:{kind:'workgroup',id:activityAfter.id,name:activityAfter.name},summary:`${operation==='create'?'创建工作分组':operation==='status'?activityAfter.active?'启用工作分组':'停用工作分组':'变更分组协调负责人'}「${activityAfter.name}」`,changes});
    }

    db.prepare('INSERT INTO workstream_idempotency VALUES(?,?,?,?,?)').run(projectId, idActor, key, hash, JSON.stringify(result));
    return result;
  })();
}
