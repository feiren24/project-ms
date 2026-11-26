import { test as base, expect, type Page } from '@playwright/test';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { FastifyInstance } from 'fastify';
import type { MilestoneWorkspace } from '../../shared/src/milestones';
import type { ProjectPlan } from '../../shared/src/planning';
const prefix = '/api/v1/projects/phase-one';
// Each browser flow talks to its own in-memory SQLite database. The review demo stays unchanged.
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: ':memory:' }); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const req = route.request();
      const response = await demo.inject({ method: req.method() as 'GET'|'POST', url: new URL(req.url()).pathname+new URL(req.url()).search, headers: req.headers(), payload: req.postData() || undefined });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await use(page);
  },
});
async function data(app: FastifyInstance): Promise<ProjectPlan> { return (await app.inject(`${prefix}/gantt`)).json().data; }
test.beforeEach(async ({ page }) => { await page.goto('/projects/phase-one/plan'); await expect(page.getByRole('heading', { name: '完整计划', exact: true })).toBeVisible(); await expect(page.locator('.plan-version')).toHaveText('执行计划 V1'); });
async function openTask(page: Page) {
  await page.getByRole('textbox', { name:'搜索计划任务' }).fill('统一身份接口联调');
  await page.locator('.gantt-name-button').filter({ hasText: '统一身份接口联调' }).click();
  await expect(page.locator('.task-drawer')).toBeVisible();
  await expect(page.getByRole('tab', { name: '详情', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '查看计划与依赖', exact: true }).click();
}
async function preview(page: Page) {
  await openTask(page);
  await page.getByLabel('计划开始', { exact: true }).fill('2026-10-01');
  await page.getByLabel('计划结束', { exact: true }).fill('2026-10-05');
  await expect(page.getByLabel('调整原因', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '预览调整', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认计划调整', exact: true })).toBeVisible();
}
test('navigation, filters, collapse, zoom, baseline toggle and empty recovery', async ({ page, demo }) => {
  await expect(page.getByRole('button', { name:'完整计划', exact:true })).toHaveAttribute('aria-current','page');
  await expect(page.locator('.gantt-row.is-group')).toHaveCount(6);
  await expect(page.locator('.gantt-row')).toHaveCount(6);
  await page.getByRole('button', { name: '展开全部', exact: true }).click();
  await expect.poll(()=>page.locator('.gantt-row').count()).toBeGreaterThan(6);
  expect(await page.locator('.gantt-row').count()).toBeLessThan(40);
  await expect(page.locator('.gantt-body')).toHaveCSS('height', `${61*44}px`);
  await page.getByRole('button', { name:'日', exact:true }).click();
  await expect(page.getByRole('button', { name:'日', exact:true })).toHaveAttribute('aria-pressed','true');
  await page.getByLabel('筛选工作分组').selectOption('system-bottom');
  await expect(page.locator('.gantt-row.is-group')).toHaveCount(1);
  await page.getByLabel('筛选状态').selectOption('done');
  const filteredPlan = await data(demo);
  const completed = filteredPlan.nodes.filter(node => node.workstreamId === 'system-bottom' && node.kind !== 'group' && node.status === 'done');
  expect(completed).toHaveLength(5); // Legacy milestone completion has no formal acceptance.
  await expect(page.locator('.gantt-row:not(.is-group)')).toHaveCount(completed.length);
  const legacy = filteredPlan.nodes.find(node => node.workstreamId === 'system-bottom' && node.milestoneState === 'legacy_achieved')!;
  await expect(page.locator('.gantt-name-button').filter({ hasText: legacy.title })).toHaveCount(0);
  await page.getByRole('textbox', { name:'搜索计划任务' }).fill('无匹配任务000');
  await expect(page.getByRole('heading', { name:'没有符合条件的计划项' })).toBeVisible();
  await page.getByRole('button', { name:'清除筛选', exact:true }).click();
  await expect.poll(()=>page.locator('.gantt-row').count()).toBeGreaterThan(6);
  expect(await page.locator('.gantt-row').count()).toBeLessThan(40);
  await expect(page.locator('.gantt-body')).toHaveCSS('height', `${61*44}px`);
  await page.getByLabel('对比基线', { exact: true }).selectOption('');
  await expect(page.locator('.gantt-baseline')).toHaveCount(0);
  await page.getByRole('button', { name:'项目总览', exact:true }).click();
  await expect(page.getByRole('heading', { name:'项目总览', exact:true })).toBeVisible();
  await page.getByRole('button', { name:'查看计划', exact:true }).click();
  await expect(page).toHaveURL(/\/plan$/);
});
test('preview can be cancelled; confirming persists and updates overview and baseline deviations', async ({ page, demo }) => {
  await preview(page);
  await expect(page.getByRole('dialog')).toContainText('里程碑受影响');
  expect((await data(demo)).planVersion).toBe(1);
  await page.getByRole('button', { name: '返回修改', exact:true }).click();
  await expect(page.getByLabel('调整原因', { exact:true })).toHaveCount(0);
  await page.getByRole('button', { name:'预览调整', exact:true }).click();
  await page.getByRole('button', { name:'确认保存调整', exact:true }).click();
  await expect(page.locator('.task-plan-panel')).toContainText('计划与依赖已保存');
  await page.getByRole('button', { name:'关闭任务详情', exact:true }).click();
  await expect(page.locator('.task-drawer')).toHaveCount(0);
  await expect(page.locator('.plan-version')).toHaveText('执行计划 V2');
  expect((await data(demo)).nodes.find(n => n.id === 'task-006')?.end).toBe('2026-10-05');
  const overview = (await demo.inject(`${prefix}/overview`)).json().data;
  expect(overview.tasks.find((n: {id:string}) => n.id === 'task-006').due).toBe('2026-10-05');
  await page.locator('.plan-baseline-controls').getByRole('button', { name:/项偏差/ }).click();
  await expect(page.getByRole('dialog')).toContainText('统一身份接口联调');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.plan-version')).toHaveText('执行计划 V2');
  await page.getByRole('button', { name:'变更记录', exact:true }).click();
  await expect(page.getByRole('dialog')).toContainText('调整任务日期与依赖');
});
test('weekend dates show blocking issues and retain editable fields', async ({ page, demo }) => {
  await openTask(page);
  await page.getByLabel('计划开始', { exact: true }).fill('2026-10-03');
  await page.getByLabel('计划结束', { exact: true }).fill('2026-10-05');
  await expect(page.getByLabel('调整原因', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name:'预览调整', exact:true }).click();
  await expect(page.getByRole('button', { name:'确认保存调整', exact:true })).toBeDisabled();
  await expect(page.locator('.task-plan-panel .tp-issue.td-error').first()).toBeVisible();
  expect((await data(demo)).planVersion).toBe(1);
  await page.getByRole('button', { name:'返回修改', exact:true }).click();
  await expect(page.getByLabel('计划开始', { exact:true })).toHaveValue('2026-10-03');
});
test('baseline requires explicit calendar and scope confirmation and creates immutable snapshot', async ({ page, demo }) => {
  const original = (await data(demo)).baselines[0];
  // Explicit test preparation through the real milestone API. Migration must
  // leave owner/reviewer/criteria empty and formal publication must reject them.
  const workspace = (await demo.inject(`${prefix}/milestones`)).json().data as MilestoneWorkspace;
  let version = workspace.planVersion;
  for (const milestone of workspace.milestones) {
    const response = await demo.inject({method:'PATCH',url:`${prefix}/milestones/${milestone.id}`,headers:{'x-preview-token':workspace.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{
      expectedVersion:milestone.version,expectedPlanVersion:version,title:milestone.title,description:milestone.description,workstreamId:milestone.workstreamId,date:milestone.date,
      ownerId:'zhou',reviewerId:'lin',criteria:[{id:'report',title:'交付验收报告',kind:'evidence',taskId:null}],
    }});
    expect(response.statusCode,response.body).toBe(200); version=response.json().data.planVersion;
  }
  await page.reload(); await expect(page.locator('.plan-version')).toHaveText(`执行计划 V${version}`);
  await page.getByRole('button', { name:'发布基线', exact:true }).click();
  await page.getByLabel('基线名称', { exact:true }).fill('浏览验收基线');
  await page.getByLabel('发布说明', { exact:true }).fill('确认评审范围');
  await page.getByRole('checkbox', { name:'我确认本次示例基线采用上述工作日历' }).check();
  await page.getByRole('checkbox', { name:/本次排除/ }).check();
  await page.getByLabel('排除原因', { exact:true }).fill('运营范围尚未细化，保留后续评审');
  await page.getByRole('button', { name:'核对发布范围', exact:true }).click();
  expect((await data(demo)).baselines).toHaveLength(1);
  await expect(page.getByRole('dialog')).toContainText('54 项');
  await page.getByRole('button', { name:'确认发布示例基线', exact:true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await data(demo); expect(after.baselines).toHaveLength(2); expect(after.baselines.find(b => b.id === original.id)).toEqual(original);
  await page.getByLabel('对比基线', { exact:true }).selectOption({ label:'浏览验收基线' });
  await expect(page.locator('.plan-baseline-controls')).toContainText('0 项偏差');
});
test('failed save can retry without duplicating a change', async ({ page, demo }) => {
  await preview(page);
  await page.route('**/schedule/apply', async route => {
    // Save succeeded but the response was lost: retry must return the same result.
    const req = route.request(); await demo.inject({ method:'POST', url:new URL(req.url()).pathname, headers:req.headers(), payload:req.postData()! });
    await route.fulfill({ status:503, contentType:'application/json', body:JSON.stringify({ error:{ message:'测试：响应中断，请重试' } }) });
  }, { times:1 });
  await page.getByRole('button', { name:'确认保存调整', exact:true }).click();
  await expect(page.getByRole('alert')).toContainText('响应中断');
  await page.getByRole('button', { name:'确认保存调整', exact:true }).click();
  await expect(page.locator('.task-plan-panel')).toContainText('计划与依赖已保存');
  await page.getByRole('button', { name:'关闭任务详情', exact:true }).click();
  await expect(page.locator('.task-drawer')).toHaveCount(0);
  expect((await data(demo)).history).toHaveLength(1);
});
test('CSV exports all matching rows regardless of collapsed rendering', async ({ page }) => {
  if (await page.getByRole('button', { name:'收起全部', exact:true }).count()) await page.getByRole('button', { name:'收起全部', exact:true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name:'导出计划', exact:true }).click();
  const file = await download; expect(file.suggestedFilename()).toContain('DEMO.csv');
  const stream = await file.createReadStream(); let text = ''; for await (const chunk of stream!) text += chunk.toString();
  expect(text.split('\r\n')).toHaveLength(56); expect(text).toContain('运营范围待细化');
});
for (const width of [1440,390,320]) {
  test(`complete plan at ${width}px has no page overflow and usable detail forms`, async ({ page }) => {
    await page.setViewportSize({ width, height:width === 1440 ? 900 : 844 });
    await page.screenshot({ path:`test-results/plan-${width}.png`, fullPage:true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 768) {
      await page.getByRole('textbox', { name:'搜索计划任务' }).fill('统一身份接口联调');
      await page.locator('.plan-mobile-task').click();
      await expect(page.locator('.task-drawer')).toBeVisible();
      await page.getByRole('button', { name:'查看计划与依赖', exact:true }).click();
      await expect(page.getByLabel('计划开始', { exact:true })).toBeVisible();
      expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.getByRole('button', { name:'关闭任务详情', exact:true }).click();
      await page.getByRole('button', { name:'甘特时间轴', exact:true }).click();
      await expect(page.locator('.gantt-viewport')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path:`test-results/plan-timeline-${width}.png`, fullPage:true });
    }
  });
}

test('drag and resize create proposals only; Escape cancels drag; full-project fits in desktop viewport', async ({ page, demo }) => {
  await page.setViewportSize({ width:1440, height:900 });
  await expect.poll(() => page.locator('.gantt-viewport').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
  await page.getByRole('textbox', { name:'搜索计划任务' }).fill('统一身份接口联调');
  await page.getByRole('button', { name:'日', exact:true }).click();
  const bar = page.locator('.gantt-bar.is-editable');
  await bar.scrollIntoViewIfNeeded();
  let box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 44, box.y + box.height / 2, { steps:5 });
  await expect(page.locator('.gantt-ghost')).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(400); // Deliberate click-suppression period after drag cancellation.
  box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 44, box.y + box.height / 2, { steps:5 }); await page.mouse.up();
  await expect(page.locator('.task-drawer')).toBeVisible();
  await expect(page.getByRole('tab', { name:'计划与依赖', exact:true })).toHaveAttribute('aria-selected', 'true');
  expect((await data(demo)).planVersion).toBe(1);
  await page.getByRole('button', { name:'关闭任务详情', exact:true }).click();
  await page.getByRole('button', { name:'放弃未保存内容', exact:true }).click();
  await page.waitForTimeout(400);
  await bar.hover(); const handle = (await bar.locator('.gantt-resize').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 10); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 34, handle.y + 10, { steps:5 }); await page.mouse.up();
  await expect(page.locator('.task-drawer')).toBeVisible();
  await expect(page.getByRole('tab', { name:'计划与依赖', exact:true })).toHaveAttribute('aria-selected', 'true');
  expect((await data(demo)).planVersion).toBe(1);
  await page.getByRole('button', { name:'关闭任务详情', exact:true }).click();
  await page.getByRole('button', { name:'放弃未保存内容', exact:true }).click();
  await page.getByRole('button', { name:'全屏查看计划', exact:true }).click();
  await expect(page.locator('.plan-page')).toHaveClass(/plan-fullscreen/);
  await page.getByRole('button', { name:'退出全屏计划', exact:true }).click();
  await expect(page.locator('.plan-page')).not.toHaveClass(/plan-fullscreen/);
});
