import type { PlanningCalendar } from '../../../shared/src/planning';

/** Filesystem-safe project title; never change user-facing project text. */
export function projectCsvFilename(project: { name: string; isDemo: boolean }, report: string): string {
  const name = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '项目';
  return `${name}-${report}${project.isDemo ? '-DEMO' : ''}.csv`;
}
export function calendarDescription(calendar: PlanningCalendar): string {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${calendar.weekdays.map(day => days[day]).join('、') || '未设置常规工作日'} · 每天 ${calendar.hoursPerDay} 小时 · ${Object.keys(calendar.exceptions).length} 个例外日期${calendar.confirmed ? '' : ' · 待确认'}`;
}
