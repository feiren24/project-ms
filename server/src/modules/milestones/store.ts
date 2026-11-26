import { isExistingDatabase } from '../../db/lifecycle.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Milestone, MilestoneEvent, MilestoneState } from '../../../../shared/src/milestones.js';
import type { PlanNode, PlanDependency } from '../../../../shared/src/planning.js';
import { invalidateTasksForMilestone } from '../tasks/milestone-invalidation.js';

export type MilestoneRecord = Omit<Milestone, 'readiness' | 'canSubmit' | 'missing' | 'owner' | 'reviewer' | 'forecast'>;
export const emptyDelivery = () => ({ summary: '', links: [] as string[], evidence: [] });
function exists(db: Database.Database, table: string) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }

/** No repository calls here: plan, snapshot and task readers all consume this store. */
export function readMilestoneRecords(db: Database.Database, projectId: string): MilestoneRecord[] {
 if (!exists(db, 'milestone_records')) return [];
 const row = exists(db, 'plan_projects') ? db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as { nodes_json: string } | undefined : undefined;
 const nodes = new Map<string, PlanNode>((row ? JSON.parse(row.nodes_json) as PlanNode[] : []).map(node => [node.id, node]));
 return (db.prepare('SELECT record_json FROM milestone_records WHERE project_id=? ORDER BY rowid').all(projectId) as { record_json: string }[]).map(row => {
  const record = JSON.parse(row.record_json) as MilestoneRecord, node = nodes.get(record.id);
  return node ? { ...record, date: node.end, title: node.title, description: node.description, workstreamId: node.workstreamId, wbs: node.wbs } : record;
 });
}

export function initializeMilestones(db: Database.Database, now: Date) {
  if (isExistingDatabase(db)) return;
 db.transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS milestone_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS milestone_records(project_id TEXT NOT NULL REFERENCES homepage_projects(id),id TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)),PRIMARY KEY(project_id,id));
   CREATE TABLE IF NOT EXISTS milestone_receipts(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_key));`);
  const version = (db.prepare('SELECT max(version) v FROM milestone_schema_migrations').get() as { v: number | null }).v;
  if (version !== null && version > 1) throw new Error('Unsupported milestone schema version');
  db.prepare('INSERT OR IGNORE INTO milestone_schema_migrations VALUES(1,?)').run(now.toISOString());
  if (!exists(db, 'plan_projects')) return;
  const insert = db.prepare('INSERT OR IGNORE INTO milestone_records VALUES(?,?,?)');
  for (const row of db.prepare('SELECT project_id,nodes_json FROM plan_projects').all() as { project_id: string; nodes_json: string }[]) {
   for (const node of (JSON.parse(row.nodes_json) as PlanNode[]).filter(n => n.kind === 'milestone')) {
    const record: MilestoneRecord = { id: node.id, wbs: node.wbs, title: node.title, description: node.description, workstreamId: node.workstreamId, date: node.end,
     ownerId: '', reviewerId: '', criteria: [], delivery: emptyDelivery(), state: node.status === 'done' ? 'legacy_achieved' : 'draft',
     version: 1, acceptedAt: null, legacyStatus: node.status, createdAt: now.toISOString(), updatedAt: now.toISOString(), submissions: [], events: [] };
    insert.run(row.project_id, record.id, JSON.stringify(record));
   }
  }
 })();
}

export function appendMilestoneEvent(record: MilestoneRecord, action: string, actorId: string, actor: string, text: string, now: Date) {
 const event: MilestoneEvent = { id: randomUUID(), action, actorId, actor, text, createdAt: now.toISOString() };
 record.events.push(event); record.updatedAt = now.toISOString(); record.version++;
}
export function milestonePlanStatus(state: MilestoneState): PlanNode['status'] {
 return state === 'accepted' ? 'done' : ['submitted', 'needs_review', 'legacy_achieved', 'rejected'].includes(state) ? 'review' : 'todo';
}
export function saveMilestoneRecord(db: Database.Database, projectId: string, record: MilestoneRecord) {
 db.prepare('INSERT INTO milestone_records VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET record_json=excluded.record_json').run(projectId, record.id, JSON.stringify(record));
}
/** Called only within a write transaction; it does not increment planVersion itself. */
export function projectMilestoneState(db: Database.Database, projectId: string, records = readMilestoneRecords(db, projectId)) {
 const row = db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as { nodes_json: string } | undefined;
 if (!row) return;
 const nodes = JSON.parse(row.nodes_json) as PlanNode[], byId = new Map(records.map(record => [record.id, record]));
 for (const node of nodes) { const m = byId.get(node.id); if (!m) continue;
  node.status = milestonePlanStatus(m.state); node.progress = m.state === 'accepted' ? 100 : 0;
  Object.assign(node, { milestoneState: m.state, acceptedAt: m.acceptedAt });
 }
 db.prepare('UPDATE plan_projects SET nodes_json=? WHERE project_id=?').run(JSON.stringify(nodes), projectId);
}

interface TaskFact { ready: boolean; reason: string; fingerprint: string }
export function milestonePrerequisiteIssues(id: string, dependencies: PlanDependency[], records: MilestoneRecord[], facts: Map<string,TaskFact>): string[] {
 const byId=new Map(records.map(record=>[record.id,record]));
 return dependencies.filter(edge=>edge.successorId===id).filter(edge=>{
  const previous=byId.get(edge.predecessorId);
  return previous ? previous.state!=='accepted'||!previous.acceptedAt : !facts.get(edge.predecessorId)?.ready;
 }).map(edge=>edge.predecessorId);
}
export function readMilestoneTaskFacts(db: Database.Database, projectId: string): Map<string, TaskFact> {
 const facts = new Map<string, TaskFact>();
 if (!exists(db, 'task_meta')) return facts;
 const plan = db.prepare('SELECT nodes_json FROM plan_projects WHERE project_id=?').get(projectId) as { nodes_json: string } | undefined;
 const nodes = new Map<string, PlanNode>((plan ? JSON.parse(plan.nodes_json) as PlanNode[] : []).map(n => [n.id, n]));
 for (const row of db.prepare('SELECT m.task_id,m.meta_json,h.status FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.project_id=?').all(projectId) as {task_id:string;meta_json:string;status:string}[]) {
  const meta = JSON.parse(row.meta_json), node = nodes.get(row.task_id);
  const ready = Boolean(node && node.kind === 'task' && meta.taskKind !== 'summary' && !meta.cancelled && row.status === 'done' && (!meta.requiresReview || meta.reviewStatus === 'accepted'));
  const signature = { status:row.status,cancelled:meta.cancelled,requiresReview:meta.requiresReview,reviewStatus:meta.reviewStatus,criteria:meta.requiresReview ? meta.acceptanceCriteria : null,evidence:meta.requiresReview ? meta.evidence : null,submission:meta.requiresReview ? meta.submissions?.at(-1)?.id : null,kind:meta.taskKind };
  facts.set(row.task_id, { ready, reason: ready ? '任务已完成且所需验收有效' : meta.cancelled ? '关联任务已取消' : meta.taskKind === 'summary' ? '请选择具体执行任务' : meta.requiresReview && meta.reviewStatus !== 'accepted' ? '关键任务尚未通过有效验收' : '关联任务尚未完成', fingerprint: createHash('sha256').update(JSON.stringify(signature)).digest('hex') });
 }
 return facts;
}

export function reconcileMilestones(db: Database.Database, projectId: string, now: Date, actorName = '系统'): string[] {
 const records = readMilestoneRecords(db, projectId);
 const row=db.prepare('SELECT dependencies_json FROM plan_projects WHERE project_id=?').get(projectId) as {dependencies_json:string}|undefined;
 const dependencies=row?JSON.parse(row.dependencies_json) as PlanDependency[]:[];
 if (!records.some(record => ['submitted','accepted'].includes(record.state) && (record.criteria.some(c => c.kind === 'task') || dependencies.some(edge=>edge.successorId===record.id)))) return [];
 let facts = readMilestoneTaskFacts(db, projectId);
 const changedTaskIds=new Set<string>();
 const changedRecords:MilestoneRecord[]=[];
 // Iteration reaches a fixed point even when saved record order differs from dependency order.
 for(let pass=0;pass<records.length;pass++) {
 let passChanged=false;
 for (const record of records) {
  if (!['submitted','accepted'].includes(record.state)) continue;
  const submission = record.submissions.at(-1);
  const invalid = record.criteria.filter(c => c.kind === 'task').filter(c => {
   const fact = facts.get(c.taskId!);
   return !fact?.ready || (submission?.taskVersions[c.taskId!] !== undefined && submission.taskVersions[c.taskId!] !== fact.fingerprint);
  });
  const predecessorIds=milestonePrerequisiteIssues(record.id,dependencies,records,facts);
  const changedPredecessors=dependencies.filter(edge=>edge.successorId===record.id&&submission?.taskVersions[edge.predecessorId]!==undefined&&submission.taskVersions[edge.predecessorId]!==facts.get(edge.predecessorId)?.fingerprint).map(edge=>edge.predecessorId);
  if (!invalid.length && !predecessorIds.length && !changedPredecessors.length) continue;
  if (submission && !submission.invalidatedAt) submission.invalidatedAt = now.toISOString();
  record.state = record.state === 'accepted' ? 'needs_review' : 'draft'; record.acceptedAt = null;
  appendMilestoneEvent(record,'invalidated','system',actorName,`必要成果或前置交付已变化：${[...invalid.map(c=>c.title),...predecessorIds.map(id=>records.find(m=>m.id===id)?.title??id),...changedPredecessors].join('、')}。请补充后重新提交。`,now);
  saveMilestoneRecord(db, projectId, record); changedRecords.push(record);passChanged=true;
  for(const id of invalidateTasksForMilestone(db,projectId,record.id,now,actorName))changedTaskIds.add(id);
 }
 if(!passChanged)break;
 facts=readMilestoneTaskFacts(db,projectId);
 }
 if (changedRecords.length) projectMilestoneState(db, projectId, changedRecords);
 return [...changedTaskIds];
}
