import { calendarDay, isWorkday, workweek } from '../planning/calendar.js';
import type { PlanningCalendar } from '../../../../shared/src/planning.js';
export function shanghaiDate(now: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
export function dates(from: string, to: string): string[] { const result: string[] = []; for (let day = from; day <= to; day = calendarDay(day, 1)) result.push(day); return result; }
export function workDates(from: string, to: string, calendar: PlanningCalendar) { return dates(from, to).filter(day => isWorkday(day, calendar)); }
export function overlaps(start: string | null, end: string | null, from: string, to: string) { return !start || !end || (start <= to && end >= from); }
export function isoWeek(date: string) {
  const monday = workweek(date); const thursday = calendarDay(monday, 3); const year = thursday.slice(0, 4);
  const firstMonday = workweek(`${year}-01-04`);
  return `${year}-W${String(1 + Math.round((Date.parse(monday) - Date.parse(firstMonday)) / 604800000)).padStart(2, '0')}`;
}
