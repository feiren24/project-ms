import type { PlanningCalendar } from '../../../../shared/src/planning';
/** Count (earlier, later] in the project calendar, then restore the direction. */
export function milestoneWorkdayDifference(from: string, to: string, calendar: PlanningCalendar): number {
 const first = Date.parse(`${from.slice(0,10)}T00:00:00Z`), last = Date.parse(`${to.slice(0,10)}T00:00:00Z`);
 if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
 const low = Math.min(first,last), high = Math.max(first,last); let count = 0;
 for (let cursor = low + 86400000; cursor <= high; cursor += 86400000) { const date = new Date(cursor); if (calendar.exceptions[date.toISOString().slice(0,10)] ?? calendar.weekdays.includes(date.getUTCDay())) count++; }
 return count * (last >= first ? 1 : -1);
}
export function milestoneForecastIsLate(forecast: string|null, commitment: string|null, current: string|null): boolean {
 const target = commitment || current; return Boolean(target && forecast && forecast > target);
}
