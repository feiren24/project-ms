import { useAuthStore } from '../../stores/auth';
import { visibleTarget } from '../../utils/module-privacy';
import type { ActivityCategory, ActivityTarget } from '../../../../shared/src/activities';
import type { RouteLocationRaw } from 'vue-router';
export const activityCategories: Array<{ value: ActivityCategory | 'all'; label: string }> = [
  {value:'all',label:'全部动态'},{value:'task',label:'任务成果'},{value:'plan',label:'计划变更'},
  {value:'risk',label:'重要风险'},{value:'project',label:'项目设置'},{value:'member',label:'成员协作'},{value:'workgroup',label:'工作分组'},
];
const day = (value: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(value));
const clock = (value: string) => new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});
export function activityTime(start: string, end = start, now = new Date()) {
  const date = day(start), today = day(now), yesterday = day(new Date(now.getTime()-86400000));
  const label = date === today ? '今天' : date === yesterday ? '昨天' : date;
  return `${label} ${clock(start)}${end !== start && clock(end) !== clock(start) ? `–${clock(end)}` : ''}`;
}
/** Every target keeps its explicit project; never fall back to another matching object. */
export function activityRoute(target: ActivityTarget, projectId: string): RouteLocationRaw | null {
  if (!visibleTarget(target.kind, useAuthStore().capabilities(projectId))) return null;
  const params = { projectId };
  switch (target.kind) {
    case 'task': return {name:'task-detail',params:{...params,taskId:target.id}};
    case 'risk': return {name:'risk-detail',params:{...params,riskId:target.id}};
    case 'baseline': return {name:'plan',params,query:{view:'gantt',baseline:target.id}};
    case 'milestone': return {name:'plan',params,query:{view:'milestones',milestone:target.id}};
    case 'plan': case 'schedule': case 'plan_history': return {name:'plan',params,query:{view:'gantt',history:target.id}};
    case 'workgroup': case 'workstream': return {name:'workstreams',params,query:{groupId:target.id}};
    case 'member': case 'calendar': case 'project': return {name:'settings',params};
    default: return null;
  }
}
const fieldNames:Record<string,string>={reason:'操作原因',status:'状态',reviewStatus:'验收状态',blocked:'阻塞状态',owner:'负责人',ownerId:'负责人',active:'成员或分组状态',role:'项目角色',removed:'成员已移除',goal:'项目目标',start:'开始日期',end:'结束日期',level:'风险等级',occurred:'风险已发生',weekdays:'每周工作日',hoursPerDay:'每日工作时长',confirmed:'日历已确认',exceptions:'特殊工作日',dependencies:'前置依赖',invalidatedTargets:'受影响的交付',coverage:'覆盖计划项',coverageCount:'覆盖计划项',coveredCount:'覆盖计划项',excludedCount:'排除待排期项'};
export const activityField=(field:string)=>fieldNames[field]||'变更内容';
const statuses:Record<string,string>={todo:'待办',in_progress:'进行中',done:'已完成',review:'待验收',cancelled:'已取消',none:'未提交',submitted:'已提交',accepted:'验收通过',rejected:'已退回',needs_review:'需重新验收',identified:'待评估',assessed:'已评估',mitigating:'应对中',monitoring:'监控中',pending_close:'待关闭复核',closed:'已关闭',low:'低',medium:'中',high:'高',critical:'严重',manager:'项目负责人',project_admin:'项目管理员',member:'项目成员',viewer:'只读成员'};
export function activityValue(field:string,value:string|number|boolean|null):string {
  if(value===null)return '未设置';
  if(typeof value==='boolean')return field==='active'?(value?'启用':'停用'):(value?'是':'否');
  if(['status','reviewStatus','role','level'].includes(field))return statuses[String(value)]||String(value);
  if(typeof value==='string'&&['dependencies','weekdays','exceptions'].includes(field)){
    try{const data=JSON.parse(value);if(field==='dependencies')return `${Array.isArray(data)?data.length:0} 条依赖`;
      if(field==='weekdays'&&Array.isArray(data))return data.map((n:number)=>['周日','周一','周二','周三','周四','周五','周六'][n]||'').join('、')||'未设置';
      if(field==='exceptions'&&data&&typeof data==='object')return Object.entries(data).map(([date,hours])=>`${date}：${typeof hours==='boolean'?(hours?'工作日':'休息日'):`${hours} 小时`}`).join('；')||'无特殊日期';
    }catch{return '已调整，详见相关记录';}
  }
  return String(value);
}
