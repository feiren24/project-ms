import { describe, expect, it } from 'vitest';
import { addDays, barGeometry, dateNumber, dateRange, dependencyPath, draftDates, isWeekend, monthSegments, weekSegments } from '../../client/src/features/gantt/timeline.js';

describe('Gantt calendar geometry', () => {
  it('uses actual month lengths and includes both boundary days', () => {
    expect(monthSegments('2026-09-07', '2026-12-31').map(({ days }) => days)).toEqual([24, 31, 30, 31]);
    expect(dateRange('2026-09-07', '2026-12-31')).toHaveLength(116);
    expect(barGeometry('2026-10-01', '2026-10-02', '2026-09-07', 13)).toEqual({ left: 312, width: 26 });
  });
  it('handles leap days, year rollover and timezone transitions as calendar dates', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(() => dateNumber('2026-02-30')).toThrow('Invalid calendar date');
  });
  it('anchors weeks to Mondays with partial visible weeks', () => {
    expect(weekSegments('2026-09-09', '2026-09-21').map(({ days }) => days)).toEqual([5, 7, 1]);
    expect(isWeekend('2026-09-12')).toBe(true);
    expect(isWeekend('2026-09-14')).toBe(false);
  });
  it('moves whole tasks and clamps resize to a single calendar day', () => {
    expect(draftDates('2026-09-07', '2026-09-11', 7, 'move')).toEqual({ start: '2026-09-14', end: '2026-09-18' });
    expect(draftDates('2026-09-07', '2026-09-11', -20, 'resize')).toEqual({ start: '2026-09-07', end: '2026-09-07' });
  });
  it('routes dependencies through the row gutter instead of the task bar', () => {
    expect(dependencyPath(100, 0, 180, 2)).toBe('M 100 22 H 108 V 41 H 172 V 110 H 180');
    expect(dependencyPath(100, 2, 80, 0)).toBe('M 100 110 H 108 V 129 H 72 V 22 H 80');
  });
});
