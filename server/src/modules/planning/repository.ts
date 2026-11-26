import { isExistingDatabase } from '../../db/lifecycle.js';
import { recordActivity } from '../activities/repository.js';
import { activityChanges } from '../activities/hooks.js';
import { readMilestoneRecords } from '../milestones/store.js';
import { assertMilestoneAcceptanceGraph } from '../milestones/dependencies.js';
import { readActors, readPeople } from '../settings/store.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { initializePlanOrder, readPlanOrder } from './order.js';
import { readRevision } from '../../read-revision.js';
import { projectIsDemo, projectSourceLabel } from '../projects/context.js';
import { captureBusinessJobs } from '../../job-integration.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BaselinePublishRequest, PlanBaseline, PlanDependency, PlanEditRequest, PlanHistory, PlanNode, PlanPreview, PlanningCalendar, ProjectPlan } from '../../../../shared/src/planning.js';
import { readProjectOverview } from '../overview/repository.js';
import { addWorkdays, defaultCalendar, duration, isWorkday, normalizeWorkday, validDate } from './calendar.js';
import { affectedDependencyIds, analyzePlan, createPreview, isLeaf, validateDependencies } from './scheduler.js';
import { PlanError, requireValue } from './errors.js';

type PlanRow = { version: number; nodes_json: string; dependencies_json: string; calendar_json: string };
type JsonRow = { snapshot_json: string };

/** Own migration history leaves the homepage's user_version and existing records intact. */
export function initializePlanning(database: Database.Database) {
  if (isExistingDatabase(database)) return;
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS plan_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`);
    const version = database.prepare('SELECT max(version) AS version FROM plan_schema_migrations').get() as { version: number | null };
    if ((version.version ?? 0) > 1) throw new Error('Unsupported planning database version');
    if (version.version === 1) return;
    database.exec(`
      CREATE TABLE plan_projects (
        project_id TEXT PRIMARY KEY REFERENCES homepage_projects(id), version INTEGER NOT NULL DEFAULT 1,
        nodes_json TEXT NOT NULL CHECK(json_valid(nodes_json)), dependencies_json TEXT NOT NULL CHECK(json_valid(dependencies_json)),
        calendar_json TEXT NOT NULL CHECK(json_valid(calendar_json))
      );
      CREATE TABLE plan_baselines (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES plan_projects(project_id), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER plan_baselines_no_update BEFORE UPDATE ON plan_baselines BEGIN SELECT RAISE(ABORT, 'Baseline snapshots are immutable'); END;
      CREATE TRIGGER plan_baselines_no_delete BEFORE DELETE ON plan_baselines BEGIN SELECT RAISE(ABORT, 'Baseline snapshots are immutable'); END;
      CREATE TABLE plan_previews (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES plan_projects(project_id), base_version INTEGER NOT NULL,
        expires_at TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), applied INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE plan_history (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES plan_projects(project_id), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at TEXT NOT NULL
      );
      CREATE TABLE plan_idempotency (
        project_id TEXT NOT NULL REFERENCES plan_projects(project_id), request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK(json_valid(response_json)), PRIMARY KEY(project_id, request_key)
      );
      CREATE INDEX plan_previews_project_expiry ON plan_previews(project_id, expires_at);
      CREATE INDEX plan_baselines_project ON plan_baselines(project_id, created_at);
      CREATE INDEX plan_history_project ON plan_history(project_id, created_at);
    `);
    database.prepare('INSERT INTO plan_schema_migrations VALUES (1, ?)').run(new Date().toISOString());
  })();
  database.transaction(() => {
    for (const project of database.prepare('SELECT id FROM homepage_projects').all() as { id: string }[]) {
      if (database.prepare('SELECT project_id FROM plan_projects WHERE project_id = ?').get(project.id)) continue;
      const overview = readProjectOverview(database, project.id)!;
      const nodes: PlanNode[] = [];
      for (const [index, stream] of overview.workstreams.entries()) {
        const parentId = `group-${stream.id}`;
        nodes.push({ id: parentId, parentId: null, workstreamId: stream.id, wbs: String(index + 1), kind: 'group', title: stream.name, description: stream.description, owner: stream.owner, color: stream.color, status: 'in_progress', start: null, end: null, durationDays: null, effortHours: null, progress: 0, blocked: false });
        const tasks = overview.tasks.filter(task => task.workstreamId === stream.id);
        for (const [position, task] of tasks.entries()) {
          const end = normalizeWorkday(task.due);
          const start = [overview.project.start, addWorkdays(end, -(position % 2 + 2))].sort().at(-1)!;
          nodes.push({ id: task.id, parentId, workstreamId: stream.id, wbs: `${index + 1}.${position + 1}`, kind: 'task', title: task.title, description: 'DEMO · 虚构执行任务、负责人、工时与日期，用于完整计划评审。', owner: task.owner, color: stream.color, status: task.status, start, end, durationDays: duration(start, end), effortHours: duration(start, end) * 8, progress: task.progress, blocked: task.blocked });
        }
        for (const [position, milestone] of overview.milestones.filter(m => m.workstreamId === stream.id).entries()) {
          const date = normalizeWorkday(milestone.date);
          nodes.push({ id: milestone.id, parentId, workstreamId: stream.id, wbs: `${index + 1}.M${position + 1}`, kind: 'milestone', title: milestone.title, description: milestone.description, owner: stream.owner, color: stream.color, status: milestone.status === 'upcoming' ? 'todo' : milestone.status, start: date, end: date, durationDays: 0, effortHours: null, progress: milestone.status === 'done' ? 100 : 0, blocked: false });
        }
      }
      nodes.push({ id: 'gap-operations', parentId: 'group-operations', workstreamId: 'operations', wbs: '6.9', kind: 'gap', title: '运营范围待细化', description: 'DEMO · 尚未定义交付内容的范围缺口，不计入 48 个执行任务；必须细化后才能排期，发布基线需明确排除理由。', owner: '', color: 'slate', status: 'todo', start: null, end: null, durationDays: null, effortHours: null, progress: 0, blocked: false });
      const dependencies: PlanDependency[] = [];
      for (const stream of overview.workstreams) {
        const active = nodes.filter(node => node.kind === 'task' && node.workstreamId === stream.id && node.status !== 'done');
        if (active.length > 1) dependencies.push({ predecessorId: active[0]!.id, successorId: active[1]!.id, type: 'FS', lagDays: 0 });
        // First unfinished task is before each existing milestone, preserving the homepage's review window.
        for (const milestone of nodes.filter(node => node.kind === 'milestone' && node.workstreamId === stream.id && node.status !== 'done')) {
          if (active[0]) dependencies.push({ predecessorId: active[0].id, successorId: milestone.id, type: 'FS', lagDays: 0 });
        }
      }
      const byId = new Map(nodes.map(node => [node.id, node]));
      for (const id of validateDependencies(nodes, dependencies)) {
        const node = byId.get(id)!;
        if (node.status === 'done') continue;
        for (const edge of dependencies.filter(edge => edge.successorId === id)) {
          const minimum = addWorkdays(byId.get(edge.predecessorId)!.end!, edge.lagDays + (node.kind === 'milestone' ? 0 : 1));
          if (node.start! < minimum) { node.start = minimum; node.end = addWorkdays(minimum, Math.max(0, node.durationDays! - 1)); }
        }
      }
      database.prepare('INSERT INTO plan_projects (project_id, nodes_json, dependencies_json, calendar_json) VALUES (?, ?, ?, ?)').run(project.id, JSON.stringify(nodes), JSON.stringify(dependencies), JSON.stringify(defaultCalendar));
      const baseline: PlanBaseline = { id: `baseline-initial-${project.id}`, name: '初始计划（示例）', createdAt: '2026-09-21T00:00:00.000Z', actor: '本地 DEMO', reason: '虚构初始对比快照，仅供 UI 评审；运营范围待细化，因此明确排除范围缺口。', entries: nodes.filter(isLeaf).map(node => ({ taskId: node.id, start: node.start, end: node.end, effortHours: node.effortHours, owner: node.owner })), dependencies, calendar: structuredClone(defaultCalendar), excludedIds: ['gap-operations'], demo: true };
      database.prepare('INSERT INTO plan_baselines VALUES (?, ?, ?, ?)').run(baseline.id, project.id, JSON.stringify(baseline), baseline.createdAt);
      syncOverview(database, project.id, nodes);
    }
  })();
  initializePlanOrder(database);
}

function syncOverview(database: Database.Database, projectId: string, nodes: PlanNode[]) {
  const update = database.prepare('UPDATE homepage_tasks SET due = ? WHERE id = ? AND project_id = ?');
  for (const node of nodes) if (node.kind === 'task' && node.end) update.run(node.end, node.id, projectId);
  const row = database.prepare('SELECT snapshot_json FROM homepage_projects WHERE id = ?').get(projectId) as JsonRow;
  const snapshot = JSON.parse(row.snapshot_json);
  for (const milestone of snapshot.milestones) {
    const node = nodes.find(node => node.id === milestone.id);
    if (node?.end) milestone.date = node.end;
  }
  for (const stream of snapshot.workstreams) {
    const children = nodes.filter(node => node.workstreamId === stream.id && isLeaf(node));
    const starts = children.flatMap(node => node.start ? [node.start] : []).sort();
    const ends = children.flatMap(node => node.end ? [node.end] : []).sort();
    if (starts.length) { stream.start = starts[0]; stream.end = ends.at(-1); }
  }
  snapshot.project.isDemo = projectIsDemo(snapshot.project, projectId);
  snapshot.mode = snapshot.project.isDemo ? 'demo' : 'standard';
  snapshot.project.sourceLabel = projectSourceLabel(snapshot.project.isDemo);
  database.prepare('UPDATE homepage_projects SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), projectId);
}

function updateGroups(nodes: PlanNode[], calendar: PlanningCalendar) {
  for (const node of nodes.filter(node => node.kind === 'group')) {
    const descendants = (parentId: string, seen = new Set<string>()): PlanNode[] => {
      if (seen.has(parentId)) return []; seen.add(parentId);
      return nodes.filter(child => child.parentId === parentId).flatMap(child => isLeaf(child) ? [child] : descendants(child.id, seen));
    };
    const children = descendants(node.id);
    node.start = children.flatMap(child => child.start ? [child.start] : []).sort()[0] ?? null;
    node.end = children.flatMap(child => child.end ? [child.end] : []).sort().at(-1) ?? null;
    node.durationDays = node.start && node.end ? duration(node.start, node.end, calendar) : null;
    node.effortHours = children.some(child => child.effortHours !== null) ? children.reduce((sum, child) => sum + (child.effortHours ?? 0), 0) : null;
    const tasks = children.filter(child => child.kind === 'task');
    node.blocked = tasks.some(task => task.blocked);
    node.progress = tasks.length ? Math.round(tasks.reduce((sum, child) => sum + child.progress, 0) / tasks.length) : 0;
    node.status = tasks.length && tasks.every(child => child.status === 'done') ? 'done' : tasks.some(child => child.status !== 'todo') ? 'in_progress' : 'todo';
  }
}
function computePlan(database: Database.Database, projectId: string, writeToken: string, now = new Date()): ProjectPlan {
  const row = database.prepare('SELECT * FROM plan_projects WHERE project_id = ?').get(projectId) as PlanRow | undefined;
  const overview = readProjectOverview(database, projectId, now);
  if (!row || !overview) throw new PlanError(404, 'PROJECT_NOT_FOUND', '未找到此项目。');
  const calendar = JSON.parse(row.calendar_json) as PlanningCalendar;
  let nodes = JSON.parse(row.nodes_json) as PlanNode[];
  const hasTaskMeta = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_meta'").get();
  if (hasTaskMeta) {
    const cancelled = new Set((database.prepare("SELECT task_id FROM task_meta WHERE project_id = ? AND json_extract(meta_json, '$.cancelled') = 1").all(projectId) as { task_id: string }[]).map(row => row.task_id));
    const summaries = new Set((database.prepare("SELECT task_id FROM task_meta WHERE project_id = ? AND json_extract(meta_json, '$.taskKind') = 'summary' UNION SELECT json_extract(meta_json, '$.parentId') AS task_id FROM task_meta WHERE project_id = ?").all(projectId, projectId) as { task_id: string }[]).map(row => row.task_id));
    nodes = nodes.filter(node => !cancelled.has(node.id));
    // Task containers aggregate their executable children; they do not create a second commitment.
    const parents = new Set(nodes.map(node => node.parentId));
    for (const node of nodes) if (node.kind === 'task') {
      node.taskKind = parents.has(node.id) || summaries.has(node.id) ? 'summary' : 'execution';
      if (node.taskKind === 'summary') node.kind = 'group';
    }
  }
  const nodeById = new Map(nodes.map(node => [node.id,node]));
  for (const task of overview.tasks) {
    const node = nodeById.get(task.id);
    if (node) { node.status = task.status; node.progress = task.progress; node.blocked = task.blocked; }
  }
  const milestones = new Map(readMilestoneRecords(database, projectId).map(record => [record.id, record]));
  const people = readPeople(database, projectId, [...milestones.values()].map(record => record.ownerId));
  for (const node of nodes.filter(node => node.kind === 'milestone')) {
    const record = milestones.get(node.id);
    if (!record) continue;
    node.milestoneState = record.state; node.acceptedAt = record.acceptedAt;
    node.ownerId = record.ownerId; node.reviewerId = record.reviewerId;
    node.owner = people.find(person => person.id === record.ownerId)?.name ?? '';
    node.status = record.state === 'accepted' && record.acceptedAt ? 'done' : ['submitted','needs_review','legacy_achieved','rejected'].includes(record.state) ? 'review' : 'todo';
    node.progress = node.status === 'done' ? 100 : 0;
  }
  // Calendar edits preserve commitments; duration is a current-calendar projection.
  for (const node of nodes) if (node.kind === 'task' && node.durationDays !== null && Number.isFinite(node.durationDays) && node.durationDays > 0 && validDate(node.start) && validDate(node.end) && node.start <= node.end) {
    node.durationDays = duration(node.start, node.end, calendar);
  }
  updateGroups(nodes, calendar);
  const dependencies = JSON.parse(row.dependencies_json) as PlanDependency[];
  const baselines = (database.prepare('SELECT snapshot_json FROM plan_baselines WHERE project_id = ? ORDER BY rowid').all(projectId) as JsonRow[]).map(row => JSON.parse(row.snapshot_json) as PlanBaseline);
  const history = (database.prepare('SELECT snapshot_json FROM plan_history WHERE project_id = ? ORDER BY rowid DESC LIMIT 100').all(projectId) as JsonRow[]).map(row => JSON.parse(row.snapshot_json) as PlanHistory);
  const project = { isDemo: overview.project.isDemo, id: overview.project.id, name: overview.project.name, start: overview.project.start, end: overview.project.end, asOf: overview.project.asOf };
  return { ...readPlanOrder(database,projectId,nodes), mode: overview.mode, project, planVersion: row.version, writeToken, calendar, nodes, dependencies, baselines, history, ...analyzePlan({ nodes, dependencies, calendar, baselines, project }) };
}

const planCache = new WeakMap<Database.Database, Map<string,{revision:string;json:string}>>();
export function readPlan(database: Database.Database, projectId: string, writeToken: string, now = new Date()): ProjectPlan {
  if (database.inTransaction) return computePlan(database,projectId,writeToken,now);
  let cache = planCache.get(database); if (!cache) { cache = new Map(); planCache.set(database,cache); }
  const revision = readRevision(database,projectId,now);
  let entry = cache.get(projectId);
  if (!entry || entry.revision !== revision) {
    entry = {revision,json:JSON.stringify(computePlan(database,projectId,'',now))};
    if (cache.size >= 5 && !cache.has(projectId)) cache.delete(cache.keys().next().value!);
    cache.set(projectId,entry);
  }
  // Preview services edit their local plan; cached state must never escape by reference.
  return {...JSON.parse(entry.json) as ProjectPlan,writeToken};
}

function checkVersion(actual: number, expected: unknown) {
  requireValue(Number.isInteger(expected) && Number(expected) > 0, 'VERSION_REQUIRED', '请提供有效的计划版本。');
  if (expected !== actual) throw new PlanError(409, 'PLAN_VERSION_CONFLICT', '计划已更新，请刷新后重新预览。', { latestPlanVersion: actual });
}
export function previewSchedule(database: Database.Database, projectId: string, request: PlanEditRequest, now: Date): PlanPreview {
  return database.transaction(() => {
    const plan = readPlan(database, projectId, '', now);
    checkVersion(plan.planVersion, request?.expectedPlanVersion);
    const snapshot = createPreview(plan, request, randomUUID(), now);
    assertMilestoneAcceptanceGraph(readMilestoneRecords(database,projectId),snapshot.preview.dependencies);
    const affectedIds = snapshot.preview.calculation === 'relationships_only'
      ? affectedDependencyIds(snapshot.preview.dependencies, [request.dependencyTargetId!])
      : snapshot.preview.changes.map(change => change.taskId);
    assertNoPendingReviewChanges(database, projectId, affectedIds, snapshot.preview.dependencyChanged ? request.dependencyTargetId : undefined);
    database.prepare('DELETE FROM plan_previews WHERE applied = 0 AND expires_at < ?').run(now.toISOString());
    database.prepare('INSERT INTO plan_previews (id, project_id, base_version, expires_at, snapshot_json) VALUES (?, ?, ?, ?, ?)').run(snapshot.preview.id, projectId, plan.planVersion, snapshot.preview.expiresAt, JSON.stringify(snapshot));
    return snapshot.preview;
  })();
}
function appendHistory(database: Database.Database, projectId: string, action: string, reason: string, affectedCount: number, now: Date, actorName = '项目操作者') {
  const item: PlanHistory = { id: randomUUID(), action, reason, affectedCount, actor: actorName, createdAt: now.toISOString() };
  database.prepare('INSERT INTO plan_history VALUES (?, ?, ?, ?)').run(item.id, projectId, JSON.stringify(item), item.createdAt);
  return item.id;
}
function assertNoPendingReviewChanges(database: Database.Database, projectId: string, changedIds: string[], dependencyTargetId?: string) {
  for (const milestone of readMilestoneRecords(database, projectId)) {
    if (!changedIds.includes(milestone.id) && milestone.id !== dependencyTargetId) continue;
    requireValue(milestone.state !== 'submitted', 'REVIEW_PENDING', '里程碑已提交验收，请先撤回或退回，再调整日期或依赖。');
    requireValue(milestone.state !== 'cancelled', 'MILESTONE_CANCELLED', '里程碑已取消，请先恢复再调整排期。');
  }
  if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_meta'").get()) return;
  const protectedIds = (database.prepare("SELECT task_id FROM task_meta WHERE project_id = ? AND json_extract(meta_json, '$.reviewStatus') = 'submitted'").all(projectId) as { task_id: string }[]).map(row => row.task_id);
  requireValue(!protectedIds.some(id => changedIds.includes(id) || id === dependencyTargetId), 'REVIEW_PENDING', '受影响任务已提交验收；请先由验收人退回，再调整日期或前置依赖。');
}
export function applySchedule(database: Database.Database, projectId: string, request: { previewId: string; expectedPlanVersion: number }, key: string | undefined, now: Date, actorName = '项目操作者', actorId: string | null = null) {
  requireValue(typeof key === 'string' && /^[\w:.-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。');
  requireValue(request && typeof request.previewId === 'string' && request.previewId.length <= 100, 'INVALID_PREVIEW', '请先生成计划调整预览。');
  const hash = createHash('sha256').update(JSON.stringify({ previewId: request.previewId, expectedPlanVersion: request.expectedPlanVersion })).digest('hex');
  return database.transaction(() => {
    const previous = database.prepare('SELECT request_hash, response_json FROM plan_idempotency WHERE project_id = ? AND request_key = ?').get(projectId, key) as { request_hash: string; response_json: string } | undefined;
    if (previous) {
      if (previous.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请重新预览。');
      return JSON.parse(previous.response_json) as { planVersion: number; affectedCount: number };
    }
    const plan = readPlan(database, projectId, '', now);
    checkVersion(plan.planVersion, request.expectedPlanVersion);
    const row = database.prepare('SELECT * FROM plan_previews WHERE id = ? AND project_id = ?').get(request.previewId, projectId) as { snapshot_json: string; base_version: number; expires_at: string; applied: number } | undefined;
    if (!row) throw new PlanError(409, 'PREVIEW_NOT_FOUND', '预览不存在或已过期，请重新预览。');
    if (row.applied) throw new PlanError(409, 'PREVIEW_ALREADY_APPLIED', '此预览已经应用，请刷新当前计划。');
    if (row.expires_at <= now.toISOString()) throw new PlanError(409, 'PREVIEW_EXPIRED', '预览已超过 30 分钟，请重新预览。');
    checkVersion(plan.planVersion, row.base_version);
    const snapshot = JSON.parse(row.snapshot_json) as { nodes: PlanNode[]; preview: PlanPreview };
    requireValue(snapshot.preview.canApply, 'PREVIEW_NOT_APPLICABLE', '请先解决预览中的日期或依赖问题。', snapshot.preview.issues);
    assertMilestoneAcceptanceGraph(readMilestoneRecords(database,projectId),snapshot.preview.dependencies);
    const changedIncoming = snapshot.preview.dependencies.filter(edge => !plan.dependencies.some(original => JSON.stringify(original) === JSON.stringify(edge))).map(edge => edge.successorId);
    changedIncoming.push(...plan.dependencies.filter(edge => !snapshot.preview.dependencies.some(proposed => JSON.stringify(proposed) === JSON.stringify(edge))).map(edge => edge.successorId));
    const relationshipsOnly = snapshot.preview.calculation === 'relationships_only';
    const affectedIds = relationshipsOnly ? affectedDependencyIds(snapshot.preview.dependencies, changedIncoming) : snapshot.preview.changes.map(change => change.taskId);
    assertNoPendingReviewChanges(database, projectId, [...affectedIds, ...changedIncoming]);
    // Revalidate live state as well as the plan version: a stale preview must not
    // restore deleted/cancelled records or bypass newly submitted/completed locks.
    validateDependencies(plan.nodes, snapshot.preview.dependencies);
    if (relationshipsOnly) {
      requireValue(snapshot.preview.changes.length === 0 && new Set(changedIncoming).size === 1, 'INVALID_RELATIONSHIP_EDIT', '关系预览只能修改一个目标的前置依赖。');
      const targetId = changedIncoming[0]!;
      const current = createPreview(plan, { calculation: 'relationships_only', expectedPlanVersion: plan.planVersion, changes: [], mode: 'push_successors',
        dependencyTargetId: targetId, incomingDependencies: snapshot.preview.dependencies.filter(edge => edge.successorId === targetId).map(edge => ({ predecessorId: edge.predecessorId, lagDays: edge.lagDays })),
      }, snapshot.preview.id, now);
      requireValue(current.preview.canApply, 'PREVIEW_NOT_APPLICABLE', '依赖或任务状态已变化，请重新预览。', current.preview.issues);
    }
    for (const change of snapshot.preview.changes) {
      requireValue(plan.nodes.find(node => node.id === change.taskId)?.status !== 'done', 'DONE_IMMUTABLE', '受影响任务已完成，请重新预览。');
    }
    const incoming = (edges: PlanDependency[], id: string) => JSON.stringify(edges.filter(edge => edge.successorId === id).map(edge => `${edge.predecessorId}:${edge.type}:${edge.lagDays}`).sort());
    for (const completed of plan.nodes.filter(node => node.status === 'done' && isLeaf(node))) {
      const proposed = snapshot.nodes.find(node => node.id === completed.id);
      requireValue(proposed && proposed.start === completed.start && proposed.end === completed.end
        && incoming(plan.dependencies, completed.id) === incoming(snapshot.preview.dependencies, completed.id),
      'DONE_IMMUTABLE', '受影响任务已完成，不能改写其日期或前置依赖，请重新预览。');
    }
    const response = { planVersion: plan.planVersion + 1, affectedCount: relationshipsOnly ? new Set(changedIncoming).size : snapshot.preview.changes.length };
    const persisted = JSON.parse((database.prepare('SELECT nodes_json FROM plan_projects WHERE project_id = ?').get(projectId) as { nodes_json: string }).nodes_json) as PlanNode[];
    const dateChanged = new Set(snapshot.preview.changes.map(change => change.taskId));
    // Keep cancelled task records available for reopening. Read-time task containers retain their stored task identity.
    const storedNodes = relationshipsOnly ? persisted : snapshot.nodes.map(node => {
      const original = persisted.find(original => original.id === node.id);
      if (node.kind === 'group' && original?.kind === 'task') return original;
      // Read-time calendar projections must not overwrite unrelated stored durations.
      // A temporary holiday-only interval projects zero, but must recover when the
      // calendar is restored; actual stored zero remains an invalid source input.
      if (node.kind === 'task' && original?.kind === 'task' && !dateChanged.has(node.id)) return { ...node, durationDays: original.durationDays };
      return node;
    });
    if (!relationshipsOnly) storedNodes.push(...persisted.filter(node => !snapshot.nodes.some(active => active.id === node.id)));
    if (relationshipsOnly) {
      database.prepare('UPDATE plan_projects SET version = ?, dependencies_json = ? WHERE project_id = ?').run(response.planVersion, JSON.stringify(snapshot.preview.dependencies), projectId);
    } else {
      database.prepare('UPDATE plan_projects SET version = ?, nodes_json = ?, dependencies_json = ? WHERE project_id = ?').run(response.planVersion, JSON.stringify(storedNodes), JSON.stringify(snapshot.preview.dependencies), projectId);
      syncOverview(database, projectId, snapshot.nodes);
    }
    database.prepare('UPDATE plan_previews SET applied = 1 WHERE id = ?').run(request.previewId);
    const activityHistoryId = appendHistory(database, projectId, '应用计划调整', snapshot.preview.reason, response.affectedCount, now, actorName);
    const activityItems = storedNodes.flatMap(node => {
      const original = persisted.find(item => item.id === node.id);
      if (!original || !['task','milestone'].includes(original.kind)) return [];
      const changes = activityChanges(original, node, ['start','end']);
      const dependencyChanges = activityChanges({dependencies:incoming(plan.dependencies,node.id)}, {dependencies:incoming(snapshot.preview.dependencies,node.id)}, ['dependencies']);
      changes.push(...dependencyChanges);
      return changes.length ? [{target:{kind:node.kind,id:node.id,name:node.title},summary:`调整计划「${node.title}」`,changes}] : [];
    });
    if (activityItems.length) recordActivity(database,{projectId,sourceKey:`schedule:${key}`,type:'plan.schedule',category:'plan',actor:{id:actorId,name:actorName},occurredAt:now.toISOString(),target:{kind:'plan_history',id:activityHistoryId,name:'计划调整记录'},summary:'调整项目计划',items:activityItems});
    captureBusinessJobs(database, projectId, now);
    database.prepare('INSERT INTO plan_idempotency VALUES (?, ?, ?, ?)').run(projectId, key, hash, JSON.stringify(response));
    return response;
  })();
}
export function publishBaseline(database: Database.Database, projectId: string, request: BaselinePublishRequest, now: Date, actorName = '项目操作者', actorId: string | null = null): PlanBaseline {
  return database.transaction(() => {
    const plan = readPlan(database, projectId, '', now);
    requireValue(request && Number.isInteger(request.expectedPlanVersion) && request.expectedPlanVersion > 0, 'VERSION_REQUIRED', '请提供有效的计划版本。');
    requireValue(request.calendarConfirmed === true, 'CALENDAR_CONFIRMATION_REQUIRED', '发布前请确认项目日历。');
    requireValue(typeof request.name === 'string' && request.name.trim().length > 0 && request.name.length <= 80, 'BASELINE_NAME_REQUIRED', '请填写 1–80 字基线名称。');
    requireValue(typeof request.reason === 'string' && request.reason.trim().length > 0 && request.reason.length <= 500, 'REASON_REQUIRED', '请填写 1–500 字发布原因。');
    requireValue(Array.isArray(request.excludedIds) && request.excludedIds.length <= plan.nodes.length && request.excludedIds.every(id => typeof id === 'string'), 'INVALID_EXCLUSIONS', '请逐项确认排除的范围缺口。');
    const gaps = plan.nodes.filter(node => node.kind === 'gap');
    requireValue(new Set(request.excludedIds).size === request.excludedIds.length && request.excludedIds.every(id => gaps.some(gap => gap.id === id)) && gaps.every(gap => request.excludedIds.includes(gap.id)), 'INCOMPLETE_SCOPE', '未排期范围缺口必须明确排除；不能排除已排期执行任务。');
    requireValue(!gaps.length || (typeof request.exclusionReason === 'string' && request.exclusionReason.trim().length > 0 && request.exclusionReason.length <= 500), 'EXCLUSION_REASON_REQUIRED', '请填写 1–500 字范围排除理由。');
    // Publishing consumes a plan version. Retrying the same publication at that version
    // returns its immutable receipt even when the original HTTP response was lost.
    // '/' cannot appear in schedule Idempotency-Key values, keeping route namespaces separate.
    const requestKey = `baseline/${request.expectedPlanVersion}`;
    const requestHash = createHash('sha256').update(JSON.stringify({ expectedPlanVersion: request.expectedPlanVersion,
      name: request.name.trim(), reason: request.reason.trim(), calendarConfirmed: request.calendarConfirmed,
      excludedIds: [...request.excludedIds].sort(), exclusionReason: request.exclusionReason?.trim() ?? '',
    })).digest('hex');
    const previous = database.prepare('SELECT request_hash, response_json FROM plan_idempotency WHERE project_id = ? AND request_key = ?').get(projectId, requestKey) as { request_hash: string; response_json: string } | undefined;
    if (previous?.request_hash === requestHash) return JSON.parse(previous.response_json) as PlanBaseline;
    checkVersion(plan.planVersion, request.expectedPlanVersion);
    const milestoneRecords = new Map(readMilestoneRecords(database, projectId).map(record => [record.id, record]));
    const actors = readActors(database, projectId).filter(actor => actor.role !== 'viewer' && actor.assignable !== false);
    const activeLeaves = plan.nodes.filter(isLeaf).filter(node => node.milestoneState !== 'cancelled');
    const incompleteMilestones = activeLeaves.filter(node => node.kind === 'milestone').filter(node => {
      const milestone = milestoneRecords.get(node.id);
      if (!milestone) return true;
      const owner = actors.find(actor => actor.id === milestone.ownerId), reviewer = actors.find(actor => actor.id === milestone.reviewerId);
      return !owner || !reviewer || (owner.id === reviewer.id && !isProjectManager(owner.role)) || !milestone.criteria.length
        || milestone.criteria.some(criterion => !criterion.title.trim() || (criterion.kind === 'task' && !plan.nodes.some(task => task.id === criterion.taskId && task.kind === 'task')));
    });
    requireValue(!incompleteMilestones.length, 'BASELINE_INCOMPLETE', '里程碑必须配置有效负责人、指定验收人和至少一项有效必要条件。', { objectIds: incompleteMilestones.map(node => node.id) });
    const incomplete = activeLeaves.filter(node =>
      !validDate(node.start) || !validDate(node.end) || node.start < plan.project.start || node.end < node.start
      || !isWorkday(node.start, plan.calendar) || !isWorkday(node.end, plan.calendar)
      || !node.owner.trim() || (node.kind === 'milestone' && (node.start !== node.end || node.durationDays !== 0))
      || (node.kind === 'task' && (node.durationDays !== duration(node.start, node.end, plan.calendar)
        || !Number.isFinite(node.effortHours) || !node.effortHours || node.effortHours <= 0)));
    requireValue(!incomplete.length, 'BASELINE_INCOMPLETE', '纳入任务必须有负责人、日期、正工时估算；里程碑必须有验收负责人。', { objectIds: incomplete.map(node => node.id) });
    validateDependencies(plan.nodes, plan.dependencies);
    for (const edge of plan.dependencies) {
      const from = plan.nodes.find(node => node.id === edge.predecessorId)!;
      const to = plan.nodes.find(node => node.id === edge.successorId)!;
      requireValue(from.milestoneState !== 'cancelled' && to.milestoneState !== 'cancelled', 'BASELINE_CANCELLED_DEPENDENCY', '已取消里程碑仍有关联依赖，请先移除依赖或恢复里程碑再发布基线。');
      requireValue(to.start! >= addWorkdays(from.end!, edge.lagDays + (to.kind === 'milestone' ? 0 : 1), plan.calendar), 'BASELINE_DEPENDENCY_CONFLICT', '基线日期与前置依赖冲突，请调整后再发布。', { objectId: to.id });
    }
    const calendar = { ...plan.calendar, confirmed: true };
    const baseline: PlanBaseline = { id: randomUUID(), name: request.name.trim(), createdAt: now.toISOString(), actor: actorName, reason: `${request.reason.trim()}${gaps.length ? `；范围排除理由：${request.exclusionReason.trim()}` : ''}`, entries: activeLeaves.map(node => {
      const milestone = milestoneRecords.get(node.id);
      return { taskId: node.id, start: node.start, end: node.end, effortHours: node.effortHours, owner: node.owner,
        ...(milestone ? { milestone: { ownerId: milestone.ownerId, reviewerId: milestone.reviewerId, description: milestone.description, criteria: structuredClone(milestone.criteria), state: milestone.state, acceptedAt: milestone.acceptedAt } } : {}) };
    }), dependencies: plan.dependencies, calendar, excludedIds: [...request.excludedIds, ...plan.nodes.filter(node => node.milestoneState === 'cancelled').map(node => node.id)], demo: plan.project.isDemo };
    database.prepare('INSERT INTO plan_baselines VALUES (?, ?, ?, ?)').run(baseline.id, projectId, JSON.stringify(baseline), baseline.createdAt);
    database.prepare('UPDATE plan_projects SET version = version + 1, calendar_json = ? WHERE project_id = ?').run(JSON.stringify(calendar), projectId);
    appendHistory(database, projectId, '发布计划基线', baseline.reason, baseline.entries.length, now, actorName);
    recordActivity(database,{projectId,sourceKey:`baseline:${baseline.id}`,type:'plan.baseline',category:'plan',actor:{id:actorId,name:actorName},occurredAt:now.toISOString(),target:{kind:'baseline',id:baseline.id,name:baseline.name},summary:`发布计划基线「${baseline.name}」，覆盖 ${baseline.entries.length} 项，排除 ${baseline.excludedIds.length} 项`,changes:[{field:'coveredCount',before:null,after:baseline.entries.length},{field:'excludedCount',before:null,after:baseline.excludedIds.length}]});
    captureBusinessJobs(database, projectId, now);
    database.prepare('INSERT INTO plan_idempotency VALUES (?, ?, ?, ?)').run(projectId, requestKey, requestHash, JSON.stringify(baseline));
    return baseline;
  })();
}
