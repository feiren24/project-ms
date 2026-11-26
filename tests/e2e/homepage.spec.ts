import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';

const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => {
    const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: ':memory:', clock: () => new Date('2026-09-23T06:00:00Z'), jobIntervalMs: 0 });
    try { await use(app); } finally { await app.close(); }
  },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const response = await demo.inject({
        method: request.method() as 'GET' | 'POST' | 'PATCH',
        url: url.pathname + url.search,
        headers: request.headers(),
        payload: request.postData() || undefined,
      });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await use(page);
  },
});

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
});

test('homepage has honest metrics and functional drilldowns', async ({ page }) => {
  await expect(page.locator('.demo-strip')).toContainText('示例数据');
  await expect(page.locator('.metric-card').first()).toContainText('37.5');
  await expect(page.locator('.metric-card').first()).toContainText('18 / 48');
  await page.locator('.metric-card').first().click();
  await expect(page).toHaveURL(/tasks\?filter=done$/);
  await expect(page.locator('.task-table tbody tr')).toHaveCount(18);
  await page.getByRole('button', { name: '项目总览', exact: true }).click();
  await expect(page.locator('.metric-card').first()).toContainText('18 / 48');
});

test('attention filters and all-items drawer do not omit risks', async ({ page }) => {
  await page.getByRole('tab', { name: '待验收', exact: true }).click();
  await expect(page.locator('.attention-item')).toHaveCount(0);
  await page.getByRole('tab', { name: '逾期', exact: true }).click();
  await expect(page.locator('.attention-item')).toHaveCount(4);
  await page.getByRole('tab', { name: '风险', exact: true }).click();
  await expect(page.locator('.attention-item')).toHaveCount(3);
  await page.getByRole('button', { name: '查看全部待处理', exact: true }).click();
  await expect(page.locator('.task-detail-card')).toHaveCount(4);
  await expect(page.locator('.risk-level.high')).toHaveCount(3);
  const legacy = page.locator('.milestone-detail-card').filter({hasText:'公共能力范围评审'});
  await expect(legacy.locator('.task-status')).toHaveText('历史达成，待补验收');
  await expect(page.getByRole('dialog')).not.toContainText('系统底座接口评审');
  await legacy.getByRole('link',{name:'打开里程碑详情',exact:true}).click();
  await expect(page).toHaveURL(/view=milestones&milestone=/);
  await expect(page.getByRole('dialog',{name:'里程碑详情',exact:true})).toContainText('公共能力范围评审');
  await expect(page.getByRole('dialog',{name:'里程碑详情',exact:true})).toContainText('历史达成，待补验收');
});

test('search handles matches and no matches', async ({ page }) => {
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('招聘');
  await expect(page.locator('.task-detail-card').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('招聘流程存在依赖阻塞');
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('不存在的唯一关键词999');
  await expect(page.getByRole('heading', { name: '没有找到相关内容' })).toBeVisible();
});

for (const source of ['overview', 'plan', 'tasks', 'analytics']) {
  test(`search task returns to ${source} with its results`, async ({ page }) => {
    await page.goto(`/projects/phase-one/${source}`);
    await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
    const input = page.getByRole('textbox', { name: '搜索任务或风险' });
    await input.fill('招聘');
    const card = page.locator('a.task-detail-card').last();
    const id = await card.locator('.task-reference').innerText();
    await card.scrollIntoViewIfNeeded();
    const scroll = await page.locator('.drawer-content').evaluate(el => el.scrollTop);
    await card.click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(new RegExp(`/tasks/${id}\\?from=search`));
    await expect(page.getByRole('button', { name: '关闭任务详情', exact: true })).toBeVisible();
    await expect(input).toHaveCount(0);
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${source}$`));
    await expect(input).toHaveValue('招聘');
    await expect(card).toBeFocused();
    await expect.poll(() => page.locator('.drawer-content').evaluate(el => el.scrollTop)).toBe(scroll);
    await card.press('Enter');
    await expect(page.getByRole('button', { name: '关闭任务详情', exact: true })).toBeVisible();
    await page.goBack();
    await expect(input).toHaveValue('招聘');
    await expect(page).toHaveURL(new RegExp(`/${source}$`));
  });
}

test('search return restores source filters and browser position', async ({ page }) => {
  await page.getByRole('tab', { name: '风险', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 250));
  const scroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('招聘');
  await page.locator('a.task-detail-card').first().click();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue('招聘');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(page.getByRole('tab', { name: '风险', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
});

test('search return restores the Gantt canvas scroll position', async ({ page }) => {
  await page.goto('/projects/phase-one/plan');
  const viewport = page.locator('.gantt-viewport');
  await expect(viewport).toBeVisible();
  const expand = page.getByRole('button', {name:'展开全部',exact:true});
  if (await expand.isVisible()) await expand.click();
  await viewport.evaluate(el => el.scrollTo({top:300,left:120,behavior:'instant'}));
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const position = await viewport.evaluate(el => ({top:el.scrollTop,left:el.scrollLeft}));
  expect(position.top).toBeGreaterThan(0);
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('招聘');
  await page.locator('a.task-detail-card').first().click();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue('招聘');
  await expect.poll(() => viewport.evaluate(el => ({top:el.scrollTop,left:el.scrollLeft}))).toEqual(position);
});

test('search detail protects drafts and refreshes saved results on return', async ({ page, demo }) => {
  const workspace = (await demo.inject('/api/v1/projects/phase-one/tasks')).json().data;
  const task = workspace.tasks.find((task: { status: string }) => task.status === 'todo');
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill(task.id);
  await page.locator('a.task-detail-card').click();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await page.getByRole('textbox', { name: '任务描述', exact: true }).fill('搜索详情中保留的草稿');
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '保留并继续编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue('搜索详情中保留的草稿');
  await page.goBack();
  await page.getByRole('button', { name: '保留并继续编辑', exact: true }).click();
  await page.getByRole('textbox', { name: /任务名称/ }).fill(`${task.title}（已核对）`);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑任务', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/from=search/);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue(task.id);
  await expect(page.locator('a.task-detail-card')).toContainText(`${task.title}（已核对）`);
  await page.locator('a.task-detail-card').click();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await page.getByRole('textbox', { name: '任务描述', exact: true }).fill('这段修改将放弃');
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '放弃未保存内容', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue(task.id);
  expect((await demo.inject(`/api/v1/projects/phase-one/tasks/${task.id}`)).json().data.tasks.find((item: {id:string}) => item.id === task.id).description).toBe('搜索详情中保留的草稿');
});

test('search opens completed tasks outside list filters with readonly permissions', async ({ page, demo }) => {
  const task = (await demo.inject('/api/v1/projects/phase-one/tasks')).json().data.tasks.find((task: {status:string}) => task.status === 'done');
  await page.goto('/projects/phase-one/tasks');
  await page.getByLabel('任务体验身份').selectOption('xu');
  await page.getByLabel('搜索任务', {exact:true}).fill('本地列表无匹配');
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill(task.id);
  await page.locator('a.task-detail-card').click();
  await expect(page.getByRole('dialog')).toContainText('只读身份');
  await expect(page.getByRole('button', { name: '编辑任务', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await expect(page.getByLabel('搜索任务', {exact:true})).toHaveValue('本地列表无匹配');
  await expect(page.getByLabel('任务体验身份')).toHaveValue('xu');
});

test('search task load failures retry and unavailable tasks return to search', async ({ page }) => {
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('招聘');
  const card = page.locator('a.task-detail-card').first();
  const id = await card.locator('.task-reference').innerText();
  const path = `**/api/v1/projects/phase-one/tasks/${id}`;
  await page.route(path, route => route.fulfill({status:503, json:{error:{message:'暂时无法读取任务，请重试。'}}}));
  await card.click();
  await expect(page.getByRole('button', {name:'返回搜索结果',exact:true})).toBeVisible();
  await page.unroute(path);
  await page.getByRole('button', {name:'重新加载任务',exact:true}).click();
  await page.getByRole('button', {name:'关闭任务详情',exact:true}).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue('招聘');
  await page.route(path, route => route.fulfill({status:404, json:{error:{message:'任务不存在或无权访问'}}}));
  await card.click();
  await page.getByRole('button', {name:'返回搜索结果',exact:true}).click();
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue('招聘');
});

test('reloading a search detail without a return session closes to the task list', async ({ page }) => {
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('招聘');
  await page.locator('a.task-detail-card').first().click();
  await expect(page.getByRole('button', {name:'关闭任务详情',exact:true})).toBeVisible();
  await page.reload();
  await page.getByRole('button', {name:'关闭任务详情',exact:true}).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveCount(0);
});

test('search return survives related task switches and discarded edits', async ({ page, demo }) => {
  const prefix = '/api/v1/projects/phase-one/tasks';
  const workspace = (await demo.inject(prefix)).json().data;
  const original = workspace.tasks.find((task: {status:string}) => task.status === 'todo');
  const response = await demo.inject({method:'POST', url:prefix,
    headers:{'x-preview-token':workspace.writeToken, 'x-demo-actor':'zhou', 'idempotency-key':crypto.randomUUID()},
    payload:{title:'搜索关联任务测试', description:'独立测试任务', workstreamId:original.workstreamId, parentId:original.id, ownerId:'chen', priority:'P1', effortHours:null, requiresReview:false, reviewerId:null, acceptanceCriteria:'', evidence:'', expectedPlanVersion:workspace.planVersion, confirmParentConversion:true, expectedParentVersion:original.version},
  });
  expect(response.statusCode, response.body).toBe(200);
  const child = response.json().data.task;
  await page.getByRole('button', {name:'刷新首页',exact:true}).click();
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill(child.title);
  await page.locator('a.task-detail-card').click();
  await page.getByRole('button', {name:/所属父任务/}).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${child.parentId}\\?from=search`));
  await page.getByRole('tab', {name:/^子任务/}).click();
  await page.locator('.td-related-task').filter({hasText:child.title}).click();
  await page.getByRole('tab', {name:'活动记录',exact:true}).click();
  await page.getByLabel('补充进展').fill('未保存的备注');
  await page.getByRole('tab', {name:'详情',exact:true}).click();
  await page.getByRole('button', {name:/所属父任务/}).click();
  await page.getByRole('button', {name:'放弃未保存内容',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${child.parentId}\\?from=search`));
  await page.goBack();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue(child.title);
});

for (const width of [1440, 390, 320]) {
  test(`search details and restored results fit ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('招聘');
    await page.locator('a.task-detail-card').first().click();
    await expect(page.getByRole('button', { name: '关闭任务详情', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`search-task-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toHaveValue('招聘');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`search-return-${width}.png`), animations: 'disabled' });
  });
}

test('settings navigation opens the implemented final module', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '成员与设置', exact: true }).click();
  await expect(page).toHaveURL(/settings$/);
  await expect(page.getByRole('heading', { name: '成员与设置', exact: true })).toBeVisible();
});

test('read failure can recover without fabricating a successful result', async ({ page }) => {
  await page.route('**/api/v1/projects/phase-one/overview', route => route.fulfill({ status: 503, body: '{}' }));
  await page.getByRole('button', { name: '刷新首页', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时');
  await page.unroute('**/api/v1/projects/phase-one/overview');
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
});

for (const width of [1440, 390, 320]) {
  test(`responsive homepage ${width}px stays usable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`homepage-${width}.png`), fullPage: true, animations:'disabled' });
    if (width < 768) {
      await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
      await page.getByRole('button', { name: '打开导航' }).click();
      await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused();
      await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '搜索任务或风险' })).toBeVisible();
      await page.getByRole('button', { name: '关闭详情' }).click();
    }
  });
}

test('preview dev server blocks unrelated private files', async ({ request }) => {
  for (const name of ['.node-version', 'data/homepage-demo.sqlite', '.env']) {
    const path = fileURLToPath(new URL(`../../${name}`, import.meta.url)).replaceAll('\\', '/');
    const response = await request.get(encodeURI(`/@fs${path.startsWith('/') ? '' : '/'}${path}`), {
      headers: { accept: 'application/octet-stream' },
    });
    expect([403, 404], name).toContain(response.status());
  }
});

test('homepage review queue includes only a genuinely submitted milestone',async({page,demo})=>{
 const prefix='/api/v1/projects/phase-one/milestones';
 const write=async(path:string,payload:Record<string,unknown>,actor:string)=>{const w=(await demo.inject(prefix)).json().data;const r=await demo.inject({method:'POST',url:prefix+path,headers:{'x-preview-token':w.writeToken,'x-demo-actor':actor,'idempotency-key':crypto.randomUUID()},payload:{...payload,expectedPlanVersion:w.planVersion}});expect(r.statusCode,r.body).toBe(200);return r.json().data.milestone;};
 let m=await write('',{title:'首页真实提交验收节点',description:'有明确必要条件和成果的正式提交',workstreamId:'system-bottom',ownerId:'chen',reviewerId:'lin',date:'2026-09-25',criteria:[{id:'homepage-evidence',title:'核对报告',kind:'evidence',taskId:null}]},'zhou');
 m=await write(`/${m.id}/draft`,{expectedVersion:m.version,summary:'已完成核对',links:['https://example.com/delivery'],evidence:[{criterionId:'homepage-evidence',description:'报告已核对',links:['https://example.com/report'],declared:true}]},'chen');
 await write(`/${m.id}/transition`,{expectedVersion:m.version,action:'submit'},'chen');
 await page.getByRole('button',{name:'刷新首页',exact:true}).click(); await page.getByRole('tab',{name:'待验收',exact:true}).click(); await expect(page.locator('.attention-item')).toHaveCount(1); await expect(page.locator('.attention-item')).toContainText(m.title); await expect(page.locator('.attention-item')).not.toContainText('公共能力范围评审');
 await page.getByRole('button',{name:'查看全部待处理',exact:true}).click(); const card=page.locator('.milestone-detail-card').filter({hasText:m.title}); await expect(card.locator('.task-status')).toHaveText('待验收'); await card.getByRole('link',{name:'打开里程碑详情',exact:true}).click(); await expect(page.getByRole('dialog',{name:'里程碑详情',exact:true})).toContainText(m.title);
});
