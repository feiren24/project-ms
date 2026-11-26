import { isExistingDatabase } from '../../db/lifecycle.js';
import { applyWorkstreamChange, requireWorkstreamManager, validateWorkstreamChange } from './workstream-change.js';
import { initializeTaskRecycle } from './recycle-store.js';
import { captureTaskActivity } from '../activities/hooks.js';
import { syncPlanOrder } from '../planning/order.js';
import { readOperationReason } from '../../operation-reasons.js';
import { taskOperationSummary } from '../../../../shared/src/operation-reasons.js';
import { canReviewTask, isProjectManager } from '../../../../shared/src/permissions.js';
import { readMilestoneRecords, reconcileMilestones } from '../milestones/store.js';
import { captureBusinessJobs } from '../../job-integration.js';
import { createHash, randomUUID } from 'node:crypto';
import { readActors, readPeople } from '../settings/store.js';
import { shanghaiDate } from '../analytics/dates.js';
import type Database from 'better-sqlite3';
import type { ManagedTask, ParentPreview, TaskActor, TaskDraft, TaskWorkspace } from '../../../../shared/src/tasks.js';
import type { PlanNode, PlanDependency, PlanningCalendar } from '../../../../shared/src/planning.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { duration, isWorkday, validDate } from '../planning/calendar.js';
import { readProjectSnapshot } from '../projects/context.js';
import { isWorkstreamActive, readWorkstreamList } from '../workstreams/repository.js';

type PlanRow = { version: number; nodes_json: string; dependencies_json: string; calendar_json: string };
type MetaRow = { task_id: string; meta_json: string };
type HomeRow = { id: string; title: string; owner: string; priority: ManagedTask['priority']; status: 'todo' | 'in_progress' | 'done'; progress: number; blocked: number; workstream_id: string };

export function initializeTasks(db: Database.Database) {
  initializeTaskRecycle(db);
  if (isExistingDatabase(db)) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS task_meta (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, meta_json TEXT NOT NULL CHECK(json_valid(meta_json)));
      CREATE INDEX IF NOT EXISTS task_meta_project ON task_meta(project_id);
      CREATE INDEX IF NOT EXISTS task_meta_parent ON task_meta(project_id,json_extract(meta_json,'$.parentId'));
      CREATE TABLE IF NOT EXISTS task_idempotency (project_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(project_id,request_key));`);
    db.exec(`CREATE TABLE IF NOT EXISTS plan_structure_versions(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1);
      INSERT OR IGNORE INTO plan_structure_versions(project_id) SELECT project_id FROM plan_projects;
      CREATE TRIGGER IF NOT EXISTS plan_structure_insert AFTER INSERT ON plan_projects BEGIN INSERT OR IGNORE INTO plan_structure_versions(project_id) VALUES(NEW.project_id); END;
      CREATE TRIGGER IF NOT EXISTS plan_structure_update AFTER UPDATE OF nodes_json,dependencies_json,calendar_json ON plan_projects
      WHEN OLD.dependencies_json != NEW.dependencies_json OR OLD.calendar_json != NEW.calendar_json OR
        (SELECT json_group_array(json_array(json_extract(value,'$.id'),json_extract(value,'$.parentId'),json_extract(value,'$.kind'),json_extract(value,'$.start'),json_extract(value,'$.end'))) FROM json_each(OLD.nodes_json)) !=
        (SELECT json_group_array(json_array(json_extract(value,'$.id'),json_extract(value,'$.parentId'),json_extract(value,'$.kind'),json_extract(value,'$.start'),json_extract(value,'$.end'))) FROM json_each(NEW.nodes_json))
      BEGIN UPDATE plan_structure_versions SET version=version+1 WHERE project_id=NEW.project_id; END;`);
    for (const row of db.prepare('SELECT project_id, nodes_json FROM plan_projects').all() as { project_id: string; nodes_json: string }[]) {
      const nodes = JSON.parse(row.nodes_json) as PlanNode[];
      const actors = readActors(db, row.project_id);
      for (const node of nodes.filter(n => n.kind === 'task')) {
        if (!db.prepare('SELECT id FROM homepage_tasks WHERE id = ?').get(node.id)) continue;
        const ownerId = actors.find(a => a.name === node.owner)?.id ?? '';
        const review = node.id === 'task-006' && node.status === 'in_progress' && ownerId === 'chen';
        const meta = { description: node.description, taskKind: 'execution', originalWork: false, parentId: null, ownerId, requiresReview: review, reviewerId: review ? 'lin' : null,
          acceptanceCriteria: review ? 'DEMO · 提交可检查的接口清单，说明主要输入、输出和异常处理。' : '', evidence: '',
          reviewStatus: 'none', actualStart: null, actualEnd: null, blockReason: node.blocked ? 'DEMO · 示例阻塞，待负责人补充进展。' : '',
          version: 1, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', cancelled: false, events: [], submissions: [] };
        db.prepare('INSERT OR IGNORE INTO task_meta VALUES (?, ?, ?)').run(node.id, row.project_id, JSON.stringify(meta));
      }
    }
    db.exec(`UPDATE task_meta SET meta_json=json_set(meta_json, '$.taskKind', 'summary') WHERE task_id IN (SELECT json_extract(meta_json, '$.parentId') FROM task_meta WHERE json_extract(meta_json, '$.parentId') IS NOT NULL);`);
  })();
}

function projectPlan(db: Database.Database, projectId: string) {
  const row = db.prepare('SELECT * FROM plan_projects WHERE project_id = ?').get(projectId) as PlanRow | undefined;
  if (!row) throw new PlanError(404, 'PROJECT_NOT_FOUND', '未找到此项目。');
  return { row, nodes: JSON.parse(row.nodes_json) as PlanNode[], dependencies: JSON.parse(row.dependencies_json) as PlanDependency[], calendar: JSON.parse(row.calendar_json) as PlanningCalendar };
}
export function readTasks(db: Database.Database, projectId: string, token: string, now = new Date()): TaskWorkspace {
  const { row, nodes, dependencies } = projectPlan(db, projectId);
  const snapshot = readProjectSnapshot(db, projectId, now)!;
  const metas = new Map((db.prepare('SELECT * FROM task_meta WHERE project_id = ?').all(projectId) as MetaRow[]).map(m => [m.task_id, JSON.parse(m.meta_json)]));
  const rows = db.prepare('SELECT * FROM homepage_tasks WHERE project_id = ? ORDER BY position,id').all(projectId) as HomeRow[];
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const tasks: ManagedTask[] = rows.flatMap(home => {
    const node = nodeById.get(home.id); const meta = metas.get(home.id);
    if (!node || !meta) return [];
    const { cancelled, ...fields } = meta;
    return [{ ...fields, id: home.id, wbs: node.wbs, workstreamId: home.workstream_id, title: home.title, owner: home.owner,
      priority: home.priority, status: cancelled ? 'cancelled' : home.status, progress: home.progress, blocked: Boolean(home.blocked),
      start: node.start, end: node.end, effortHours: node.effortHours } as ManagedTask];
  });
  const { id, name, asOf, start, end, isDemo } = snapshot.project;
  // Classification includes cancelled history and does not depend on derived status.
  const childrenById = new Map<string, ManagedTask[]>();
  for (const task of tasks) if (task.parentId) { const list = childrenById.get(task.parentId) ?? []; list.push(task); childrenById.set(task.parentId, list); }
  for (const task of tasks) {
    task.taskKind = task.taskKind === 'summary' || childrenById.has(task.id) ? 'summary' : 'execution';
    task.isContainer = task.taskKind === 'summary'; task.originalWork ??= false;
  }
  const leaves = (task: ManagedTask, seen = new Set<string>()): ManagedTask[] => {
    if (seen.has(task.id) || task.status === 'cancelled') return []; seen.add(task.id);
    return task.taskKind === 'summary' ? (childrenById.get(task.id) ?? []).flatMap(child => leaves(child, seen)) : [task];
  };
  for (const task of tasks.filter(task => task.taskKind === 'summary' && task.status !== 'cancelled')) {
    const executable = leaves(task);
    task.progress = executable.length ? Math.round(executable.reduce((sum, child) => sum + child.progress, 0) / executable.length) : 0;
    task.status = executable.length && executable.every(child => child.status === 'done') ? 'done' : executable.some(child => child.status !== 'todo') ? 'in_progress' : 'todo';
    task.start = executable.flatMap(child => child.start ? [child.start] : []).sort()[0] ?? null;
    task.end = executable.flatMap(child => child.end ? [child.end] : []).sort().at(-1) ?? null;
    task.effortHours = executable.some(child => child.effortHours !== null) ? executable.reduce((sum, child) => sum + (child.effortHours ?? 0), 0) : null;
    task.blocked = executable.some(child => child.blocked); task.blockReason = task.blocked ? '子任务存在阻塞，请展开查看。' : '';
    task.actualStart = null; task.actualEnd = null; task.completionPlanEnd = null;
  }
  for (const task of tasks) task.parentEligibility = parentEligibility(task);
  return { mode: snapshot.mode, project: { isDemo, id, name, asOf, start, end }, structureVersion: (db.prepare('SELECT version FROM plan_structure_versions WHERE project_id=?').get(projectId) as {version:number}|undefined)?.version ?? 1, planVersion: row.version, writeToken: token, actors: readActors(db, projectId),
    people: readPeople(db, projectId, tasks.flatMap(task => [task.ownerId, task.reviewerId, ...task.submissions.flatMap(submission => [submission.submitterId, submission.reviewerId, submission.reviewedById, submission.snapshot?.ownerId])])),
    workstreams: readWorkstreamList(db, projectId).length ? readWorkstreamList(db, projectId) : snapshot.workstreams.map((w: { id: string; name: string; color: string; active?: boolean }) => ({ id: w.id, name: w.name, color: w.color, active: w.active ?? true })), tasks, dependencies };
}

function parentEligibility(task: ManagedTask): NonNullable<ManagedTask['parentEligibility']> {
  if (task.parentId !== null) return { mode: 'blocked', reason: '二级任务不能再添加子任务，任务最多两级。' };
  if (task.status === 'cancelled') return { mode: 'blocked', reason: '任务已取消，请先恢复。' };
  if (task.taskKind === 'summary') return { mode: 'summary', reason: '可直接添加二级任务。' };
  if (task.status === 'done') return { mode: 'blocked', reason: '任务已完成，请先重开再转换。' };
  if (task.reviewStatus === 'submitted') return { mode: 'blocked', reason: '正在等待验收，退回后才能转换。' };
  return { mode: 'convert', reason: '确认后新建同名汇总父任务，原执行内容保留为二级任务。' };
}
export function previewParent(db: Database.Database, projectId: string, body: unknown, actorId: unknown): ParentPreview {
  strict(body, ['parentId', 'workstreamId', 'expectedPlanVersion']);
  const actor = readActors(db, projectId).find(actor => actor.id === actorId);
  if (!actor) throw new PlanError(403, 'TASK_FORBIDDEN', '请选择有效的项目成员身份。');
  if (actor.role === 'viewer') throw new PlanError(403, 'TASK_FORBIDDEN', '只读成员不能创建任务。');
  const workspace = readTasks(db, projectId, '');
  requireValue(Number.isInteger(body.expectedPlanVersion) && Number(body.expectedPlanVersion) > 0, 'VERSION_REQUIRED', '请提供当前计划版本。');
  if (workspace.planVersion !== body.expectedPlanVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '项目计划已更新，请保留草稿并重新预览。');
  const parent = workspace.tasks.find(task => task.id === body.parentId);
  requireValue(parent && parent.workstreamId === body.workstreamId, 'INVALID_PARENT', '请选择同一工作分组中的父任务。');
  requireValue(isWorkstreamActive(db, projectId, String(body.workstreamId)), 'WORKSTREAM_INACTIVE', '此工作分组已停用，不能新建子任务。');
  requireValue(parent.parentId === null, 'MAX_TASK_DEPTH', '任务最多两级，二级任务不能再添加子任务。');
  const eligibility = parentEligibility(parent);
  requireValue(eligibility.mode !== 'blocked', 'PARENT_UNAVAILABLE', eligibility.reason);
  if (eligibility.mode === 'convert') canManage(actor);
  return { mode: eligibility.mode as ParentPreview['mode'], parent, expectedPlanVersion: workspace.planVersion, expectedParentVersion: parent.version,
    executionCountDelta: 1, retained: ['原任务 ID 与编号', '负责人、日期、工时与进度', '前置与后置依赖', '验收成果与评论记录', '历史计划基线'] };
}

function strict(body: unknown, keys: string[]): asserts body is Record<string, unknown> {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST', '请提供有效任务内容。');
  requireValue(Object.keys(body).every(k => keys.includes(k)), 'UNKNOWN_FIELD', '请求包含不支持的字段，请刷新后重试。');
}
function textValue(value: unknown, field: string, max: number, required = false): string {
  requireValue(typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0), 'INVALID_TEXT', `${field}${required ? '必填，' : ''}最多 ${max} 字。`);
  return value.trim();
}
function evidenceValue(value: unknown) {
  const result = textValue(value, '成果说明', 5000);
  requireValue(!/(?:javascript|data|vbscript|file)\s*:/i.test(result), 'UNSAFE_LINK', '成果链接仅支持 HTTP 或 HTTPS，请移除不支持的链接。');
  requireValue(!/\b(?!https?:)[a-z][a-z0-9+.-]*:\/\//i.test(result), 'UNSAFE_LINK', '成果链接仅支持 HTTP 或 HTTPS。');
  return result;
}
function canManage(actor: TaskActor) { if (!isProjectManager(actor.role)) throw new PlanError(403, 'TASK_FORBIDDEN', '此操作需要项目负责人或管理员权限。'); }
function canExecute(actor: TaskActor, task: ManagedTask) {
  if (actor.role === 'viewer' || (!isProjectManager(actor.role) && actor.id !== task.ownerId)) throw new PlanError(403, 'TASK_FORBIDDEN', '仅任务负责人、项目负责人或管理员可执行此操作。');
}
function mutable(task: ManagedTask) {
  requireValue((task.taskKind === 'summary' || task.status !== 'done') && task.status !== 'cancelled', 'TASK_IMMUTABLE', '已完成或已取消任务须先填写原因重开，再修改。');
  requireValue(task.reviewStatus !== 'submitted', 'REVIEW_PENDING', '已提交成果正在等待验收，退回后才能修改。');
}
function taskVersion(task: ManagedTask, version: unknown) {
  requireValue(Number.isInteger(version) && Number(version) > 0, 'VERSION_REQUIRED', '请提供有效的任务版本。');
  if (task.version !== version) throw new PlanError(409, 'TASK_VERSION_CONFLICT', '任务已更新，请刷新后核对并重试，当前填写内容可以保留。', { latestVersion: task.version });
}
const draftKeys = ['title', 'description', 'workstreamId', 'parentId', 'ownerId', 'priority', 'effortHours', 'requiresReview', 'reviewerId', 'acceptanceCriteria', 'evidence', 'start', 'end'];
function validateDraft(body: Record<string, unknown>, workspace: TaskWorkspace, current?: ManagedTask): TaskDraft {
  const actors = workspace.actors;
  const title = textValue(body.title, '任务标题', 160, true); const description = textValue(body.description, '任务描述', 5000);
  const selectedWorkstream = workspace.workstreams.find(w => w.id === body.workstreamId);
  requireValue(selectedWorkstream, 'WORKSTREAM_REQUIRED', '请选择现有工作分组。');
  requireValue(Boolean(selectedWorkstream.active ?? true) || current?.workstreamId === body.workstreamId, 'WORKSTREAM_INACTIVE', '此工作分组已停用，不能新建任务或移入任务。');
  requireValue(typeof body.ownerId === 'string' && actors.some(a => a.id === body.ownerId && a.assignable !== false && (a.role !== 'viewer' || current?.ownerId === a.id)), 'INVALID_OWNER', '请选择具有执行权限的任务负责人。');
  requireValue(['P0', 'P1', 'P2'].includes(String(body.priority)), 'INVALID_PRIORITY', '请选择 P0、P1 或 P2。');
  requireValue(body.effortHours === null || (typeof body.effortHours === 'number' && Number.isFinite(body.effortHours) && body.effortHours > 0 && body.effortHours <= 10000), 'INVALID_EFFORT', '预计工时须为正数，未估算时请留空。');
  requireValue(typeof body.requiresReview === 'boolean', 'INVALID_REVIEW', '请明确是否属于关键成果。');
  requireValue(body.reviewerId === null || actors.some(a => a.id === body.reviewerId && a.assignable !== false && a.role !== 'viewer'), 'INVALID_REVIEWER', '请选择已启用的指定验收人。');
  requireValue(!body.requiresReview || (body.reviewerId && (body.reviewerId !== body.ownerId || actors.some(a => a.id === body.ownerId && isProjectManager(a.role)))), 'INDEPENDENT_REVIEWER_REQUIRED', '关键成果必须指定验收人；普通成员不能验收自己负责的任务，项目负责人或管理员可说明依据后自审。');
  requireValue(body.parentId === null || (typeof body.parentId === 'string' && workspace.tasks.some(t => t.id === body.parentId)), 'INVALID_PARENT', '父任务不存在。');
  if (body.parentId) {
    const parent = workspace.tasks.find(t => t.id === body.parentId)!;
    requireValue(parent.id !== current?.id && parent.workstreamId === body.workstreamId, 'INVALID_PARENT', '父任务必须属于同一工作分组且不能选择自身。');
    let ancestor: ManagedTask | undefined = parent; const visited = new Set<string>();
    while (ancestor) { requireValue(!visited.has(ancestor.id) && ancestor.id !== current?.id, 'PARENT_CYCLE', '父子关系不能形成循环。'); visited.add(ancestor.id); ancestor = workspace.tasks.find(t => t.id === ancestor!.parentId); }
    const unchangedParent = current?.parentId === parent.id;
    if (!unchangedParent) {
      requireValue(parent.parentId === null && current?.taskKind !== 'summary', 'MAX_TASK_DEPTH', '任务最多两级，只能选择一级汇总任务；已有子任务的节点不能降为二级。');
      const eligibility = parentEligibility(parent);
      requireValue(eligibility.mode !== 'blocked', 'PARENT_UNAVAILABLE', eligibility.reason);
      if (current) requireValue(eligibility.mode === 'summary', 'PARENT_CONVERSION_REQUIRED', '请先通过新建子任务预览并确认转换，编辑任务不能隐式转换父任务。');
    }
  }
  if (current?.taskKind === 'summary') {
    requireValue(body.parentId === current.parentId, 'MAX_TASK_DEPTH', '汇总任务不能改为二级任务。');
    requireValue(body.workstreamId === current.workstreamId && body.effortHours === null && !body.requiresReview, 'PARENT_HAS_WORK', '父任务由子任务汇总，不能设置独立工时、关键成果或移动工作分组。');
  }
  return { title, description, workstreamId: String(body.workstreamId), parentId: body.parentId as string | null, ownerId: String(body.ownerId), priority: body.priority as TaskDraft['priority'], effortHours: body.effortHours as number | null,
    requiresReview: body.requiresReview, reviewerId: body.reviewerId as string | null, acceptanceCriteria: textValue(body.acceptanceCriteria, '验收标准', 3000), evidence: evidenceValue(body.evidence) };
}

function persist(db: Database.Database, projectId: string, task: ManagedTask, nodes: PlanNode[]) {
  const { id, wbs, workstreamId, title, owner, priority, status, progress, blocked, start, end, effortHours, parentEligibility: _eligibility, ...meta } = task;
  db.prepare('INSERT INTO task_meta VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET meta_json=excluded.meta_json').run(id, projectId, JSON.stringify({ ...meta, cancelled: status === 'cancelled' }));
  db.prepare('UPDATE homepage_tasks SET title=?, workstream_id=?, owner=?, initials=?, priority=?, status=?, progress=?, blocked=?, due=? WHERE id=? AND project_id=?')
    .run(title, workstreamId, owner, owner.slice(0, 1), priority, status === 'cancelled' ? 'todo' : status, progress, Number(blocked), end ?? '', id, projectId);
  const node = nodes.find(n => n.id === id)!;
  Object.assign(node, { title, description: meta.description, workstreamId, owner, parentId: meta.parentId ?? `group-${workstreamId}`, status: status === 'cancelled' ? 'todo' : status, progress, blocked, effortHours });
}
function event(task: ManagedTask, actor: TaskActor, action: string, message: string, now: Date) {
  task.events.push({ id: randomUUID(), taskId: task.id, actor: actor.name, action, text: ['complete', 'accept'].includes(action) ? `${message}；实际完成日：${task.actualEnd ?? '未知'}；完成时计划结束日：${task.completionPlanEnd ?? '未排期'}` : message, createdAt: now.toISOString() });
  task.version++; task.updatedAt = now.toISOString();
}

export function writeTask(db: Database.Database, projectId: string, operation: 'create' | 'update' | 'transition' | 'comment' | 'batch', taskId: string | undefined, body: unknown, actorId: unknown, key: unknown, now: Date, actorDisplayName?: string, accountId?: string | null) {
  requireValue(typeof key === 'string' && /^[\w:.-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。');
  const actors = readActors(db, projectId);
  const storedActor = actors.find(a => a.id === actorId);
  const actor = storedActor && actorDisplayName ? { ...storedActor, name: actorDisplayName } : storedActor;
  if (!actor || actor.role === 'viewer') throw new PlanError(403, 'TASK_FORBIDDEN', '当前身份为只读或无效，请使用有操作权限的项目成员身份。');
  const allowed = operation === 'create' ? [...draftKeys, 'expectedPlanVersion', 'confirmParentConversion', 'expectedParentVersion'] : operation === 'update' ? [...draftKeys, 'expectedVersion', 'expectedPlanVersion', 'workstreamPreviewToken'] : operation === 'transition' ? ['expectedVersion', 'expectedPlanVersion', 'reason', 'action', 'progress', 'evidence', 'submissionId'] : operation === 'comment' ? ['expectedVersion', 'expectedPlanVersion', 'text'] : ['expectedPlanVersion', 'items', 'patch', 'reason'];
  strict(body, [...allowed, 'expectedStructureVersion']);
  const hash = createHash('sha256').update(JSON.stringify({ operation, taskId, actorId, body })).digest('hex');
  return db.transaction(() => {
    // Classification permissions must be checked even when replaying a successful receipt.
    if (operation === 'update') {
      const current = db.prepare('SELECT workstream_id FROM homepage_tasks WHERE project_id=? AND id=?').get(projectId, taskId) as {workstream_id:string}|undefined;
      if ('workstreamPreviewToken' in body || (current && current.workstream_id !== body.workstreamId)) requireWorkstreamManager(db, projectId, actorId, accountId);
    }
    const receipt = db.prepare('SELECT request_hash, response_json FROM task_idempotency WHERE project_id=? AND request_key=?').get(projectId, key) as { request_hash: string; response_json: string } | undefined;
    if (receipt) { if (receipt.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请使用新的操作标识。'); return JSON.parse(receipt.response_json); }
    const simpleTransition = operation === 'transition' && ['start','progress'].includes(String(body.action));
    if ((operation === 'comment' || simpleTransition) && body.expectedStructureVersion !== undefined) {
      requireValue(Number.isInteger(body.expectedPlanVersion) && Number(body.expectedPlanVersion)>0 && Number.isInteger(body.expectedStructureVersion) && Number(body.expectedStructureVersion)>0,'VERSION_REQUIRED','请提供有效的计划和结构版本。');
      const stored = db.prepare('SELECT m.meta_json,h.* FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.project_id=? AND m.task_id=?').get(projectId,taskId) as (HomeRow & {meta_json:string})|undefined;
      if (!stored) throw new PlanError(404,'TASK_NOT_FOUND','未找到此任务。');
      const meta = JSON.parse(stored.meta_json), row = db.prepare('SELECT version FROM plan_projects WHERE project_id=?').get(projectId) as {version:number};
      const nodeRow = db.prepare("SELECT value FROM plan_projects,json_each(nodes_json) WHERE project_id=? AND json_extract(value,'$.id')=?").get(projectId,taskId) as {value:string}|undefined;
      if (!nodeRow) throw new PlanError(404,'TASK_NOT_FOUND','未找到此任务。');
      const node = JSON.parse(nodeRow.value) as PlanNode;
      const {cancelled,...fields} = meta;
      let task = {...fields,id:stored.id,wbs:node.wbs,workstreamId:stored.workstream_id,title:stored.title,owner:stored.owner,priority:stored.priority,status:cancelled?'cancelled':stored.status,progress:stored.progress,blocked:Boolean(stored.blocked),start:node.start,end:node.end,effortHours:node.effortHours} as ManagedTask;
      const container = meta.taskKind === 'summary' || Boolean(db.prepare("SELECT 1 FROM task_meta WHERE project_id=? AND json_extract(meta_json,'$.parentId')=? LIMIT 1").get(projectId,taskId));
      if (container && operation === 'comment') task = readTasks(db,projectId,'',now).tasks.find(t=>t.id===taskId)!;
      else { task.taskKind=container?'summary':'execution';task.isContainer=container;task.originalWork??=false;task.parentEligibility=parentEligibility(task); }
      if (simpleTransition) {
        const structure = db.prepare('SELECT version FROM plan_structure_versions WHERE project_id=?').get(projectId) as {version:number};
        if (body.expectedStructureVersion !== structure.version) throw new PlanError(409,'PLAN_VERSION_CONFLICT','任务结构或排期已更新，请保留内容并刷新核对。',{latestPlanVersion:row.version});
        taskVersion(task,body.expectedVersion);
        const action=String(body.action), previousProgress=task.progress; const reason=readOperationReason(body.reason,{domain:'task',action},1000);
        requireValue(!container,'SUMMARY_READ_ONLY','汇总任务不独立执行或验收，请操作二级执行任务。');
        canExecute(actor,task);mutable(task);
        if (action === 'start') { requireValue(task.status==='todo','INVALID_TRANSITION','仅未开始的执行任务可以开始。');task.status='in_progress';task.actualStart??=shanghaiDate(now); }
        else { requireValue(task.status==='in_progress','INVALID_TRANSITION','请先开始执行任务再更新进度。');requireValue(Number.isInteger(body.progress)&&Number(body.progress)>=0&&Number(body.progress)<100,'INVALID_PROGRESS','执行进度为 0–99%，完成请使用完成或验收操作。');task.progress=Number(body.progress); }
        event(task,actor,action,reason||taskOperationSummary(action,previousProgress,task.progress),now);task.parentEligibility=parentEligibility(task);
      } else event(task,actor,'comment',textValue(body.text,'评论',3000,true),now);
      // Only discussion or one execution task changes; the complete plan is not
      // materialized twice merely to return that task. SQLite still commits all
      // read models, events, jobs and the idempotency receipt atomically.
      db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify({...meta,...(simpleTransition?{actualStart:task.actualStart}:{}),events:task.events,version:task.version,updatedAt:task.updatedAt}),projectId,taskId);
      const planVersion=row.version+1;
      if (simpleTransition) {
        db.prepare('UPDATE homepage_tasks SET status=?,progress=? WHERE project_id=? AND id=?').run(task.status,task.progress,projectId,taskId);
      }
      // Execution status/progress are authoritative in homepage_tasks; readPlan
      // overlays them before rollups. Start/progress do not change the schedule.
      // Complete/reopen still use the full workspace path below.
      db.prepare('UPDATE plan_projects SET version=? WHERE project_id=?').run(planVersion,projectId);
      const milestoneTaskIds = reconcileMilestones(db, projectId, now, actor.name);
      const result={task,planVersion}; captureBusinessJobs(db,projectId,now,[task.id,...milestoneTaskIds]);
      db.prepare('INSERT INTO task_idempotency VALUES (?,?,?,?)').run(projectId,key,hash,JSON.stringify(result));return result;
    }
    const workspace = readTasks(db, projectId, '', now);
    requireValue(Number.isInteger(body.expectedPlanVersion) && Number(body.expectedPlanVersion) > 0, 'VERSION_REQUIRED', '请提供当前计划版本。');
    const taskScoped = ['update','transition','comment'].includes(operation) && body.expectedStructureVersion !== undefined;
    if (taskScoped) {
      requireValue(Number.isInteger(body.expectedStructureVersion) && Number(body.expectedStructureVersion)>0, 'VERSION_REQUIRED','请提供有效结构版本。');
      if (operation !== 'comment' && body.expectedStructureVersion !== workspace.structureVersion) throw new PlanError(409,'PLAN_VERSION_CONFLICT','任务结构或排期已更新，请保留内容并刷新核对。',{latestPlanVersion:workspace.planVersion});
    } else if (body.expectedPlanVersion !== workspace.planVersion) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '项目计划或任务已更新，请刷新并核对填写内容后重试。', { latestPlanVersion: workspace.planVersion });
    const { nodes, calendar } = projectPlan(db, projectId);
    syncPlanOrder(db,projectId,nodes);
    const getTask = (id: unknown) => { const task = workspace.tasks.find(t => t.id === id); if (!task) throw new PlanError(404, 'TASK_NOT_FOUND', '未找到此任务。'); return task; };
    // Activity diffs need only the explicitly mutated task(s), never the full project history.
    const activityIds = new Set<unknown>(operation === 'batch' && Array.isArray(body.items)
      ? body.items.map(item => item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined)
      : [taskId]);
    const activityBefore = workspace.tasks.filter(task => activityIds.has(task.id)).map(task => structuredClone(task));
    const activityInvalidatedMilestones: string[] = [];
    const activityMilestonesBefore = new Map(operation === 'transition' && body.action === 'reopen'
      ? readMilestoneRecords(db, projectId).filter(record => ['accepted','submitted'].includes(record.state)).map(record => [record.id,record.state] as const)
      : []);
    let changed: ManagedTask[] = []; let parentTask: ManagedTask | undefined; let reparentedTaskId: string | undefined;
    const classificationOnly = new Set<string>();
    let hasNormalEdit = false;
    if (operation === 'create') {
      const draft = validateDraft(body, workspace);
      const start = body.start ?? null; const end = body.end ?? null;
      requireValue((start === null && end === null) || (validDate(start) && validDate(end) && start >= workspace.project.start && end >= start && end <= '2099-12-31' && isWorkday(start, calendar) && isWorkday(end, calendar)), 'INVALID_DATES', '计划日期须同时填写或同时留空，开始不早于项目开始，结束不早于开始，并采用工作日。');
      requireValue(!start || !end || duration(String(start), String(end), calendar) <= 2600, 'DATE_LIMIT', '单项任务不能超过 2600 个工作日。');
      if (draft.parentId) {
        const parent = getTask(draft.parentId);
        if (parentEligibility(parent).mode === 'convert') {
          canManage(actor);
          requireValue(body.confirmParentConversion === true, 'PARENT_CONFIRMATION_REQUIRED', '请先预览并确认转为汇总任务，原执行内容将完整保留为二级任务。');
          taskVersion(parent, body.expectedParentVersion);
          const wrapperId = `task-${randomUUID()}`;
          parentTask = { ...parent, id: wrapperId, wbs: `${nodes.find(n => n.id === `group-${parent.workstreamId}`)!.wbs}.S${randomUUID().slice(0, 8)}`, taskKind: 'summary', originalWork: false, isContainer: true,
            parentId: null, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', reviewStatus: 'none', submissions: [], events: [],
            status: 'todo', progress: 0, start: null, end: null, effortHours: null, blocked: false, blockReason: '', actualStart: null, actualEnd: null, version: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() };
          const originalNode = nodes.find(n => n.id === parent.id)!;
          nodes.push({ ...originalNode, id: wrapperId, wbs: parentTask.wbs, parentId: `group-${parent.workstreamId}`, kind: 'task', start: null, end: null, durationDays: null, effortHours: null, progress: 0, status: 'todo', blocked: false });
          const position = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM homepage_tasks WHERE project_id=?').get(projectId) as { position: number }).position;
          db.prepare('INSERT INTO homepage_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(wrapperId, projectId, parent.title, parent.workstreamId, parent.owner, parent.owner.slice(0, 1), 'todo', parent.priority, '', 0, 0, position);
          parent.parentId = wrapperId; parent.originalWork = true; draft.parentId = wrapperId; reparentedTaskId = parent.id;
          parentTask.creatorId = actor.id; parentTask.creatorName = actor.name;
          event(parentTask, actor, 'create_summary', '确认转换，创建汇总父任务。', now);
          event(parent, actor, 'retain_original_work', '原执行任务完整保留，归入新汇总父任务。', now); changed.push(parentTask, parent);
        }
      }
      const id = `task-${randomUUID()}`; const sequence = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM homepage_tasks WHERE project_id=?').get(projectId) as { position: number }).position;
      const prefix = nodes.find(n => n.id === `group-${draft.workstreamId}`)!.wbs;
      const usedWbs = new Set([...nodes.map(n => n.wbs), ...(db.prepare("SELECT json_extract(snapshot_json,'$.task.wbs') AS wbs FROM task_recycle WHERE project_id=?").all(projectId) as {wbs:string}[]).map(r=>r.wbs)]);
      let number = sequence + 1; while (usedWbs.has(`${prefix}.T${number}`)) number++;
      const wbs = `${prefix}.T${number}`; const owner = actors.find(a => a.id === draft.ownerId)!.name;
      const task: ManagedTask = { ...draft, taskKind: 'execution', originalWork: false, id, wbs, owner, status: 'todo', progress: 0, blocked: false, blockReason: '', start: start as string | null, end: end as string | null, reviewStatus: 'none', actualStart: null, actualEnd: null, version: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), events: [], submissions: [] };
      nodes.push({ id, wbs, parentId: draft.parentId ?? `group-${draft.workstreamId}`, workstreamId: draft.workstreamId, kind: 'task', title: draft.title, description: draft.description, owner, color: workspace.workstreams.find(w => w.id === draft.workstreamId)!.color, status: 'todo', progress: 0, blocked: false, start: task.start, end: task.end, effortHours: draft.effortHours, durationDays: task.start && task.end ? duration(task.start, task.end, calendar) : null });
      db.prepare('INSERT INTO homepage_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, task.title, task.workstreamId, owner, owner.slice(0, 1), 'todo', task.priority, task.end ?? '', 0, 0, sequence);
      task.creatorId = actor.id; task.creatorName = actor.name;
      event(task, actor, 'create', '新建本地任务。', now); changed.unshift(task);
    } else if (operation === 'batch') {
      canManage(actor); const reason = readOperationReason(body.reason, { domain: 'task', action: 'batch' }, 500);
      requireValue(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 100, 'INVALID_BATCH', '每批请选择 1–100 个任务。');
      strict(body.patch, ['ownerId', 'priority']); const patch = body.patch;
      requireValue(Object.keys(patch).length > 0, 'EMPTY_BATCH', '请选择要修改的负责人或优先级。');
      if ('ownerId' in patch) requireValue(actors.some(a => a.id === patch.ownerId && a.assignable !== false && a.role !== 'viewer'), 'INVALID_OWNER', '请选择当前项目中可承担任务的成员。');
      if ('priority' in patch) requireValue(['P0', 'P1', 'P2'].includes(String(patch.priority)), 'INVALID_PRIORITY', '优先级无效。');
      const ids = new Set<string>();
      changed = body.items.map(item => { strict(item, ['id', 'expectedVersion']); const task = getTask(item.id); requireValue(!ids.has(task.id), 'DUPLICATE_TASK', '批量任务不能重复。'); ids.add(task.id); taskVersion(task, item.expectedVersion); requireValue(task.taskKind !== 'summary', 'SUMMARY_READ_ONLY', '汇总任务不参与批量修改，请只选择执行任务。'); mutable(task);
        if ('ownerId' in patch) { requireValue(!task.requiresReview || (patch.ownerId !== task.reviewerId || actors.some(a => a.id === patch.ownerId && isProjectManager(a.role))), 'INDEPENDENT_REVIEWER_REQUIRED', '普通成员不能兼任本人任务的验收人，请调整验收人后再变更负责人。'); task.ownerId = String(patch.ownerId); task.owner = actors.find(a => a.id === patch.ownerId)!.name; }
        if ('priority' in patch) task.priority = patch.priority as ManagedTask['priority']; event(task, actor, 'batch', reason, now); return task; });
    } else {
      const task = getTask(taskId); if (!(operation === 'comment' && taskScoped)) taskVersion(task, body.expectedVersion);
      if (operation === 'update') {
        canExecute(actor, task);
        requireValue(!('start' in body) && !('end' in body), 'DATES_USE_GANTT', '已有任务日期请在完整计划中预览并应用。');
        const moving = body.workstreamId !== task.workstreamId;
        if (!moving) mutable(task);
        if (moving) requireValue(body.parentId === task.parentId, 'WORKSTREAM_HIERARCHY_LOCKED', '调整工作分组时必须保留原任务层级。');
        const move = moving ? validateWorkstreamChange(db, workspace, task.id, body.workstreamId, body.workstreamPreviewToken, actor.id, accountId) : undefined;
        const locked = task.taskKind === 'summary' || task.status === 'done' || task.status === 'cancelled' || task.reviewStatus === 'submitted';
        const otherDifferences = draftKeys.filter(k => !['workstreamId','start','end'].includes(k)).some(k => body[k] !== task[k as keyof ManagedTask]);
        if (locked) requireValue(moving && !otherDifferences, 'TASK_IMMUTABLE', '汇总、已完成、已取消或待验收任务仅可调整工作分组，其他字段必须保持原值。');
        // Classification-only edits retain historical ownership/review data verbatim.
        // Ordinary edits continue to use all existing commitment validations.
        const draft = locked || (moving && !otherDifferences) ? undefined : validateDraft(body, workspace, task);
        if (!locked) mutable(task);
        if (draft) {
          if (!isProjectManager(actor.role)) for (const field of ['title', 'workstreamId', 'parentId', 'ownerId', 'priority', 'effortHours', 'requiresReview', 'reviewerId', 'acceptanceCriteria'] as const) {
            if (draft[field] !== task[field]) throw new PlanError(403, 'COMMITMENT_FORBIDDEN', '任务负责人可维护描述和成果；承诺字段由项目负责人或管理员修改。');
          }
          requireValue(!task.requiresReview || draft.requiresReview || !task.submissions.length, 'REVIEW_REQUIRED', '有验收历史的关键成果不能改为普通任务。');
          Object.assign(task, draft, { owner: actors.find(a => a.id === draft.ownerId)!.name }); event(task, actor, 'update', '更新任务内容。', now);
          hasNormalEdit = true;
          if (move) captureTaskActivity(db, projectId, actor, activityBefore, [task], operation);
        }
        if (move) {
          const moved = applyWorkstreamChange(db, workspace, nodes, move, actor, now);
          for (const item of moved) if (item.id !== task.id || !draft) classificationOnly.add(item.id);
          changed.push(...moved.filter(item => item.id !== task.id));
        }
      } else if (operation === 'comment') {
        event(task, actor, 'comment', textValue(body.text, '评论', 3000, true), now);
      } else {
        const action = String(body.action), previousProgress = task.progress; const reason = readOperationReason(body.reason, { domain: 'task', action, selfReview: actor.id === task.ownerId || actor.id === task.submissions.at(-1)?.submitterId }, 1000);
        requireValue(['start', 'complete', 'cancel', 'reopen', 'block', 'unblock', 'progress', 'submit', 'accept', 'reject'].includes(action), 'INVALID_ACTION', '不支持此状态操作。');
        const children = workspace.tasks.filter(t => t.parentId === task.id && t.status !== 'cancelled');
        if (task.taskKind === 'summary') {
          if (action === 'reopen' && task.status === 'cancelled') canManage(actor);
          else if (action !== 'cancel') throw new PlanError(422, 'SUMMARY_READ_ONLY', '汇总任务不独立执行或验收，请操作二级执行任务。');
        }
        if (action !== 'accept' && action !== 'reject') canExecute(actor, task);
        if (action !== 'reopen') mutableForAction(task, action);
        const ready = () => {
          requireValue(!task.blocked, 'TASK_BLOCKED', '任务仍有阻塞，请先解除阻塞。');
          requireValue(children.every(t => t.status === 'done'), 'CHILDREN_INCOMPLETE', '子任务尚未全部完成。');
          requireValue(workspace.dependencies.filter(e => e.successorId === task.id).every(e => workspace.tasks.find(t => t.id === e.predecessorId)?.status === 'done' || readMilestoneRecords(db, projectId).some(m => m.id === e.predecessorId && m.state === 'accepted' && Boolean(m.acceptedAt))), 'PREDECESSOR_INCOMPLETE', '前置任务尚未完成，请先处理依赖。');
        };
        if (action === 'start') { requireValue(task.status === 'todo' && !children.length, 'INVALID_TRANSITION', '仅未开始的执行任务可以开始。'); task.status = 'in_progress'; task.actualStart ??= shanghaiDate(now); }
        if (action === 'progress') { requireValue(!children.length && task.status === 'in_progress', 'INVALID_TRANSITION', '请先开始执行任务再更新进度。'); requireValue(Number.isInteger(body.progress) && Number(body.progress) >= 0 && Number(body.progress) < 100, 'INVALID_PROGRESS', '执行进度为 0–99%，完成请使用完成或验收操作。'); task.progress = Number(body.progress); }
        if (action === 'block' || action === 'unblock') { requireValue(!children.length, 'PARENT_HAS_WORK', '父任务由子任务汇总，请在执行子任务记录阻塞。'); task.blocked = action === 'block'; task.blockReason = task.blocked ? reason : ''; }
        if (action === 'complete') { requireValue(!task.requiresReview, 'REVIEW_REQUIRED', '关键成果须先提交，再由指定验收人、项目负责人或管理员验收。'); ready(); task.status = 'done'; task.progress = 100; task.actualEnd = shanghaiDate(now); task.completionPlanEnd = task.end; }
        if (action === 'cancel') { canManage(actor); requireValue(reason.length > 0, 'REASON_REQUIRED', '取消须填写原因。'); requireValue(!workspace.tasks.some(child => child.parentId === task.id) && !workspace.dependencies.some(e => e.predecessorId === task.id || e.successorId === task.id), 'TASK_REFERENCED', '此任务存在子任务（含已取消记录）或依赖，请先处理关联关系后取消。'); task.status = 'cancelled'; task.progress = 0; task.blocked = false; task.blockReason = ''; }
        if (action === 'reopen') {
          requireValue(['done', 'cancelled'].includes(task.status), 'INVALID_TRANSITION', '只有已完成或已取消任务可以重开。'); requireValue(reason.length > 0, 'REASON_REQUIRED', '重开须填写原因。'); if (task.taskKind !== 'summary') requireValue(Number.isInteger(body.progress) && Number(body.progress) >= 0 && Number(body.progress) < 100, 'INVALID_PROGRESS', '重开须填写 0–99% 的新进度。');
          const ensureActiveResponsibility = (candidate: ManagedTask) => {
            if (candidate.taskKind === 'summary') return;
            requireValue(actors.some(member => member.id === candidate.ownerId && member.assignable !== false && member.role !== 'viewer'), 'INACTIVE_TASK_RESPONSIBILITY', `任务「${candidate.title}」的负责人已停用或失去执行权限，请先恢复该成员及权限再重开。`);
            requireValue(!candidate.requiresReview || actors.some(member => member.id === candidate.reviewerId && member.assignable !== false && member.role !== 'viewer'), 'INACTIVE_TASK_RESPONSIBILITY', `任务「${candidate.title}」的验收人已停用或失去验收权限，请先恢复该成员及权限再重开。`);
          };
          ensureActiveResponsibility(task);
          const ancestors: ManagedTask[] = []; const ancestorIds = new Set<string>([task.id]); let parentId = task.parentId;
          while (parentId) {
            requireValue(!ancestorIds.has(parentId), 'PARENT_CYCLE', '任务层级存在循环，请先修复层级后再重开。'); ancestorIds.add(parentId);
            const parent = workspace.tasks.find(candidate => candidate.id === parentId);
            requireValue(parent, 'INVALID_PARENT', '上级任务不存在，请先恢复任务层级后再重开。');
            requireValue(parent.status !== 'cancelled', 'PARENT_CANCELLED', '上级任务已取消，请先从最上级恢复后再重开子任务。');
            ancestors.push(parent); parentId = parent.parentId;
          }
          if (task.taskKind === 'summary') {
            // Restoring a container only clears cancellation; reads derive its state from execution descendants.
            task.status = 'todo'; task.progress = 0;
          } else {
            task.status = 'in_progress'; task.progress = Number(body.progress); task.actualEnd = null; task.completionPlanEnd = null; task.reviewStatus = task.requiresReview ? 'needs_review' : 'none';
          }
          // Containers have no independent execution commitment. Clear an explicit prior
          // completion while their displayed status/progress continue to derive from leaves.
          for (const parent of ancestors.filter(parent => parent.status === 'done')) {
            parent.status = 'todo'; parent.progress = 0; parent.actualEnd = null; parent.completionPlanEnd = null;
            event(parent, actor, 'child_reopened', `下级任务重开，父级完成状态重新汇总：${task.title}；${reason}`, now); changed.push(parent);
          }
          const affected = new Set<string>(task.taskKind === 'summary' ? [] : [task.id]); let expanded = true;
          while (expanded) { expanded = false; for (const edge of workspace.dependencies) if (affected.has(edge.predecessorId) && !affected.has(edge.successorId)) { affected.add(edge.successorId); expanded = true; } }
          for (const other of workspace.tasks.filter(t => t.id !== task.id && affected.has(t.id) && t.requiresReview && (t.reviewStatus === 'accepted' || t.reviewStatus === 'submitted'))) { ensureActiveResponsibility(other); other.status = 'in_progress'; other.progress = Math.min(other.progress, 99); other.actualEnd = null; other.completionPlanEnd = null; other.reviewStatus = 'needs_review'; const pending = other.submissions.find(s => s.status === 'submitted'); if (pending) pending.status = 'invalidated'; event(other, actor, 'needs_review', `前置任务重开：${task.title}；${reason}`, now); changed.push(other); }
        }
        if (action === 'submit') {
          requireValue(task.requiresReview && task.status === 'in_progress', 'INVALID_TRANSITION', '只有进行中的关键成果可以提交验收。'); ready();
          if ('evidence' in body) task.evidence = evidenceValue(body.evidence);
          requireValue(task.evidence.length > 0 && task.acceptanceCriteria.trim().length > 0, 'EVIDENCE_REQUIRED', '提交前请补齐成果说明或链接及验收标准。');
          requireValue(task.reviewerId && (isProjectManager(actor.role) || (task.reviewerId !== actor.id && task.reviewerId !== task.ownerId)), 'SELF_REVIEW_FORBIDDEN', '普通成员不能兼任本人负责或提交成果的验收人；项目负责人或管理员可说明依据后自审。');
          task.submissions.push({ id: randomUUID(), taskId: task.id, version: task.version + 1, submitterId: actor.id, reviewerId: task.reviewerId, evidence: task.evidence,
            snapshot: { title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, ownerId: task.ownerId },
            status: 'submitted', comment: '', createdAt: now.toISOString(), reviewedAt: null }); task.reviewStatus = 'submitted';
        }
        if (action === 'accept' || action === 'reject') {
          const submission = task.submissions.at(-1);
          if (!submission || task.reviewStatus !== 'submitted' || submission.status !== 'submitted' || submission.id !== body.submissionId) throw new PlanError(409, 'SUBMISSION_CONFLICT', '本次提交已变化，请刷新后核对最新成果。');
          if (!canReviewTask(actor.role, actor.id, task.ownerId, submission.submitterId, submission.reviewerId)) throw new PlanError(403, 'SELF_REVIEW_FORBIDDEN', '仅指定验收人、项目负责人或管理员可验收；普通成员不能验收本人负责或提交的成果。');

          if (action === 'accept') { ready(); task.status = 'done'; task.progress = 100; task.actualEnd = shanghaiDate(now); task.completionPlanEnd = task.end; }
          else { task.status = 'in_progress'; task.actualEnd = null; task.completionPlanEnd = null; }
          submission.status = action === 'accept' ? 'accepted' : 'rejected'; submission.comment = reason; submission.reviewedAt = now.toISOString(); submission.reviewedById = actor.id; submission.selfReview = actor.id === task.ownerId || actor.id === submission.submitterId; task.reviewStatus = submission.status;
        }
        event(task, actor, action, reason || taskOperationSummary(action, previousProgress, task.progress), now);
      }
      changed.unshift(task);
    }
    if (!classificationOnly.size || hasNormalEdit) for (const summary of workspace.tasks.filter(task => task.taskKind === 'summary')) db.prepare("UPDATE task_meta SET meta_json=json_set(meta_json, '$.taskKind', 'summary') WHERE task_id=?").run(summary.id);
    for (const task of changed) if (!classificationOnly.has(task.id)) persist(db, projectId, task, nodes);
    const planVersion = workspace.planVersion + 1;
    db.prepare('UPDATE plan_projects SET version=?, nodes_json=? WHERE project_id=?').run(planVersion, JSON.stringify(nodes), projectId);
    syncPlanOrder(db,projectId,nodes,parentTask && reparentedTaskId ? {originalId:reparentedTaskId,wrapperId:parentTask.id}:undefined);
    const milestoneTaskIds = classificationOnly.size && !hasNormalEdit ? [] : reconcileMilestones(db, projectId, now, actor.name);
    if (activityMilestonesBefore.size) {
      for (const record of readMilestoneRecords(db, projectId)) {
        const beforeState = activityMilestonesBefore.get(record.id);
        if (beforeState && beforeState !== record.state && ['draft','needs_review'].includes(record.state)) activityInvalidatedMilestones.push(record.title);
      }
      // Reconciliation may propagate through milestone criteria as well as schedule
      // dependencies. Include those additional task targets in the root reopen summary.
      for (const id of milestoneTaskIds) {
        if (changed.some(task => task.id === id)) continue;
        const target = workspace.tasks.find(task => task.id === id);
        if (target) activityInvalidatedMilestones.push(target.title);
      }
    }
    // Ordinary execution transitions keep identity, hierarchy and schedule unchanged.
    // A milestone cascade can change the requested task again; use authoritative
    // readback in that exceptional case and for containers or structural changes.
    const executionTransition = operation === 'transition' && changed[0]?.taskKind === 'execution' && !milestoneTaskIds.includes(changed[0].id);
    const updated = operation === 'batch' || executionTransition ? undefined : readTasks(db, projectId, '', now);
    if (executionTransition) changed[0]!.parentEligibility = parentEligibility(changed[0]!);
    const result = operation === 'batch' ? { affectedCount: changed.length, planVersion } : { task: executionTransition ? changed[0]! : updated!.tasks.find(task => task.id === changed[0]!.id)!, planVersion, ...(parentTask ? { parentTask: updated!.tasks.find(task => task.id === parentTask!.id), reparentedTaskId } : {}) };
    captureTaskActivity(db, projectId, actor, activityBefore, changed, operation, activityInvalidatedMilestones);
    captureBusinessJobs(db, projectId, now, [...new Set([...changed.map(task=>task.id),...milestoneTaskIds])]);
    db.prepare('INSERT INTO task_idempotency VALUES (?,?,?,?)').run(projectId, key, hash, JSON.stringify(result)); return result;
  }).immediate();
}

function mutableForAction(task: ManagedTask, action: string) {
  if (action === 'accept' || action === 'reject') { requireValue(task.status === 'in_progress', 'INVALID_TRANSITION', '当前任务不可验收。'); return; }
  mutable(task);
}
