import type { PlanningCalendar } from '../../../../shared/src/planning.js';

export const defaultCalendar: PlanningCalendar = {
  weekdays: [1, 2, 3, 4, 5], hoursPerDay: 8, confirmed: false, exceptions: {},
};
const dayMs = 86_400_000;
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
export function calendarDay(date: string, amount: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + amount * dayMs).toISOString().slice(0, 10);
}
export function isWorkday(date: string, calendar = defaultCalendar): boolean {
  return calendar.exceptions[date] ?? calendar.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
}
export function normalizeWorkday(date: string, calendar = defaultCalendar): string {
  let cursor = date;
  for (let i = 0; i < 3700; i++) {
    if (isWorkday(cursor, calendar)) return cursor;
    cursor = calendarDay(cursor, 1);
  }
  throw new Error('Calendar has no available workdays');
}
/** Zero retains the given date. Each nonzero step consumes one complete workday. */
export function addWorkdays(date: string, amount: number, calendar = defaultCalendar): string {
  let cursor = date;
  let remaining = Math.abs(amount);
  for (let i = 0; remaining && i < 40_000; i++) {
    cursor = calendarDay(cursor, Math.sign(amount));
    if (isWorkday(cursor, calendar)) remaining--;
  }
  if (remaining) throw new Error('Calendar calculation exceeded limit');
  return cursor;
}
export function workdaysBetween(start: string, end: string, calendar = defaultCalendar): number {
  if (start > end) return -workdaysBetween(end, start, calendar);
  let count = 0;
  for (let cursor = calendarDay(start, 1); cursor <= end; cursor = calendarDay(cursor, 1)) {
    if (isWorkday(cursor, calendar)) count++;
  }
  return count;
}
export function duration(start: string, end: string, calendar = defaultCalendar): number {
  return start > end ? 0 : workdaysBetween(start, end, calendar) + Number(isWorkday(start, calendar));
}
export function workweek(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return calendarDay(date, -(weekday === 0 ? 6 : weekday - 1));
}
