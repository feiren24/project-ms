import type { PlanDependency } from '../../../../shared/src/planning.js';
import type { MilestoneDraft } from '../../../../shared/src/milestones.js';
import { requireValue } from '../planning/errors.js';

/** Conditions gate acceptance without scheduling dates. Their combined graph
 * must still be acyclic: M requires T while T waits for M cannot be delivered. */
export function assertMilestoneAcceptanceGraph(records: Array<Pick<MilestoneDraft,'criteria'> & {id:string}>, dependencies: PlanDependency[]) {
 const outgoing=new Map<string,Set<string>>(),indegree=new Map<string,number>();
 const edge=(from:string,to:string)=>{
  if(!indegree.has(from))indegree.set(from,0);if(!indegree.has(to))indegree.set(to,0);
  const next=outgoing.get(from)??new Set<string>();
  if(!next.has(to)){next.add(to);indegree.set(to,indegree.get(to)!+1);}outgoing.set(from,next);
 };
 for(const dependency of dependencies)edge(dependency.predecessorId,dependency.successorId);
 for(const record of records)for(const criterion of record.criteria)if(criterion.kind==='task'&&criterion.taskId)edge(criterion.taskId,record.id);
 const queue=[...indegree.keys()].filter(id=>indegree.get(id)===0);
 for(let index=0;index<queue.length;index++)for(const id of outgoing.get(queue[index]!)??[]){indegree.set(id,indegree.get(id)!-1);if(indegree.get(id)===0)queue.push(id);}
 requireValue(queue.length===indegree.size,'MILESTONE_ACCEPTANCE_CYCLE','必要交付条件与前置依赖形成循环，双方将无法完成。请调整关联任务或依赖方向。');
}
