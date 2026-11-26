import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PlanDependency, PlanNode } from '../../../../shared/src/planning.js';
import type { ManagedTask } from '../../../../shared/src/tasks.js';
import type { MilestoneCriterion } from '../../../../shared/src/milestones.js';
import { readActors } from '../settings/store.js';
import { requireValue } from '../planning/errors.js';

/** Invalidate downstream critical reviews in the caller's milestone transaction.
 * Ordinary execution and accepted submission history remain intact. The caller
 * owns the plan version, milestone reconciliation, and durable event capture. */
export function invalidateTasksForMilestone(db: Database.Database, projectId: string, milestoneId: string, now: Date, actorName: string): string[] {
  const run = () => {
    const plan = db.prepare('SELECT nodes_json,dependencies_json FROM plan_projects WHERE project_id=?').get(projectId) as {nodes_json:string;dependencies_json:string} | undefined;
    if (!plan) return [];
    const nodes = JSON.parse(plan.nodes_json) as PlanNode[], source = nodes.find(node => node.id === milestoneId && node.kind === 'milestone');
    if (!source) return [];
    const edges = JSON.parse(plan.dependencies_json) as PlanDependency[], outgoing = new Map<string,string[]>();
    for (const edge of edges) { const ids = outgoing.get(edge.predecessorId) ?? []; ids.push(edge.successorId); outgoing.set(edge.predecessorId,ids); }
    // Necessary task criteria also carry validity downstream without becoming
    // scheduling dependencies: A -> task T -> criterion milestone B -> task U.
    const milestoneRows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='milestone_records'").get() ? db.prepare('SELECT record_json FROM milestone_records WHERE project_id=?').all(projectId) as {record_json:string}[] : [];
    for (const row of milestoneRows) {
      const milestone = JSON.parse(row.record_json) as {id:string;criteria:MilestoneCriterion[]};
      for (const criterion of milestone.criteria) if (criterion.kind === 'task' && criterion.taskId) {
        const ids=outgoing.get(criterion.taskId) ?? []; ids.push(milestone.id); outgoing.set(criterion.taskId,ids);
      }
    }
    const affected = new Set([milestoneId]), queue = [milestoneId];
    for (let index=0;index<queue.length;index++) for (const id of outgoing.get(queue[index]!) ?? []) if (!affected.has(id)) { affected.add(id); queue.push(id); }
    type TaskMeta = Omit<ManagedTask,'id'|'title'|'status'|'progress'> & {cancelled?:boolean};
    const rows = db.prepare('SELECT m.task_id,m.meta_json,h.title,h.progress FROM task_meta m JOIN homepage_tasks h ON h.id=m.task_id AND h.project_id=m.project_id WHERE m.project_id=?').all(projectId) as {task_id:string;meta_json:string;title:string;progress:number}[];
    const containers = new Set(rows.flatMap(row => { const meta=JSON.parse(row.meta_json) as TaskMeta; return meta.parentId ? [meta.parentId] : []; }));
    const candidates = rows.filter(row => affected.has(row.task_id) && !containers.has(row.task_id)).map(row => ({...row,meta:JSON.parse(row.meta_json) as TaskMeta})).filter(row => !row.meta.cancelled && row.meta.taskKind !== 'summary' && !row.meta.isContainer && row.meta.requiresReview && ['accepted','submitted'].includes(row.meta.reviewStatus));
    if (!candidates.length) return [];
    const traversalOrder = new Map(queue.map((id,index) => [id,index]));
    candidates.sort((a,b) => traversalOrder.get(a.task_id)! - traversalOrder.get(b.task_id)!);
    const actors = readActors(db,projectId);
    // Validate the complete cascade before changing any task, including when
    // invoked outside a transaction by repair/test callers.
    for (const row of candidates) {
      requireValue(actors.some(actor => actor.id === row.meta.ownerId && actor.assignable !== false && actor.role !== 'viewer'), 'INACTIVE_TASK_RESPONSIBILITY', `任务「${row.title}」的负责人已停用或失去执行权限，请先恢复该成员及权限再调整前置里程碑。`);
      requireValue(actors.some(actor => actor.id === row.meta.reviewerId && actor.assignable !== false && actor.role !== 'viewer'), 'INACTIVE_TASK_RESPONSIBILITY', `任务「${row.title}」的验收人已停用或失去验收权限，请先恢复该成员及权限再调整前置里程碑。`);
    }
    for (const row of candidates) {
      const meta = row.meta, progress = Math.min(row.progress,99);
      meta.actualEnd = null; meta.completionPlanEnd = null; meta.reviewStatus = 'needs_review';
      for (const submission of meta.submissions) if (submission.status === 'submitted') submission.status = 'invalidated';
      meta.version++; meta.updatedAt = now.toISOString();
      meta.events.push({id:randomUUID(),taskId:row.task_id,actor:actorName,action:'needs_review',text:`前置里程碑「${source.title}」验收已失效，请核对成果并重新提交验收。`,createdAt:now.toISOString()});
      db.prepare('UPDATE task_meta SET meta_json=? WHERE project_id=? AND task_id=?').run(JSON.stringify(meta),projectId,row.task_id);
      db.prepare("UPDATE homepage_tasks SET status='in_progress',progress=? WHERE project_id=? AND id=?").run(progress,projectId,row.task_id);
      const node = nodes.find(node => node.id === row.task_id);
      if (node) { node.status = 'in_progress'; node.progress = progress; }
    }
    db.prepare('UPDATE plan_projects SET nodes_json=? WHERE project_id=?').run(JSON.stringify(nodes),projectId);
    return candidates.map(row => row.task_id);
  };
  return db.inTransaction ? run() : db.transaction(run)();
}
