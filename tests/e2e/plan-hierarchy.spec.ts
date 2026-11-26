import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app';
import { hierarchyFixture, hierarchyNode } from '../helpers/plan-hierarchy-fixture';

const test = base.extend<{ demo: FastifyInstance; largeTree: boolean }>({
  largeTree: [false, { option: true }],
  demo: async ({}, use) => {
    const app = buildLegacyApp({ allowedOrigins: [process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174'], dbPath: ':memory:', jobIntervalMs: 0 });
    await use(app); await app.close();
  },
  page: async ({ page, demo, largeTree }, use) => {
    await page.route('**/api/v1/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const response = await demo.inject({ method: req.method() as 'GET' | 'POST', url: url.pathname + url.search, headers: req.headers(), payload: req.postData() || undefined });
      let body = response.body;
      if (url.pathname.endsWith('/gantt') && response.statusCode === 200) {
        const envelope = response.json(), nodes = hierarchyFixture();
        // Rendering and local order previews only; business writes use separate real-API regression tests.
        if (largeTree) nodes.splice(2, nodes.length - 2, ...Array.from({ length: 5000 }, (_, i) => hierarchyNode(`item-${i}`, 'parent')));
        const siblings = new Map<string, string[]>();
        for (const node of nodes) if (node.parentId) siblings.set(node.parentId, [...siblings.get(node.parentId) ?? [], node.id]);
        Object.assign(envelope.data, { nodes, siblingOrders: [...siblings].map(([parentId, nodeIds]) => ({ parentId, nodeIds })), dependencies: [], criticalIds: [], issues: [], baselines: [] });
        body = JSON.stringify(envelope);
      }
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body });
    });
    await use(page);
  },
});

for (const width of [1440, 390, 320]) test(`hierarchy, parent labels and filtered ancestry at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  await page.goto('/projects/phase-one/plan');
  await page.getByRole('button', { name: '展开全部', exact: true }).click();
  const container = width < 768 ? page.locator('.plan-mobile-list') : page.locator('.gantt-viewport');
  const row = (id: string) => container.locator(`[data-node-id="${id}"]`);
  await expect(row('parent')).toContainText('父任务');
  await expect(row('parent')).toContainText('2项子任务');
  await expect(row('parent')).not.toContainText('1.S1af0141c');
  await expect(row('root')).toContainText('工作分组');
  await expect(row('root').locator(width < 768 ? '.plan-mobile-group b' : '.gantt-name-main')).toHaveText('系统底座');
  await expect(row('one')).toContainText('9.T01');
  await expect(row('two')).toHaveAttribute('data-tree-depth', '3');
  await expect(row('two')).toHaveClass(/is-subtree-end/);
  await expect(row('two').locator('.plan-tree-branch')).toHaveClass(/is-last/);
  await expect(row('empty')).toContainText('0项子任务');
  if (width < 768) await expect(row('one')).toContainText('父任务：公共组件');
  else expect((await row('parent').boundingBox())!.height).toBe(44);
  await page.screenshot({ path: info.outputPath('tree.png'), fullPage: true });
  await row('parent').getByRole('button', { name: '收起UI 与应用架构及公共组件设计', exact: true }).click();
  await expect(row('one')).toHaveCount(0);
  await expect(row('parent')).toContainText('2项子任务');
  await row('parent').getByRole('button', { name: '展开UI 与应用架构及公共组件设计', exact: true }).click();
  await expect(row('one')).toHaveCount(1);
  const search = page.getByRole('textbox', { name: '搜索计划任务' });
  await search.fill('组件联调');
  await expect(row('parent')).toContainText('仅展示层级');
  await expect(row('parent')).toContainText('1 / 共 2');
  await expect(row('one')).toHaveCount(0);
  await expect(row('two')).toHaveCount(1);
  await search.fill('1.S1af0141c');
  await expect(row('parent')).toHaveCount(1);
  await expect(row('parent')).not.toContainText('1.S1af0141c');
  await search.fill('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width < 768) {
    await page.getByRole('button', { name: '甘特时间轴', exact: true }).click();
    const parent = page.locator('.gantt-row[data-node-id="parent"]');
    await expect(page.locator('.gantt-row[data-node-id="root"] .gantt-name-main')).toHaveText('系统底座');
    await expect(parent).not.toContainText('1.S1af0141c');
    await expect(parent.locator('.gantt-name')).toBeVisible();
    expect((await parent.boundingBox())!.height).toBe(44);
    await page.screenshot({ path: info.outputPath('timeline.png'), fullPage: true });
  }
});

for (const width of [1440, 390]) test(`ordering updates subtree guides and cancel restores at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/projects/phase-one/plan');
  await page.getByRole('button', { name: '展开全部', exact: true }).click();
  await page.getByRole('button', { name: '调整顺序', exact: true }).click();
  const container = width < 768 ? page.locator('.plan-mobile-list') : page.locator('.gantt-viewport');
  const row = (id: string) => container.locator(`[data-node-id="${id}"]`);
  await expect(row('parent')).not.toContainText('1.S1af0141c');
  await expect(row('root').locator(width < 768 ? '.plan-mobile-group b' : '.gantt-name-main')).toHaveText('系统底座');
  await row('three').locator(width < 768 ? '.plan-mobile-task' : '.gantt-name-button').click();
  await page.getByRole('button', { name: '上移', exact: true }).click();
  await expect(row('three').locator('.plan-tree-branch')).not.toHaveClass(/is-last/);
  await expect(row('nested').locator('.plan-tree-branch')).toHaveClass(/is-last/);
  await expect(row('two')).toHaveClass(/is-subtree-end/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃调整', exact: true }).click();
  await expect(row('three').locator('.plan-tree-branch')).toHaveClass(/is-last/);
  await expect(row('nested').locator('.plan-tree-branch')).not.toHaveClass(/is-last/);
});

test.describe('virtual hierarchy', () => {
  test.use({ largeTree: true });
  test('keeps offscreen ancestors and correct last branches across 5000 rows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/projects/phase-one/plan');
    await page.getByRole('button', { name: '展开全部', exact: true }).click();
    const viewport = page.locator('.gantt-viewport');
    await viewport.evaluate(el => { el.scrollTop = 2502 * 44; });
    const middle = page.locator('.gantt-row[data-node-id="item-2500"]');
    await expect(middle).toHaveAttribute('data-tree-depth', '2');
    await expect(middle.locator('.plan-tree-branch')).not.toHaveClass(/is-last/);
    await expect(middle.locator('.gantt-name-button')).toHaveAttribute('title', /UI 与应用架构/);
    expect(await page.locator('.gantt-row').count()).toBeLessThan(50);
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = page.locator('.gantt-row[data-node-id="item-4999"]');
    await expect(last).toHaveClass(/is-subtree-end/);
    await expect(last.locator('.plan-tree-branch')).toHaveClass(/is-last/);
  });
});
