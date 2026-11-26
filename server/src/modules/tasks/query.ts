import { taskDateError } from '../../../../shared/src/task-dates.js';
import { orderPlanNodes } from '../../../../shared/src/plan-order.js';
import { taskIsDeleted } from './recycle-store.js';
import { readPlanOrder } from '../planning/order.js';
import type { PlanNode } from '../../../../shared/src/planning.js';
import type Database from 'better-sqlite3';
import type { ManagedTask, TaskWorkspace, TaskPage } from '../../../../shared/src/tasks.js';
import { readTasks } from './repository.js';
import { readRevision } from '../../read-revision.js';
import { requireValue, PlanError } from '../planning/errors.js';

// Connection-local derived index: never persisted as business data. Rebuilt only
// when the source connection changes, an external writer commits, or the day changes.
interface Index { stamp: string; workspace: TaskWorkspace; byId: Map<string, ManagedTask> }
const caches = new WeakMap<Database.Database, Map<string, Index>>();

function light(task: ManagedTask, byId: Map<string, ManagedTask>): ManagedTask {
  return { ...task, parentTitle: task.parentId ? byId.get(task.parentId)?.title : undefined,
    description: '', evidence: '', acceptanceCriteria: '', events: [], submissions: [] };
}
function indexed(db: Database.Database, projectId: string, now: Date): Index {
  let cache = caches.get(db); if (!cache) { cache = new Map(); caches.set(db, cache); }
  const revision = readRevision(db,projectId,now);
  const existing = cache.get(projectId); if (existing?.stamp === revision) return existing;
  const workspace = readTasks(db, projectId, '', now), byId = new Map(workspace.tasks.map(task => [task.id, task]));
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS task_query_rows (
    project_id TEXT, id TEXT, owner_id TEXT, reviewer_id TEXT, workstream_id TEXT,
    status TEXT, display_state TEXT, priority TEXT, due TEXT, unplanned INTEGER,
    blocked INTEGER, summary INTEGER, search TEXT, wbs_order INTEGER, plan_order INTEGER, updated_at TEXT,
    row_json TEXT, plan_start TEXT, plan_end TEXT, PRIMARY KEY(project_id,id));
    CREATE INDEX IF NOT EXISTS temp.task_query_scope ON task_query_rows(project_id,owner_id,status);
    CREATE INDEX IF NOT EXISTS temp.task_query_group ON task_query_rows(project_id,workstream_id,display_state,due);`);
  const insert = db.prepare('INSERT INTO task_query_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const planNodes = JSON.parse((db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string}).nodes_json) as PlanNode[];
  const planRanks = new Map(orderPlanNodes(planNodes,readPlanOrder(db,projectId,planNodes).siblingOrders).map((node,index)=>[node.id,index]));
  const ordered = [...workspace.tasks].sort((a,b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true }) || a.id.localeCompare(b.id));
  db.transaction(() => {
    db.prepare('DELETE FROM task_query_rows WHERE project_id=?').run(projectId);
    ordered.forEach((t, i) => insert.run(projectId,t.id,t.ownerId,t.reviewerId,t.workstreamId,t.status,t.status === 'cancelled' ? 'cancelled' : t.reviewStatus === 'submitted' ? 'submitted' : t.status,t.priority,t.end ?? '9999-12-31',Number(!t.start || !t.end),Number(t.blocked),Number(t.taskKind === 'summary'),`${t.title} ${t.wbs} ${t.owner} ${t.id}`.toLowerCase(),i,planRanks.get(t.id) ?? planNodes.length+i,t.updatedAt,JSON.stringify(light(t,byId)),t.start,t.end));
    if (cache!.size >= 4 && !cache!.has(projectId)) { const oldest = cache!.keys().next().value!; cache!.delete(oldest); db.prepare('DELETE FROM task_query_rows WHERE project_id=?').run(oldest); }
  })();
  // Keep the version read before materialization: an external commit during
  // construction must invalidate this index on the next request.
  const result = { stamp: revision, workspace, byId }; cache.set(projectId, result); return result;
}
const keys = ['page','pageSize','scope','actorId','query','workstreamId','ownerId','state','priority','due','sort','boardState','dateMode','dateFrom','dateTo'];
export function readTaskPage(db: Database.Database, projectId: string, query: Record<string,unknown>, actorId: unknown, token: string, now: Date): TaskPage {
  requireValue(Object.keys(query).every(key => keys.includes(key)) && Object.values(query).every(value => typeof value === 'string'), 'INVALID_TASK_QUERY', '任务筛选参数无效。');
  const page = Number(query.page ?? 1), pageSize = Number(query.pageSize ?? 50);
  requireValue(Number.isSafeInteger(page) && page > 0 && [20,50,100].includes(pageSize), 'INVALID_TASK_PAGE', '请选择有效页码和每页20、50或100条。');
  const scope = String(query.scope ?? 'all'), state = String(query.state ?? 'active'), sort = String(query.sort ?? 'due'), due = String(query.due ?? '');
  requireValue(['all','mine','review'].includes(scope) && ['active','all','todo','in_progress','submitted','done','cancelled'].includes(state) && ['due','priority','updated','wbs','plan'].includes(sort) && ['','late','unplanned','blocked','today'].includes(due), 'INVALID_TASK_QUERY', '任务筛选条件无效。');
  requireValue(!query.priority || ['P0','P1','P2'].includes(String(query.priority)), 'INVALID_TASK_QUERY', '任务优先级无效。');
  requireValue(!query.boardState || ['todo','in_progress','submitted','done','cancelled'].includes(String(query.boardState)), 'INVALID_TASK_QUERY', '看板状态无效。');
  const hasDates = ['dateMode','dateFrom','dateTo'].some(key => key in query);
  if (hasDates) { const error = taskDateError(query); requireValue(!error, 'INVALID_TASK_DATE_FILTER', error); }
  const index = indexed(db, projectId, now), { workspace } = index;
  // Auth middleware overwrites this header; a query parameter cannot impersonate another actor.
  const actor = typeof actorId === 'string' ? actorId : String(query.actorId ?? '');
  const scopeWhere = ['project_id=?'], scopeArgs: (string|number)[] = [projectId];
  if (scope !== 'all') { scopeWhere.push(scope === 'mine' ? 'owner_id=?' : 'reviewer_id=?'); scopeArgs.push(actor); }
  const summary = db.prepare(`SELECT COALESCE(SUM(summary=0 AND status NOT IN ('done','cancelled')),0) active,
    COALESCE(SUM(summary=0 AND status NOT IN ('done','cancelled') AND due<?),0) late,
    COALESCE(SUM(summary=0 AND display_state='submitted'),0) submitted,
    COALESCE(SUM(summary=0 AND blocked=1 AND status NOT IN ('done','cancelled')),0) blocked
    FROM task_query_rows WHERE ${scopeWhere.join(' AND ')}`).get(workspace.project.asOf,...scopeArgs) as TaskPage['summary'];
  const scopeCounts = db.prepare('SELECT COUNT(*) "all",COALESCE(SUM(owner_id=?),0) mine,COALESCE(SUM(reviewer_id=?),0) review FROM task_query_rows WHERE project_id=?').get(actor,actor,projectId) as TaskPage['scopeCounts'];
  const where = [...scopeWhere], args = [...scopeArgs];
  const search = String(query.query ?? '').trim().toLowerCase(); requireValue(search.length <= 300, 'INVALID_TASK_QUERY', '搜索内容最多300字。');
  if (search) { where.push('instr(search,?)>0'); args.push(search); }
  for (const [key,column] of [['workstreamId','workstream_id'],['ownerId','owner_id'],['priority','priority']] as const) if (query[key]) { where.push(`${column}=?`); args.push(String(query[key])); }
  if (state === 'active') where.push("status NOT IN ('done','cancelled')"); else if (state !== 'all') { where.push('display_state=?'); args.push(state); }
  if (due === 'late') { where.push("status NOT IN ('done','cancelled') AND due<?"); args.push(workspace.project.asOf); }
  if (due === 'today') { where.push('due=?'); args.push(workspace.project.asOf); }
  if (due === 'unplanned') where.push('unplanned=1');
  if (due === 'blocked') where.push('blocked=1');
  if (hasDates) {
    where.push('plan_start IS NOT NULL AND plan_end IS NOT NULL');
    if (query.dateMode === 'overlap') { where.push('plan_start<=? AND plan_end>=?'); args.push(String(query.dateTo), String(query.dateFrom)); }
    else { where.push('plan_end>=? AND plan_end<=?'); args.push(String(query.dateFrom), String(query.dateTo)); }
  }
  const boardCounts: Record<string,number> = {};
  for (const row of db.prepare(`SELECT display_state,COUNT(*) n FROM task_query_rows WHERE ${where.join(' AND ')} GROUP BY display_state`).all(...args) as {display_state:string;n:number}[]) boardCounts[row.display_state]=row.n;
  if (query.boardState) { where.push('display_state=?'); args.push(String(query.boardState)); }
  const total = (db.prepare(`SELECT COUNT(*) n FROM task_query_rows WHERE ${where.join(' AND ')}`).get(...args) as {n:number}).n;
  const actualPage = Math.min(page, Math.max(1,Math.ceil(total/pageSize)));
  const order = {due:'due,wbs_order,id',priority:'priority,wbs_order,id',updated:'updated_at DESC,id',wbs:'wbs_order,id',plan:'plan_order,id'}[sort]!;
  const tasks = (db.prepare(`SELECT row_json FROM task_query_rows WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,pageSize,(actualPage-1)*pageSize) as {row_json:string}[]).map(row => JSON.parse(row.row_json));
  return { ...workspace, tasks, dependencies: [], writeToken: token, total, page: actualPage, pageSize, summary, scopeCounts, boardCounts };
}
export function readTaskEditor(db: Database.Database, projectId: string, token: string, now: Date, taskId?: string, workstreamId?: string): TaskWorkspace {
  const {workspace,byId} = indexed(db, projectId, now);
  const task = taskId ? byId.get(taskId) : undefined;
  if (taskId && !task) {
    if(taskIsDeleted(db,projectId,taskId)) throw new PlanError(410,'TASK_DELETED','任务已删除。具有权限的成员可查看回收站记录。');
    throw new PlanError(404,'TASK_NOT_FOUND','未找到此任务。');
  }
  const related = new Set<string>(task ? [task.id] : []);
  for (const edge of workspace.dependencies) if (edge.successorId === taskId) related.add(edge.predecessorId);
  for (const candidate of workspace.tasks) if (candidate.parentId === taskId || candidate.id === task?.parentId || (!taskId && candidate.parentId === null && (!workstreamId || candidate.workstreamId === workstreamId))) related.add(candidate.id);
  let ancestor = task?.parentId; const visited = new Set<string>();
  while (ancestor && !visited.has(ancestor)) { visited.add(ancestor); related.add(ancestor); ancestor = byId.get(ancestor)?.parentId; }
  const tasks = [...related].flatMap(id => { const value = byId.get(id); return value ? [id === taskId ? structuredClone(value) : light(value,byId)] : []; });
  return { ...workspace, tasks, writeToken: token, dependencies: workspace.dependencies.filter(edge => edge.successorId === taskId) };
}
