import type { MilestoneCriterion, MilestoneDelivery, MilestoneDraft } from '../../../../shared/src/milestones.js';
import type { TaskActor, ManagedTask } from '../../../../shared/src/tasks.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { PlanError, requireValue } from '../planning/errors.js';

export function strict(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
 requireValue(Boolean(value) && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY', '请提供有效表单。');
 requireValue(Object.keys(value as object).every(k => keys.includes(k)), 'UNKNOWN_FIELD', '表单包含不支持的字段，请刷新后核对。');
}
export function textValue(value: unknown, label: string, limit = 3000, required = false): string {
 requireValue(typeof value === 'string' && value.length <= limit && (!required || Boolean(value.trim())), 'INVALID_FIELD', `${label}${required ? '不能为空，且' : ''}最多${limit}字。`);
 return (value as string).trim();
}
export function linksValue(value: unknown): string[] {
 requireValue(Array.isArray(value) && value.length <= 20, 'INVALID_EVIDENCE', '证据链接最多20项。');
 return [...new Set((value as unknown[]).map(link => {
  const text = textValue(link,'证据链接',2048,true);
  let url: URL; try {url=new URL(text);} catch {throw new PlanError(422,'INVALID_EVIDENCE','请填写完整 HTTP(S) 证据链接。');}
  requireValue(['http:','https:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_EVIDENCE','证据须为不含登录凭据的 HTTP(S) 链接。'); return text;
 }))];
}
export function validateResponsibilities(ownerId: string, reviewerId: string, actors: TaskActor[]) {
 const owner = actors.find(a=>a.id===ownerId && a.assignable!==false && a.role!=='viewer'),reviewer=actors.find(a=>a.id===reviewerId && a.assignable!==false && a.role!=='viewer');
 requireValue(owner && reviewer,'INVALID_RESPONSIBILITY','请选择已启用的项目负责人和验收人。');
 requireValue(ownerId!==reviewerId || isProjectManager(owner!.role),'SELF_REVIEW_FORBIDDEN','普通成员不能同时负责并验收自己的里程碑。');
}
export function validateDraft(body: Record<string,unknown>, actors: TaskActor[], tasks: ManagedTask[], workstreams: Array<{id:string;active?:boolean}>, currentWorkstream?: string): MilestoneDraft {
 const ownerId=textValue(body.ownerId,'负责人',128,true),reviewerId=textValue(body.reviewerId,'验收人',128,true);validateResponsibilities(ownerId,reviewerId,actors);
 const workstreamId=textValue(body.workstreamId,'工作分组',128,true);
 requireValue(workstreams.some(w=>w.id===workstreamId && (w.active!==false || w.id===currentWorkstream)), 'INVALID_WORKSTREAM','请选择当前项目启用的工作分组。');
 requireValue(body.date===null || typeof body.date==='string','INVALID_DATE','计划日期须为日期或留空。');
 requireValue(Array.isArray(body.criteria) && body.criteria.length>0 && body.criteria.length<=50,'INVALID_CRITERIA','请定义1至50项必要交付条件。');
 const ids=new Set<string>(),taskIds=new Set<string>();
 const criteria=(body.criteria as unknown[]).map(value=>{
  strict(value,['id','title','kind','taskId']);const id=textValue(value.id,'条件标识',128,true);requireValue(!ids.has(id),'DUPLICATE_CRITERION','必要条件标识不能重复。');ids.add(id);
  requireValue(value.kind==='task'||value.kind==='evidence','INVALID_CRITERION','条件类型须为关联任务或证据核查。');
  if(value.kind==='task') {requireValue(typeof value.taskId==='string' && !taskIds.has(value.taskId) && tasks.some(t=>t.id===value.taskId && t.taskKind!=='summary' && !t.isContainer && t.status!=='cancelled'),'INVALID_CRITERION_TASK','请选择同项目未取消的具体执行任务，且不能重复关联。');taskIds.add(value.taskId as string);}
  else requireValue(value.taskId===null,'INVALID_CRITERION','证据核查条件不关联任务。');
  return {id,title:textValue(value.title,'验收标准',1000,true),kind:value.kind,taskId:value.taskId} as MilestoneCriterion;
 });
 return {title:textValue(body.title,'里程碑名称',200,true),description:textValue(body.description,'交付目标',3000,true),workstreamId,ownerId,reviewerId,date:body.date as string|null,criteria};
}
export function validateDelivery(body: Record<string,unknown>, criteria: MilestoneCriterion[]): MilestoneDelivery {
 const summary=textValue(body.summary,'成果摘要',6000),links=linksValue(body.links);
 requireValue(Array.isArray(body.evidence) && body.evidence.length<=50,'INVALID_EVIDENCE','请填写有效的条件证据。');
 const ids=new Set<string>();
 const evidence=(body.evidence as unknown[]).map(value=>{
  strict(value,['criterionId','description','links','declared']);const criterionId=textValue(value.criterionId,'条件标识',128,true);
  requireValue(!ids.has(criterionId) && criteria.some(c=>c.id===criterionId&&c.kind==='evidence'),'INVALID_EVIDENCE','证据必须对应当前未重复的证据核查条件。');ids.add(criterionId);
  requireValue(typeof value.declared==='boolean','INVALID_EVIDENCE','请明确是否已经核查材料。');
  return {criterionId,description:textValue(value.description,'证据说明',3000),links:linksValue(value.links),declared:value.declared as boolean};
 });
 return {summary,links,evidence};
}
