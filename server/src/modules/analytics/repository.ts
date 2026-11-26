import { readRevision } from '../../read-revision.js';
import {readDeletedTaskSnapshots} from '../tasks/recycle-store.js';
import type Database from 'better-sqlite3';
import type { AnalyticsFilters, AnalyticsReport } from '../../../../shared/src/analytics.js';
import { readTasks } from '../tasks/repository.js';
import { readPlan } from '../planning/repository.js';
import { requireValue } from '../planning/errors.js';
import { validDate } from '../planning/calendar.js';
import { analyticsTask, executable, metric, selected, taskMetrics } from './metrics.js';
import { shanghaiDate, overlaps } from './dates.js';
import { resourceCapacity } from './capacity.js';
import { planDeviations } from './deviations.js';
import { readSnapshots } from './snapshots.js';
import { deliveryTrend } from './trend.js';
import { readCapacities, readMembers } from '../settings/store.js';
import { personnelAnalysis } from './personnel.js';
function computeAnalytics(db: Database.Database, projectId: string, query: Record<string, unknown>, now: Date): AnalyticsReport {
  const workspace = readTasks(db, projectId, '', now); const plan = readPlan(db, projectId, '', now);
  const members = readMembers(db, projectId);
  const options: AnalyticsReport['options'] = { workstreams: workspace.workstreams, owners: members.map(a => ({id:a.id,name:a.name})), baselines: plan.baselines.map(b => ({id:b.id,name:b.name,createdAt:b.createdAt})) };
  requireValue(Object.keys(query).every(key => ['from','to','workstreamId','ownerId','baselineId','capacityMode'].includes(key)) && Object.values(query).every(value => typeof value === 'string'), 'INVALID_ANALYTICS_FILTER', '统计筛选包含不支持的参数。');
  const filters: AnalyticsFilters = { from: String(query.from ?? workspace.project.start), to: String(query.to ?? workspace.project.end), workstreamId: String(query.workstreamId ?? ''), ownerId: String(query.ownerId ?? ''), baselineId: String(query.baselineId ?? plan.baselines.at(-1)?.id ?? ''), capacityMode: (query.capacityMode ?? 'unknown') as AnalyticsFilters['capacityMode'] };
  requireValue(validDate(filters.from) && validDate(filters.to) && filters.from <= filters.to && (Date.parse(filters.to) - Date.parse(filters.from)) / 86400000 < 366, 'INVALID_ANALYTICS_DATES', '请选择有效计划窗口，开始不晚于结束，最长 366 天。');
  requireValue(['unknown','calendar','configured'].includes(filters.capacityMode) && (!filters.workstreamId || options.workstreams.some(w => w.id === filters.workstreamId)) && (!filters.ownerId || options.owners.some(o => o.id === filters.ownerId)) && (!filters.baselineId || options.baselines.some(b => b.id === filters.baselineId)), 'INVALID_ANALYTICS_FILTER', '请选择有效工作分组、负责人、基线及容量模式。');
  const baseline = plan.baselines.find(b => b.id === filters.baselineId);
  const tasks = workspace.tasks.filter(t => executable(t) && t.status !== 'cancelled' && selected(t, filters)).map(analyticsTask);
  const milestones = plan.nodes.filter(n => n.kind === 'milestone' && n.milestoneState !== 'cancelled' && (!filters.workstreamId || n.workstreamId === filters.workstreamId) && (!filters.ownerId || n.ownerId === filters.ownerId) && overlaps(n.start,n.end,filters.from,filters.to)).map(n => ({id:n.id,title:n.title,workstreamId:n.workstreamId,owner:n.owner,date:n.end,status:n.milestoneState ?? 'draft',acceptedAt:n.acceptedAt ?? null,achieved:n.milestoneState === 'accepted' && Boolean(n.acceptedAt)}));
  const snapshots = readSnapshots(db, projectId); const today = shanghaiDate(now); const latest = snapshots.at(-1);
  const warnings = [`${workspace.project.isDemo ? 'DEMO · 当前示例统计，不代表真实线上执行。' : ''}里程碑只计已验收且无需复核；取消项不计分母，历史无凭证达成不计已验收。历史快照保持原口径，不回填。`, '计划窗口筛选当前任务，不代表历史某日状态；未排期执行任务仍纳入并单列。', '基线未保存历史工作分组与负责人 ID；偏差和计划线按保留任务当前归属筛选，历史缺对象时仅可按基线负责人姓名匹配，工作分组未知。'];
  if (today !== workspace.project.asOf) warnings.push(`本机采集日 ${today}（Asia/Shanghai）与示例业务观察日 ${workspace.project.asOf} 不同；逾期按示例观察日计算，趋势按真实采集日记录。`);
  if (!latest || latest.date !== today || latest.planVersion !== workspace.planVersion) warnings.push('最新采集缺失或落后当前计划版本；已成功的任务写入不受影响，历史趋势不会回填。');
  if (!baseline) warnings.push('未选择基线：偏差与计划趋势无法计算；按期完成仅使用完成时冻结的计划结束日。');
  if (!plan.calendar.confirmed) warnings.push('工作日历尚未确认；资源工时分摊与满勤试算仅供参考。');
  const counts = {total:tasks.length,done:tasks.filter(t => t.status === 'done').length,inProgress:tasks.filter(t => t.status === 'in_progress').length,todo:tasks.filter(t => t.status === 'todo').length,blocked:tasks.filter(t => t.blocked).length,overdue:tasks.filter(t => t.status !== 'done' && t.end && t.end < workspace.project.asOf).length,unplanned:tasks.filter(t => !t.start || !t.end).length,review:tasks.filter(t => ['submitted','needs_review'].includes(t.reviewStatus)).length,unknownActual:tasks.filter(t => t.status === 'done' && !t.actualEnd).length};
  return {mode:workspace.mode,metricVersion:'1.2.0',generatedAt:now.toISOString(),dataAsOf:workspace.project.asOf,planVersion:workspace.planVersion,project:{isDemo:workspace.project.isDemo,id:projectId,name:workspace.project.name,start:workspace.project.start,end:workspace.project.end},filters,options,counts,tasks,milestones,
    personnel: personnelAnalysis(tasks, members, workspace.project.asOf, baseline, filters.ownerId),
    metrics:{...taskMetrics(tasks,baseline),milestoneAchievement:metric(milestones.filter(m => m.achieved).length,milestones.length,0,milestones.map(m => m.id),'已验收且无需复核的里程碑 / 筛选内未取消里程碑；旧无凭证完成项不计正式达成。')},
    workstreams:options.workstreams.filter(w => !filters.workstreamId || w.id === filters.workstreamId).map(w => { const group = tasks.filter(t => t.workstreamId === w.id); const metrics = taskMetrics(group,baseline); return {...w,total:group.length,done:group.filter(t => t.status === 'done').length,inProgress:group.filter(t => t.status === 'in_progress').length,todo:group.filter(t => t.status === 'todo').length,completion:metrics.completion.value,weightedProgress:metrics.weightedProgress.value,taskIds:group.map(t => t.id)}; }),
    deviations:planDeviations(workspace.tasks,plan,filters,baseline,options.owners,readDeletedTaskSnapshots(db,projectId)),capacity:resourceCapacity(tasks,options.owners,filters,plan.calendar,readCapacities(db,projectId)),trend:deliveryTrend(snapshots,workspace.tasks,plan,filters,baseline,options.owners),warnings:[...warnings,'已删除任务不参与当前统计；历史基线和已采集历史快照保留原口径。']};
}

const reports = new WeakMap<Database.Database, Map<string,{revision:string;full:string;summary:string}>>();
export function readAnalytics(db: Database.Database, projectId: string, query: Record<string,unknown>, now: Date): AnalyticsReport {
  const {detail,...filters} = query;
  requireValue(detail === undefined || detail === 'summary' || detail === 'full','INVALID_ANALYTICS_FILTER','统计明细模式无效。');
  const snapshot = db.prepare('SELECT date,captured_at,length(snapshot_json) bytes FROM analytics_daily_snapshots WHERE project_id=? ORDER BY date DESC LIMIT 1').get(projectId);
  const revision = readRevision(db,projectId,now) + JSON.stringify(snapshot);
  const key = projectId + ':' + JSON.stringify(Object.entries(filters).sort(([a],[b])=>a.localeCompare(b)));
  let cache = reports.get(db); if (!cache) { cache = new Map(); reports.set(db,cache); }
  let entry = cache.get(key);
  if (!entry || entry.revision !== revision) {
    const report=computeAnalytics(db,projectId,filters,now);
    const summary={...report,tasks:[],deviations:[],personnel:{...report.personnel,members:[],tasks:[]},
      capacity:{...report.capacity,unallocated:[],members:report.capacity.members.map(member=>({...member,cells:member.cells.map(cell=>({...cell,tasks:[]}))}))}};
    // These are JSON response contracts. Cache serialized values and parse a
    // fresh response so callers cannot mutate cached metrics or another request.
    entry = {revision,full:JSON.stringify(report),summary:JSON.stringify(summary)};
    if (cache.size >= 8 && !cache.has(key)) cache.delete(cache.keys().next().value!);
    cache.set(key,entry);
  }
  return {...JSON.parse(detail === 'summary' ? entry.summary : entry.full) as AnalyticsReport,
    detailLevel:detail === 'summary' ? 'summary':'full',generatedAt:now.toISOString()};
}
