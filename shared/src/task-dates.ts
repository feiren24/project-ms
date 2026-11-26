export type TaskDateMode = 'overlap' | 'due';
export interface TaskDateFilter { dateMode: TaskDateMode; dateFrom: string; dateTo: string }
export type TaskDatePreset = 'today' | 'week' | 'nextWeek' | 'month';
export const taskDateLabels = { overlap: '计划周期', due: '计划截止日期' };
const valid = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
export function taskDateError(value: { dateMode?: unknown; dateFrom?: unknown; dateTo?: unknown }): string {
  if (value.dateMode !== 'overlap' && value.dateMode !== 'due') return '请选择计划周期或计划截止日期。';
  if (!valid(value.dateFrom)) return '请填写有效的开始日期。';
  if (!valid(value.dateTo)) return '请填写有效的结束日期。';
  return value.dateFrom > value.dateTo ? '结束日期不能早于开始日期。' : '';
}
export function taskDateToday(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function taskDatePreset(base: string, preset: TaskDatePreset): Pick<TaskDateFilter, 'dateFrom' | 'dateTo'> {
  const day = new Date(`${base}T00:00:00Z`);
  const shift = (amount: number) => new Date(day.getTime() + amount * 86400000).toISOString().slice(0, 10);
  if (preset === 'today') return { dateFrom: base, dateTo: base };
  if (preset === 'month') {
    const end = new Date(day); end.setUTCMonth(end.getUTCMonth() + 1, 0);
    return { dateFrom: `${base.slice(0, 7)}-01`, dateTo: end.toISOString().slice(0, 10) };
  }
  const offset = -((day.getUTCDay() + 6) % 7) + (preset === 'nextWeek' ? 7 : 0);
  return { dateFrom: shift(offset), dateTo: shift(offset + 6) };
}
