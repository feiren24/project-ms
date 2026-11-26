import { describe, expect, test } from 'vitest';
import type { AnalyticsFilters, AnalyticsTask } from '../../shared/src/analytics.js';
import type { PersonalCapacity } from '../../shared/src/settings.js';
import { resourceCapacity } from '../../server/src/modules/analytics/capacity.js';
import { defaultCalendar } from '../../server/src/modules/planning/calendar.js';

const owners = [{ id: 'chen', name: '陈知远' }];
const filters: AnalyticsFilters = { from: '2026-09-07', to: '2026-09-20', ownerId: '', workstreamId: '', baselineId: '', capacityMode: 'configured' };
const calendar = { ...defaultCalendar, confirmed: true };
const task: AnalyticsTask = { id: 'a', title: 'DEMO 容量任务', wbs: '1', ownerId: 'chen', owner: '陈知远', workstreamId: 'w', parentId: null, start: '2026-09-07', end: '2026-09-18', effortHours: 80, progress: 0, status: 'todo', blocked: false, requiresReview: false, reviewStatus: 'none', actualEnd: null, completionPlanEnd: null };
function cells(capacity: Partial<PersonalCapacity> = {}, extra: Partial<AnalyticsFilters> = {}, projectCalendar = calendar) {
  return resourceCapacity([task], owners, { ...filters, ...extra }, projectCalendar, [{ memberId: 'chen', hoursPerDay: 8, exceptions: {}, ...capacity }]).members[0]!.cells;
}

describe('configured personal capacity shares full-plan allocation', () => {
  test('partial week crops both assigned effort and capacity after full task allocation', () => {
    expect(cells({ hoursPerDay: 4 }, { from: '2026-09-09', to: '2026-09-15' })).toMatchObject([
      { week: '2026-09-07', plannedHours: 24, availableHours: 12, ratio: 2, status: 'overload' },
      { week: '2026-09-14', plannedHours: 16, availableHours: 8, ratio: 2, status: 'overload' },
    ]);
  });
  test('personal date overrides precede project working/rest dates including weekend overtime', () => {
    const projectCalendar = { ...calendar, exceptions: { '2026-09-08': false, '2026-09-12': true } };
    expect(cells({ hoursPerDay: 4, exceptions: { '2026-09-07': 0, '2026-09-08': 2, '2026-09-12': 3, '2026-09-13': 1 } }, {}, projectCalendar)[0]).toMatchObject({ availableHours: 18, plannedHours: 40 });
  });
  test('unknown base differs from explicit zero; overrides can fully configure a cropped period', () => {
    expect(cells({ hoursPerDay: null })[0]).toMatchObject({ availableHours: null, ratio: null, status: 'unknown' });
    expect(cells({ hoursPerDay: 0 })[0]).toMatchObject({ availableHours: 0, ratio: null, status: 'conflict' });
    expect(cells({ hoursPerDay: null, exceptions: { '2026-09-07': 6 } }, { to: '2026-09-07' })[0]).toMatchObject({ availableHours: 6, plannedHours: 8 });
    expect(cells({ hoursPerDay: null, exceptions: { '2026-09-07': 6 } }, { to: '2026-09-08' })[0]!.availableHours).toBeNull();
  });
  test('unconfirmed calendar and absent member configuration never infer real availability', () => {
    expect(cells({}, {}, { ...calendar, confirmed: false }).every(cell => cell.availableHours === null && cell.ratio === null)).toBe(true);
    expect(resourceCapacity([task], owners, filters, calendar).members[0]!.cells[0]!.availableHours).toBeNull();
    expect(cells({ hoursPerDay: 0 }, { capacityMode: 'calendar' })[0]!.availableHours).toBe(40);
    expect(cells({}, { capacityMode: 'unknown' })[0]!.availableHours).toBeNull();
  });
});
