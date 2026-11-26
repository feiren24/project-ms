import { afterEach, expect, test } from 'vitest';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import { analyticsCsv } from '../../client/src/features/analytics/export';
import type { AnalyticsReport } from '../../shared/src/analytics';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function report(): Promise<AnalyticsReport> {
  const app = buildApp({ dbPath: ':memory:', clock: () => new Date('2026-09-23T06:00:00Z') });
  apps.push(app);
  return (await app.inject('/api/v1/projects/phase-one/analytics')).json().data;
}
test('CSV exports percentages and leaves unknown actual values empty', async () => {
  const data = await report();
  const csv = analyticsCsv(data, 'delivery');
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('"任务完成率","37.5","18","48"');
  expect(csv).toContain('"按期完成率","","0","0","18"');
});
test('CSV protects formula strings while preserving negative numeric deviations', async () => {
  const data = await report();
  data.deviations[0] = { ...data.deviations[0]!, title: '=HYPERLINK("test")', deltaDays: -5, state: 'early' };
  const csv = analyticsCsv(data, 'deviation');
  expect(csv).toContain("\"'=HYPERLINK(\"\"test\"\")\"");
  expect(csv).toContain(',"-5"');
  expect(csv).not.toContain("\"'-5\"");
});
test('resource CSV contains all weeks beyond the visible four-week page', async () => {
  const data = await report();
  const csv = analyticsCsv(data, 'capacity');
  expect(data.capacity.weeks.length).toBeGreaterThan(4);
  for (const week of data.capacity.weeks) expect(csv).toContain(week.start);
  expect(csv).toContain('个人容量未知');
});

test('personnel CSV includes all members, denominators, missing facts and all task dates safely', async () => {
  const data = await report();
  data.tasks[0]!.title = '=个人统计公式测试';
  const csv = analyticsCsv(data, 'personnel');
  expect(csv).toContain('人员任务分析');
  expect(csv).toContain('"任务完成率","37.5","18","48"');
  expect(csv).toContain('"已完成任务延期率","","0","0","18"');
  expect(csv).toContain('分子任务ID');
  expect(csv).toContain('当前截止日');
  expect(csv).toContain('参照来源');
  expect(csv).toContain("'=个人统计公式测试");
  for (const m of data.personnel.members) expect(csv).toContain(m.name);
  for (const t of data.tasks) expect(csv).toContain(`"${t.id}","${t.wbs}"`);
  expect(csv).toContain('无法判定时效');
  expect(csv).toContain(data.dataAsOf);
});
