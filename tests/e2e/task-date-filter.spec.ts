import { test as base, expect, type Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app';
import { seedDateTasks, createDateTask } from '../helpers/task-date-fixture';
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => {
    const app = buildLegacyApp({ dbPath: ':memory:', jobIntervalMs: 0, allowedOrigins: [process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174'] });
    await seedDateTasks(app); await use(app); await app.close();
  },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const r = await demo.inject({ method: req.method() as 'GET' | 'POST', url: url.pathname + url.search, headers: req.headers(), payload: req.postData() || undefined });
      await route.fulfill({ status: r.statusCode, contentType: 'application/json', body: r.body });
    });
    await use(page); await page.unrouteAll({ behavior: 'wait' });
  },
});
async function enter(page: Page) {
  await page.goto('/projects/phase-one/tasks');
  await page.getByLabel('搜索任务', { exact: true }).fill('日期样例');
  await expect(page.locator('.task-result-bar')).toContainText('共 6 项');
}
async function setRange(page: Page, mode = 'overlap', from = '2026-09-14', to = '2026-09-20') {
  await page.getByRole('button', { name: '任务日期筛选', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '日期筛选', exact: true });
  await dialog.getByLabel('筛选依据').selectOption(mode);
  await dialog.getByLabel('开始日期', { exact: true }).fill(from);
  await dialog.getByLabel('结束日期', { exact: true }).fill(to);
  await dialog.getByRole('button', { name: '应用筛选', exact: true }).click();
}
for (const width of [1440, 390, 320]) test(`date filter draft, clear, modes, views and detail return at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await enter(page);
  const summary = await page.locator('.task-summary-line b').allTextContents();
  expect((await page.getByRole('button', { name: '任务日期筛选', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: '任务日期筛选', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '日期筛选', exact: true });
  await dialog.getByRole('button', { name: '本周', exact: true }).click();
  await expect(dialog.getByLabel('开始日期', { exact: true })).toHaveValue('2026-09-21');
  await expect(page.locator('.task-result-bar')).toContainText('共 6 项');
  await dialog.getByLabel('开始日期', { exact: true }).fill('2026-09-25');
  await dialog.getByLabel('结束日期', { exact: true }).fill('2026-09-14');
  await expect(dialog.getByRole('button', { name: '应用筛选', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('结束日期不能早于开始日期');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('date-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '任务日期筛选', exact: true })).toBeFocused();
  await setRange(page);
  await expect(page.locator('.task-result-bar')).toContainText('共 4 项');
  await expect(page.getByLabel('任务状态筛选')).toHaveValue('active');
  await expect(page.locator('.task-summary-line b')).toHaveText(summary);
  await expect(page.locator('.task-date-applied')).toContainText('2026-09-14 至 2026-09-20');
  const list = width < 768 ? page.locator('.task-mobile-cards') : page.locator('.task-table');
  await list.getByRole('button').filter({ hasText: '日期样例A' }).first().click();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(page.locator('.task-result-bar')).toContainText('共 4 项');
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expect(page.locator('.task-board-card')).toHaveCount(4);
  await setRange(page, 'due');
  await expect(page.locator('.task-board-card')).toHaveCount(2);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await page.getByLabel('任务期限筛选').selectOption('unplanned');
  await expect(page.locator('.task-empty')).toContainText('待排期');
  await page.getByRole('button', { name: '清除待排期条件', exact: true }).click();
  await expect(page.locator('.task-result-bar')).toContainText('共 2 项');
  if (width === 1440) {
    const content = await page.locator('.task-page-header h1').boundingBox(), sidebar = await page.locator('.sidebar').boundingBox();
    expect(content!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('date-results.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '移除日期筛选', exact: true }).click();
  await expect(page.locator('.task-result-bar')).toContainText('共 6 项');
  await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue('日期样例');
});
test('failed date query hides stale rows and retries with the same applied range', async ({ page }) => {
  await enter(page); let fail = true;
  await page.route('**/tasks/query?**', async route => {
    if (fail && new URL(route.request().url()).searchParams.has('dateFrom')) {
      fail = false; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_FAILURE', message: '日期查询暂时失败' } }) });
    } else await route.fallback();
  });
  await setRange(page);
  await expect(page.getByRole('alert')).toContainText('日期查询暂时失败');
  await expect(page.locator('.task-table')).toHaveCount(0);
  await page.getByRole('button', { name: '重新加载任务', exact: true }).click();
  await expect(page.locator('.task-result-bar')).toContainText('共 4 项');
  await expect(page.locator('.task-date-applied')).toContainText('2026-09-14');
});
test('reset clears dates and explicit workstream drilldown does not inherit the previous date range', async ({ page }) => {
  await enter(page); await setRange(page);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await expect(page.locator('.task-date-applied')).toHaveCount(0);
  await setRange(page);
  await page.getByRole('button', { name: '工作分组', exact: true }).click();
  await page.locator('#workstream-system-bottom').getByRole('button', { name: /查看.*任务/ }).click();
  await expect(page.locator('.task-date-applied')).toHaveCount(0);
  await expect(page.getByLabel('任务工作分组筛选')).toHaveValue('system-bottom');
});

test('latest applied date wins even if an older query finishes last', async ({ page }) => {
  await enter(page);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/tasks/query?**', async route => {
    if (new URL(route.request().url()).searchParams.get('dateMode') === 'overlap') { started(); await gate; }
    await route.fallback();
  });
  try {
    await setRange(page); await requested;
    await setRange(page, 'due');
    await expect(page.locator('.task-result-bar')).toContainText('共 2 项');
    const response = page.waitForResponse(r => new URL(r.url()).searchParams.get('dateMode') === 'overlap');
    release(); await response;
    await expect(page.locator('.task-result-bar')).toContainText('共 2 项');
    await expect(page.locator('.task-date-applied')).toContainText('计划截止日期');
  } finally { release(); }
});

test('applying dates resets pagination and batch selection', async ({ page, demo }) => {
  await enter(page);
  for (let i = 0; i < 21; i++) await createDateTask(demo, `分页${i}`, '2026-09-14', '2026-09-15');
  await page.getByLabel('每页任务数').selectOption('20');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.task-pagination')).toContainText('第 2 / 2 页');
  await page.locator('.task-table tbody input[type=checkbox]').first().check();
  await expect(page.locator('.task-bulk-bar')).toBeVisible();
  await setRange(page);
  await expect(page.locator('.task-pagination')).toContainText('第 1 / 2 页');
  await expect(page.locator('.task-result-bar')).toContainText('共 25 项');
  await expect(page.locator('.task-bulk-bar')).toHaveCount(0);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.task-pagination')).toContainText('第 2 / 2 页');
  await setRange(page);
  await expect(page.locator('.task-pagination')).toContainText('第 1 / 2 页');
});

test('a failed old board append cannot replace the newly applied date results', async ({ page, demo }) => {
  for (let i = 0; i < 47; i++) await createDateTask(demo, `看板追加${i}`, '2026-09-14', '2026-09-15');
  await page.goto('/projects/phase-one/tasks');
  await page.getByLabel('搜索任务', { exact: true }).fill('日期样例');
  await setRange(page);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await expect(page.locator('.task-board-card')).toHaveCount(50);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/tasks/query?**', async route => {
    const q = new URL(route.request().url()).searchParams;
    if (q.get('dateMode') === 'overlap' && q.get('page') === '2') {
      started(); await gate;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OLD_FAILURE', message: '旧看板请求失败' } }) });
    } else await route.fallback();
  });
  try {
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click(); await requested;
    await setRange(page, 'due');
    await expect(page.locator('.task-board-card')).toHaveCount(49);
    const response = page.waitForResponse(r => new URL(r.url()).searchParams.get('page') === '2');
    release(); await (await response).finished();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.task-board-card')).toHaveCount(49);
  } finally { release(); }
});
