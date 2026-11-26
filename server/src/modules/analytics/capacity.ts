import type { AnalyticsFilters, AnalyticsReport, AnalyticsTask } from '../../../../shared/src/analytics.js';
import type { PlanningCalendar } from '../../../../shared/src/planning.js';
import type { PersonalCapacity } from '../../../../shared/src/settings.js';
import { calendarDay, isWorkday, workweek } from '../planning/calendar.js';
import { validEffort } from './metrics.js';
import { dates, isoWeek, workDates } from './dates.js';
function configuredHours(from: string, to: string, calendar: PlanningCalendar, capacity?: PersonalCapacity): number | null {
  if (!calendar.confirmed || !capacity) return null;
  let total = 0;
  for (const date of dates(from, to)) {
    const hours = capacity.exceptions[date] ?? (isWorkday(date, calendar) ? capacity.hoursPerDay : 0);
    if (hours === null || !Number.isFinite(hours) || hours < 0 || hours > 24) return null;
    total += hours;
  }
  return total;
}
export function resourceCapacity(tasks: AnalyticsTask[], owners: Array<{id:string;name:string}>, filters: AnalyticsFilters, calendar: PlanningCalendar, capacities: PersonalCapacity[] = []): AnalyticsReport['capacity'] {
  const weeks: AnalyticsReport['capacity']['weeks'] = []; for (let day = workweek(filters.from); day <= filters.to; day = calendarDay(day, 7)) weeks.push({ start: day, label: isoWeek(day) });
  const members = owners.filter(owner => !filters.ownerId || owner.id === filters.ownerId).map(owner => ({ ...owner, cells: weeks.map(week => {
    const from = week.start < filters.from ? filters.from : week.start;
    const to = calendarDay(week.start, 6) > filters.to ? filters.to : calendarDay(week.start, 6);
    const availableHours = filters.capacityMode === 'calendar' ? workDates(from, to, calendar).length * calendar.hoursPerDay
      : filters.capacityMode === 'configured' ? configuredHours(from, to, calendar, capacities.find(capacity => capacity.memberId === owner.id)) : null;
    return { week: week.start, plannedHours: 0, availableHours, ratio: null as number | null, status: 'unknown' as AnalyticsReport['capacity']['members'][number]['cells'][number]['status'], tasks: [] as Array<{taskId:string;title:string;hours:number}> };
  }) }));
  const memberById = new Map(members.map(member => [member.id, member]));
  const unallocated: AnalyticsReport['capacity']['unallocated'] = [];
  for (const task of tasks) {
    const reasons = []; if (!task.ownerId || !memberById.has(task.ownerId)) reasons.push('缺负责人'); if (!task.start || !task.end) reasons.push('未排期'); if (!validEffort(task.effortHours)) reasons.push(task.effortHours === null ? '未估算' : '工时须为有限正数');
    if (reasons.length) { unallocated.push({ taskId: task.id, title: task.title, reason: reasons.join('、') }); continue; }
    const fullDays = workDates(task.start!, task.end!, calendar);
    if (!fullDays.length) { unallocated.push({ taskId: task.id, title: task.title, reason: '完整计划区间无工作日，无法分摊' }); continue; }
    const member = memberById.get(task.ownerId)!;
    const counts = new Map<string, number>();
    for (const day of fullDays) if (day >= filters.from && day <= filters.to) { const week = workweek(day); counts.set(week, (counts.get(week) ?? 0) + 1); }
    for (const cell of member.cells) {
      const count = counts.get(cell.week) ?? 0;
      if (!count) continue;
      const hours = task.effortHours! * count / fullDays.length; cell.plannedHours += hours; cell.tasks.push({ taskId: task.id, title: task.title, hours });
    }
  }
  for (const member of members) for (const cell of member.cells) {
    cell.ratio = cell.availableHours !== null && cell.availableHours > 0 ? cell.plannedHours / cell.availableHours : null;
    cell.status = cell.availableHours === null ? 'unknown' : cell.availableHours === 0 && cell.plannedHours > 0 ? 'conflict' : cell.plannedHours === 0 ? 'empty' : cell.ratio! > 1 ? 'overload' : 'normal';
  }
  return { mode: filters.capacityMode, label: filters.capacityMode === 'calendar' ? '按日历满勤试算 · 不代表个人真实容量或请假情况'
    : filters.capacityMode === 'configured' ? '已配置个人容量 · 工作日基础工时与个人逐日例外；未配置或日历未确认时保持未知'
      : '个人可用工时未知 · 不计算负荷比', weeks, members, unallocated };
}
