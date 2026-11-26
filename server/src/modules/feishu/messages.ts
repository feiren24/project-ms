import type Database from 'better-sqlite3';
import { feishuTemplates,type FeishuMessage,type FeishuRuleDraft } from '../../../../shared/src/feishu.js';
import { readTasks } from '../tasks/repository.js';
import { readMilestoneRecords } from '../milestones/store.js';
import { readProjectSnapshot } from '../projects/context.js';
import { readPeople,hasTable } from '../settings/store.js';
import { safeText } from './transport.js';
import { initialPeriod,localDate,day,displayTime } from './scheduling.js';
import { eventMatches,type FeishuEvent } from './events.js';
import { normalizedFeishuBaseUrl } from './store.js';
export function baseMessage(db:Database.Database,pid:string,rule:FeishuRuleDraft|null,now:Date,publicBaseUrl?:string):FeishuMessage {
 const project=readProjectSnapshot(db,pid,now)?.project;
 const base=normalizedFeishuBaseUrl(publicBaseUrl);
 return {title:`${project?.isDemo?'DEMO · ':''}${rule?.name??'飞书机器人连接测试'}`,projectName:project?.name??pid,lines:[],total:0,url:base?`${base}/projects/${encodeURIComponent(pid)}/${rule?.template==='risk_event'?'risks':rule?.template==='plan_event'||rule?.template==='milestone_event'||rule?.objectType==='milestone'?'plan':rule?.template.endsWith('_report')?'overview':'tasks'}`:null,linkLabel:rule?.template==='risk_event'?'查看风险中心':rule?.template==='plan_event'||rule?.template==='milestone_event'||rule?.objectType==='milestone'?'查看完整计划':rule?.template.endsWith('_report')?'查看项目总览':'查看任务列表',mentionAll:rule?.mentionAll??false,generatedAt:now.toISOString(),isDemo:project?.isDemo??false};
}
const actions:Record<string,string>={assign:'分派／转交',complete:'执行完成',submit:'提交验收',accept:'验收通过',reject:'验收退回',block:'阻塞',unblock:'解除阻塞',needs_review:'需复核',trigger:'预警触发',resolve:'预警恢复',escalate:'风险升级',occur:'风险发生',approve_close:'风险关闭',reopen:'风险重开',schedule:'日期／依赖调整',baseline:'基线发布'};
export function eventMessage(db:Database.Database,pid:string,rule:FeishuRuleDraft,events:FeishuEvent[],now:Date,baseUrl?:string):FeishuMessage {
 const message=baseMessage(db,pid,rule,now,baseUrl),people=new Map(readPeople(db,pid).map(person=>[person.id,person.name]));message.total=events.length;
 if(events.length===1&&events[0]!.objectType==='task'&&message.url){message.url+=`/${encodeURIComponent(events[0]!.objectId)}`;message.linkLabel='查看任务详情';}
 message.lines=events.slice(0,10).map(event=>safeText(`${actions[event.action]??event.action} · ${event.title} · ${event.ownerIds.map(id=>people.get(id)??'历史成员').join('、')||event.actor}`));return message;
}
export function buildFeishuMessage(db:Database.Database,pid:string,rule:FeishuRuleDraft,now:Date,baseUrl?:string,periodStart?:Date,periodEnd=now):FeishuMessage {
 if(rule.template.endsWith('_event')) {
  const events=(db.prepare('SELECT snapshot_json FROM feishu_events WHERE project_id=? ORDER BY rowid DESC LIMIT 500').all(pid) as {snapshot_json:string}[]).map(row=>JSON.parse(row.snapshot_json) as FeishuEvent).filter(event=>eventMatches(event,rule));return eventMessage(db,pid,rule,events,now,baseUrl);
 }
 const message=baseMessage(db,pid,rule,now,baseUrl),workspace=readTasks(db,pid,'',now);
 const filtered=(item:{workstreamId:string;ownerId:string})=>(!rule.workstreamIds.length||rule.workstreamIds.includes(item.workstreamId))&&(!rule.ownerIds.length||rule.ownerIds.includes(item.ownerId));
 const allTasks=workspace.tasks.filter(task=>!task.isContainer&&task.status!=='cancelled'),tasks=allTasks.filter(filtered),milestones=readMilestoneRecords(db,pid).filter(item=>item.state!=='cancelled'&&filtered(item));
 const daysSince=(date:string|null|undefined)=>date&&/^\d{4}-\d{2}-\d{2}$/.test(date)?Math.floor((Date.parse(`${localDate(now)}T00:00:00Z`)-Date.parse(`${date.slice(0,10)}T00:00:00Z`))/day):-1;
 if(rule.template.endsWith('_report')) {
  const start=periodStart??initialPeriod(rule,periodEnd),within=(date:string|null|undefined)=>Boolean(date&&new Date(date)>=start&&new Date(date)<periodEnd);
  const completed=tasks.filter(task=>task.events.some(event=>event.action==='complete'&&within(event.createdAt)));
  const accepted=tasks.filter(task=>task.submissions.some(sub=>sub.status==='accepted'&&within(sub.reviewedAt)));
  const milestoneAccepted=milestones.filter(item=>within(item.acceptedAt));
  const legacy=milestones.filter(item=>item.state==='legacy_achieved');
  message.periodStart=start.toISOString();message.periodEnd=periodEnd.toISOString();message.total=tasks.length+milestones.length;
  const riskRows=hasTable(db,'risk_records')?(db.prepare('SELECT snapshot_json FROM risk_records WHERE project_id=?').all(pid) as {snapshot_json:string}[]).map(row=>JSON.parse(row.snapshot_json) as {title:string;workstreamId:string;ownerId:string;status:string;level:string|null;legacyLevel:string|null;occurred:boolean}).filter(filtered):[];
  const openRisks=riskRows.filter(risk=>risk.status!=='closed'),highRisks=openRisks.filter(risk=>['high','critical'].includes(risk.level??risk.legacyLevel??''));
  const today=localDate(periodEnd),upcoming=milestones.filter(item=>item.state!=='accepted'&&item.date&&item.date>=today).sort((a,b)=>a.date!.localeCompare(b.date!));
  const acceptedTitles=[...accepted.map(task=>task.title),...milestoneAccepted.map(item=>item.title)];
  const summarize=(titles:string[],limit=3)=>titles.slice(0,limit).join('、')+(titles.length>limit?` 等 ${titles.length} 项`:'');
  message.lines=[`统计窗口：${displayTime(start)} 至 ${displayTime(periodEnd)}（不含结束时刻）`,`执行完成 ${completed.length} 项；独立验收通过 ${accepted.filter(task=>task.submissions.some(sub=>sub.status==='accepted'&&!sub.selfReview&&within(sub.reviewedAt))).length} 项；管理者自审 ${accepted.filter(task=>task.submissions.some(sub=>sub.status==='accepted'&&sub.selfReview&&within(sub.reviewedAt))).length} 项`,`里程碑验收 ${milestoneAccepted.length} 项；历史达成待补验收 ${legacy.length} 项`,`当前逾期 ${tasks.filter(task=>task.status!=='done'&&daysSince(task.end)>0).length} 项；待验收 ${tasks.filter(task=>task.reviewStatus==='submitted').length} 项；阻塞 ${tasks.filter(task=>task.blocked).length} 项`, `未关闭风险 ${openRisks.length} 项，其中高等级 ${highRisks.length} 项、已发生 ${openRisks.filter(risk=>risk.occurred).length} 项${highRisks.length?'：'+summarize(highRisks.map(risk=>risk.title)):''}`,`验收成果：${acceptedTitles.length?summarize(acceptedTitles):'本窗口无验收通过记录'}`,`执行成果：${completed.length?summarize(completed.map(task=>task.title)):'本窗口无执行完成记录'}`,`后续里程碑：${upcoming.length?summarize(upcoming.map(item=>`${item.date} ${item.title}`)):'暂无已排期的未验收里程碑'}`];
  if(rule.template==='weekly_report') {const weekday=new Date(Date.parse(today+'T00:00:00Z')).getUTCDay(),nextMonday=new Date(Date.parse(today+'T00:00:00Z')+(8-(weekday||7))*day).toISOString().slice(0,10),nextEnd=new Date(Date.parse(nextMonday+'T00:00:00Z')+6*day).toISOString().slice(0,10),planned=tasks.filter(task=>task.status!=='done'&&task.start&&task.end&&task.start<=nextEnd&&task.end>=nextMonday);message.lines.push(`下周计划（${nextMonday} 至 ${nextEnd}）：${planned.length} 项${planned.length?'，'+summarize(planned.map(task=>task.title)):''}`);}
  message.lines=message.lines.map(safeText);return message;
 }
 if(rule.objectType==='milestone') {
  const hits=milestones.filter(item=>{const distance=daysSince(item.date);switch(rule.template){case 'due_reminder':return Boolean(item.date)&&item.state!=='accepted'&&distance<=0&&distance>=-rule.days;case 'overdue_reminder':return item.state!=='accepted'&&distance>=rule.days;case 'review_reminder':return item.state==='submitted'&&daysSince(item.submissions.at(-1)?.createdAt?localDate(new Date(item.submissions.at(-1)!.createdAt)):null)>=rule.days;case 'blocked_reminder':return item.state!=='accepted'&&item.criteria.some(c=>c.taskId&&allTasks.some(task=>task.id===c.taskId&&task.blocked&&daysSince(task.events.filter(e=>e.action==='block').at(-1)?.createdAt?localDate(new Date(task.events.filter(e=>e.action==='block').at(-1)!.createdAt)):null)>=rule.days));default:return false;}});
  message.total=hits.length;message.lines=hits.slice(0,10).map(item=>safeText(`${item.title} · ${workspace.actors.find(actor=>actor.id===item.ownerId)?.name??'历史成员'} · ${item.date??'未排期'}`));
 }else {
  const hits=tasks.filter(task=>{const distance=daysSince(task.end);switch(rule.template){case 'due_reminder':return Boolean(task.end)&&task.status!=='done'&&distance<=0&&distance>=-rule.days;case 'overdue_reminder':return task.status!=='done'&&distance>=rule.days;case 'review_reminder':return task.reviewStatus==='submitted'&&daysSince(task.submissions.at(-1)?.createdAt?localDate(new Date(task.submissions.at(-1)!.createdAt)):null)>=rule.days;case 'blocked_reminder':return task.blocked&&daysSince(task.events.filter(event=>event.action==='block').at(-1)?.createdAt?localDate(new Date(task.events.filter(event=>event.action==='block').at(-1)!.createdAt)):null)>=rule.days;default:return false;}});
  message.total=hits.length;message.lines=hits.slice(0,10).map(task=>safeText(`${task.title} · ${task.owner} · ${task.end??'未排期'}`));
 }
 if(!message.total)message.lines=['当前范围没有符合条件的事项。'];return message;
}
