export type TimelineZoom = 'day' | 'week' | 'month';
export const DAY_MS = 86_400_000;
export const ROW_HEIGHT = 44;
export const PIXELS_PER_DAY: Record<TimelineZoom, number> = { day: 34, week: 13, month: 7 };
export interface TimelineSegment { date: string; label: string; offset: number; days: number }

/** All date arithmetic uses UTC calendar dates, independent of browser timezone and DST. */
export function dateNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid calendar date: ${value}`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`Invalid calendar date: ${value}`);
  return time / DAY_MS;
}
export function addDays(value: string, days: number): string {
  return new Date((dateNumber(value) + days) * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(start: string, end: string): number { return dateNumber(end) - dateNumber(start); }
export function dateRange(start: string, end: string): string[] {
  const days = Math.max(0, daysBetween(start, end) + 1);
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}
export function isWeekend(date: string): boolean { return [0, 6].includes(new Date(dateNumber(date) * DAY_MS).getUTCDay()); }
export function monthSegments(start: string, end: string): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  dateRange(start, end).forEach((date, offset) => {
    const previous = segments.at(-1);
    if (previous?.date.slice(0, 7) === date.slice(0, 7)) previous.days++;
    else segments.push({ date, label: `${Number(date.slice(0, 4))}年 ${Number(date.slice(5, 7))}月`, offset, days: 1 });
  });
  return segments;
}
export function weekSegments(start: string, end: string): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  dateRange(start, end).forEach((date, offset) => {
    const previous = segments.at(-1);
    if (previous && new Date(dateNumber(date) * DAY_MS).getUTCDay() !== 1) previous.days++;
    else segments.push({ date, label: `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`, offset, days: 1 });
  });
  return segments;
}
export function barGeometry(start: string, end: string, rangeStart: string, pixelsPerDay: number): { left: number; width: number } {
  return { left: daysBetween(rangeStart, start) * pixelsPerDay, width: Math.max(1, daysBetween(start, end) + 1) * pixelsPerDay };
}
export function draftDates(start: string, end: string, offset: number, mode: 'move' | 'resize'): { start: string; end: string } {
  if (mode === 'move') return { start: addDays(start, offset), end: addDays(end, offset) };
  const candidate = addDays(end, offset);
  return { start, end: candidate < start ? start : candidate };
}
/** Route through the free gutter below the predecessor, then into the successor's left edge. */
export function dependencyPath(fromX: number, fromRow: number, toX: number, toRow: number): string {
  const fromY = fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
  const toY = toRow * ROW_HEIGHT + ROW_HEIGHT / 2;
  const gutterY = fromRow * ROW_HEIGHT + ROW_HEIGHT - 3;
  const elbowX = fromX + 8;
  const entryX = toX - 8;
  return `M ${fromX} ${fromY} H ${elbowX} V ${gutterY} H ${entryX} V ${toY} H ${toX}`;
}
