import { describe, expect, test } from 'vitest';
import { addWorkdays, defaultCalendar, duration, isWorkday, normalizeWorkday, validDate, workdaysBetween, workweek } from '../../server/src/modules/planning/calendar.js';

describe('planning workday calendar', () => {
  test('validates real ISO dates and crosses month/week/year boundaries in UTC', () => {
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-9-01')).toBe(false);
    expect(addWorkdays('2026-09-18', 1)).toBe('2026-09-21');
    expect(addWorkdays('2026-09-21', -1)).toBe('2026-09-18');
    expect(addWorkdays('2026-12-31', 2)).toBe('2027-01-04');
    expect(normalizeWorkday('2026-09-19')).toBe('2026-09-21');
    expect(duration('2026-09-18', '2026-09-21')).toBe(2);
    expect(duration('2026-09-21', '2026-09-21')).toBe(1);
    expect(workdaysBetween('2026-09-21', '2026-09-18')).toBe(-1);
    expect(workweek('2027-01-01')).toBe('2026-12-28');
  });
  test('respects explicit workday and non-working exceptions without claiming official holidays', () => {
    const calendar = { ...defaultCalendar, exceptions: { '2026-09-19': true, '2026-09-21': false } };
    expect(isWorkday('2026-09-19', calendar)).toBe(true);
    expect(isWorkday('2026-09-21', calendar)).toBe(false);
    expect(addWorkdays('2026-09-18', 2, calendar)).toBe('2026-09-22');
    expect(defaultCalendar.confirmed).toBe(false);
  });
});
