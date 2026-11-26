import type Database from 'better-sqlite3';
import type { FeishuRuleDraft, NotificationPreferences } from '../../../../shared/src/feishu.js';
import type { PlanningCalendar } from '../../../../shared/src/planning.js';
export const minute=60_000, day=86_400_000, offset=8*60*minute;
export function localDate(now:Date) { return new Date(now.getTime()+offset).toISOString().slice(0,10); }
export function calendarFor(db:Database.Database,pid:string):PlanningCalendar|null { const row=db.prepare('SELECT calendar_json FROM plan_projects WHERE project_id=?').get(pid) as {calendar_json:string}|undefined;return row?JSON.parse(row.calendar_json):null; }
export function quietAdjusted(date:Date,rule:FeishuRuleDraft,prefs:NotificationPreferences):Date {
 if(rule.bypassQuiet||!prefs.quietEnabled)return date;
 const minutes=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));
 const start=minutes(prefs.quietStart),end=minutes(prefs.quietEnd),local=new Date(date.getTime()+offset),current=local.getUTCHours()*60+local.getUTCMinutes();
 const quiet=start<end?current>=start&&current<end:current>=start||current<end;
 if(!quiet)return date;
 let target=Math.floor((date.getTime()+offset)/day)*day-offset+end*minute;
 if(target<=date.getTime())target+=day;
 return new Date(target);
}
export function nextSlot(db:Database.Database,pid:string,rule:FeishuRuleDraft,after:Date,prefs:NotificationPreferences):{nominal:Date;effective:Date}|null {
 if(rule.template.endsWith('_event'))return null;
 const calendar=calendarFor(db,pid);if(rule.schedule.mode==='workdays'&&!calendar?.confirmed)return null;
 const midnight=Math.floor((after.getTime()+offset)/day)*day-offset;
 const time=Number(rule.schedule.time.slice(0,2))*60+Number(rule.schedule.time.slice(3));
 for(let i=0;i<370;i++) {
  const date=new Date(midnight+i*day),key=localDate(date),weekday=new Date(date.getTime()+offset).getUTCDay();
  const allowed=rule.schedule.mode==='workdays'?(calendar!.exceptions[key]??calendar!.weekdays.includes(weekday)):rule.schedule.weekdays.includes(weekday);
  if(!allowed)continue;
  const nominal=new Date(date.getTime()+time*minute);if(nominal<=after)continue;
  return {nominal,effective:quietAdjusted(nominal,rule,prefs)};
 }
 return null;
}
export function initialPeriod(rule:FeishuRuleDraft,at:Date):Date { const date=new Date(Math.floor((at.getTime()+offset)/day)*day-offset);if(rule.template==='weekly_report'){const weekday=new Date(date.getTime()+offset).getUTCDay();return new Date(date.getTime()-((weekday+6)%7)*day);}return date; }
export function nominalAllowed(db:Database.Database,pid:string,rule:FeishuRuleDraft,at:Date):boolean {const calendar=calendarFor(db,pid),weekday=new Date(at.getTime()+offset).getUTCDay();return rule.schedule.mode==='workdays'?Boolean(calendar?.confirmed&&(calendar.exceptions[localDate(at)]??calendar.weekdays.includes(weekday))):rule.schedule.weekdays.includes(weekday);}
export function displayTime(date:string|Date):string {const value=new Date(date);return Number.isFinite(value.getTime())?new Date(value.getTime()+offset).toISOString().slice(0,16).replace('T',' ')+'（上海）':'时间未知';}
