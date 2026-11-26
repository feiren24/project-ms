import { test, expect } from 'vitest';
import { taskDatePreset, taskDateError, taskDateToday } from '../../shared/src/task-dates';
test('presets use inclusive natural periods, Monday weeks, leap months and year rollover', () => {
  expect(taskDatePreset('2026-09-20', 'week')).toEqual({ dateFrom: '2026-09-14', dateTo: '2026-09-20' });
  expect(taskDatePreset('2026-12-31', 'nextWeek')).toEqual({ dateFrom: '2027-01-04', dateTo: '2027-01-10' });
  expect(taskDatePreset('2028-02-29', 'month')).toEqual({ dateFrom: '2028-02-01', dateTo: '2028-02-29' });
  expect(taskDatePreset('2026-09-19', 'today')).toEqual({ dateFrom: '2026-09-19', dateTo: '2026-09-19' });
  expect(taskDateToday(new Date('2026-09-13T16:01:00Z'))).toBe('2026-09-14');
});
test('validates complete triples and true calendar dates, allowing weekends and single dates', () => {
  expect(taskDateError({ dateMode: 'due', dateFrom: '2026-09-19', dateTo: '2026-09-19' })).toBe('');
  for (const item of [
    { dateMode: 'due', dateFrom: '', dateTo: '2026-09-19' },
    { dateMode: 'due', dateFrom: '2026-02-30', dateTo: '2026-09-19' },
    { dateMode: 'due', dateFrom: '2026-09-20', dateTo: '2026-09-19' },
  ]) expect(taskDateError(item)).not.toBe('');
});
