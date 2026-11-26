import { test as base, expect, type Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import type { ManagedTask, TaskDraft, TaskWorkspace } from '../../shared/src/tasks';
const prefix = '/api/v1/projects/phase-one';
// Every API request, including mutations, stays in an isolated in-memory fixture.
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildLegacyApp({ dbPath: ':memory:', allowedOrigins: [process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174'] }); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const r = route.request(), u = new URL(r.url());
      const result = await demo.inject({ method: r.method() as 'GET'|'POST'|'PATCH', url: u.pathname + u.search, headers: r.headers(), payload: r.postData() || undefined });
      await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
    });
    try { await use(page); } finally { await page.unrouteAll({ behavior: 'wait' }); }
  },
});
async function workspace(demo: FastifyInstance): Promise<TaskWorkspace> { return (await demo.inject(`${prefix}/tasks`)).json().data; }
async function seed(demo: FastifyInstance, title: string, extra: Partial<TaskDraft> = {}): Promise<ManagedTask> {
  const w = await workspace(demo), parent = w.tasks.find(t => t.id === extra.parentId);
  const r = await demo.inject({ method: 'POST', url: `${prefix}/tasks`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() }, payload: {
    title, description: '隔离计划详情验收', workstreamId: 'system-bottom', parentId: null, ownerId: 'chen', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-10-12', end: '2026-10-14', expectedPlanVersion: w.planVersion,
    ...extra, ...(parent ? { confirmParentConversion: true, expectedParentVersion: parent.version } : {}),
  } });
  expect(r.statusCode, r.body).toBe(200); return r.json().data.task;
}
async function openPlan(page: Page, title: string, width = 1440) {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await page.goto('/projects/phase-one/plan');
  await page.getByLabel('搜索计划任务').fill(title);
  await page.locator(width < 768 ? '.plan-mobile-task' : '.gantt-name-button').filter({ hasText: title }).click();
  await expect(page.locator('.task-drawer')).toBeVisible();
}
for (const width of [1440,390,320]) test(`unified detail preserves plan view and drawer identity on save at ${width}px`, async ({ page,demo }) => {
  const task = await seed(demo,'计划详情保存验收'); await openPlan(page,task.title,width);
  await expect(page.getByRole('tab',{name:'详情',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'编辑任务',exact:true}).click();
  await page.getByRole('textbox',{name:'任务描述',exact:true}).fill('在完整计划中保存描述');
  const drawer = await page.locator('.task-drawer').elementHandle();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(page.locator('.task-drawer')).toContainText('在完整计划中保存描述');
  expect(await drawer!.evaluate(el=>el.isConnected)).toBe(true);
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click(); await expect(page.locator('.task-drawer')).toHaveCount(0);
  await expect(page.getByLabel('搜索计划任务')).toHaveValue(task.title);
  expect(new URL(page.url()).searchParams.has('task')).toBe(false);
  expect((await workspace(demo)).tasks.find(t=>t.id===task.id)?.description).toBe('在完整计划中保存描述');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('old deep links preserve query and browser back protects drafts',async({page,demo})=>{
  const task=await seed(demo,'计划链接草稿'); await page.goto(`/projects/phase-one/plan?custom=keep&task=${task.id}`);
  await expect(page.locator('.task-drawer')).toContainText(task.title); await expect(page.getByLabel('搜索计划任务')).toHaveValue('');
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click(); expect(new URL(page.url()).searchParams.get('custom')).toBe('keep');
  await page.getByLabel('搜索计划任务').fill(task.title); await page.locator('.gantt-name-button').filter({hasText:task.title}).click();
  await page.getByRole('button',{name:'编辑任务',exact:true}).click(); await page.getByRole('textbox',{name:'任务描述',exact:true}).fill('保留计划内草稿');
  await page.goBack(); await expect(page.getByRole('heading',{name:'还有未保存的内容'})).toBeVisible();
  await page.getByRole('button',{name:'保留并继续编辑'}).click(); await expect(page.getByRole('textbox',{name:'任务描述',exact:true})).toHaveValue('保留计划内草稿');
  await page.goBack(); await page.getByRole('button',{name:'放弃未保存内容',exact:true}).click(); await expect(page.locator('.task-drawer')).toHaveCount(0);
  await expect(page.getByLabel('搜索计划任务')).toHaveValue(task.title);
});
for(const width of [1440,390])test(`summary uses task detail and a visible related-task back action at ${width}px`,async({page,demo})=>{
  const original=await seed(demo,'汇总详情父项'),child=await seed(demo,'汇总详情子项',{parentId:original.id});
  const parent=(await workspace(demo)).tasks.find(t=>t.id===child.parentId)!;
  await page.setViewportSize({width,height:900});await page.goto('/projects/phase-one/plan');await page.getByLabel('搜索计划任务').fill(parent.title);
  await page.locator(width<768?'.plan-mobile-group':'.gantt-row.is-group .gantt-name-button').filter({hasText:parent.title}).click();
  await expect(page.locator('.task-drawer')).toContainText(parent.title);await page.getByRole('tab',{name:/^子任务/}).click();
  await page.locator('.td-related-task').filter({hasText:child.title}).click();await expect(page.locator('#td-title')).toHaveText(child.title);
  await page.getByRole('button',{name:`‹ 返回 ${parent.title}`,exact:true}).click();await expect(page.locator('#td-title')).toHaveText(parent.title);await expect(page.locator('.task-drawer')).toHaveCount(1);
});
test('detail retries and deletion requires a reason; deleted links offer the allowed recycle record',async({page,demo})=>{
  const task=await seed(demo,'计划删除验收');await page.route(`**/tasks/${task.id}`,route=>route.fulfill({status:503,json:{error:{message:'详情读取暂时失败'}}}),{times:1});
  await page.goto(`/projects/phase-one/plan?task=${task.id}`);await expect(page.getByRole('alert')).toContainText('详情读取暂时失败');await page.getByRole('button',{name:'重新读取任务',exact:true}).click();
  await expect(page.locator('.task-drawer')).toContainText(task.title);await page.getByLabel('任务更多操作',{exact:true}).click();await page.getByRole('button',{name:'删除任务',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'删除任务',exact:true});await expect(dialog).toContainText('关联检查：已通过');await expect(dialog.getByRole('button',{name:'移入回收站',exact:true})).toBeDisabled();
  await dialog.getByLabel('删除原因',{exact:false}).fill('重复任务，保留删除记录');await dialog.getByRole('button',{name:'移入回收站',exact:true}).click();await expect(page.locator('.task-drawer')).toHaveCount(0);
  await page.goto(`/projects/phase-one/plan?task=${task.id}`);await expect(page.getByRole('heading',{name:'任务已删除',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'查看删除记录',exact:true}).click();await expect(page).toHaveURL(/tasks\/deleted\?task=/);await expect(page.getByText('重复任务，保留删除记录',{exact:true}).first()).toBeVisible();
});
for (const gesture of ['move', 'resize'] as const) test(`direct adjust and ${gesture} carry a proposal, then refresh the plan on save`,async({page,demo})=>{
  const task=await seed(demo,'拖动排期验收');await page.setViewportSize({width:1440,height:900});await page.goto(`/projects/phase-one/plan?task=${task.id}&taskTab=plan`);
  await expect(page.locator('.task-drawer')).toBeVisible();await expect(page.getByRole('tab',{name:'计划与依赖',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByLabel('计划开始',{exact:true})).toHaveValue(task.start!);
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.locator('.task-drawer')).toHaveCount(0);await page.getByLabel('搜索计划任务').fill(task.title);await page.getByRole('button',{name:'周',exact:true}).click();
  const bar=page.locator('.gantt-row').filter({hasText:task.title}).locator('.gantt-bar');await bar.scrollIntoViewIfNeeded();const box=(await bar.boundingBox())!,x=gesture==='resize'?box.x+box.width-3:box.x+8;
  await page.mouse.move(x,box.y+box.height/2);await page.mouse.down();await page.mouse.move(x+28,box.y+box.height/2,{steps:6});await page.mouse.up();
  await expect(page.locator('.task-drawer')).toBeVisible();await expect(page.getByRole('tab',{name:'计划与依赖',exact:true})).toHaveAttribute('aria-selected','true');if(gesture==='move') await expect(page.getByLabel('计划开始',{exact:true})).not.toHaveValue(task.start!);
  else await expect(page.getByLabel('计划开始',{exact:true})).toHaveValue(task.start!);
  await expect(page.getByLabel('计划结束',{exact:true})).not.toHaveValue(task.end!);
  const proposedStart=await page.getByLabel('计划开始',{exact:true}).inputValue(),proposedEnd=await page.getByLabel('计划结束',{exact:true}).inputValue(),before=await workspace(demo);
  expect(before.tasks.find(t=>t.id===task.id)?.start).toBe(task.start);expect(before.tasks.find(t=>t.id===task.id)?.end).toBe(task.end);
  const drawer=await page.locator('.task-drawer').elementHandle();await page.getByRole('button',{name:'预览调整',exact:true}).click();await page.getByRole('button',{name:'确认保存调整',exact:true}).click();
  await expect(page.locator('.plan-version')).toHaveText(`执行计划 V${before.planVersion+1}`);expect(await drawer!.evaluate(el=>el.isConnected)).toBe(true);
  const after=(await workspace(demo)).tasks.find(t=>t.id===task.id)!;expect(after.start).toBe(proposedStart);expect(after.end).toBe(proposedEnd);
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.locator('.task-drawer')).toHaveCount(0);await expect(page.getByLabel('搜索计划任务')).toHaveValue(task.title);await expect(page.getByRole('button',{name:'周',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('scoped save retains canvas identity, zoom, filters, collapsed rows and scroll',async({page,demo})=>{
  await seed(demo,'画布状态验收');await page.setViewportSize({width:1440,height:900});await page.goto('/projects/phase-one/plan');
  await page.getByRole('button',{name:'展开全部',exact:true}).click();await page.getByRole('button',{name:'日',exact:true}).click();
  await page.getByLabel('对比基线',{exact:true}).selectOption('');
  await page.locator('[data-node-id="group-system-bottom"] .gantt-toggle').click();
  const viewport=page.locator('.gantt-viewport'),element=await viewport.elementHandle();
  await viewport.evaluate(el=>{el.scrollTop=220;el.scrollLeft=240;el.dispatchEvent(new Event('scroll'));});
  const row=page.locator('.gantt-row:not(.is-group) .gantt-name-button').first();await row.click();await expect(page.locator('.task-drawer')).toBeVisible();
  const before=await viewport.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft}));
  await page.getByRole('tab',{name:'活动记录',exact:true}).click();await page.getByLabel('补充进展').fill('验证计划内刷新');await page.getByRole('button',{name:'保存评论',exact:true}).click();
  await expect(page.locator('.td-event').first()).toContainText('验证计划内刷新');
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
  expect(await element!.evaluate(el=>el.isConnected)).toBe(true);
  expect(await viewport.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft}))).toEqual(before);
  await expect(page.getByRole('button',{name:'日',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByLabel('对比基线',{exact:true})).toHaveValue('');
  await viewport.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  await expect(page.locator('[data-node-id="group-system-bottom"] .gantt-toggle')).toHaveAttribute('aria-expanded','false');
});

test('workstream and gap stay readonly; milestone keeps its workspace; schedule flag does not remove ordering',async({page,demo})=>{
  const task=await seed(demo,'只读排期权限');
  await page.route('**/gantt',async route=>{const r=await demo.inject(`${prefix}/gantt`),body=r.json();body.data.canEditSchedule=false;await route.fulfill({status:200,json:body});});
  await page.setViewportSize({width:1440,height:900});await page.goto('/projects/phase-one/plan');
  await expect(page.getByRole('button',{name:'调整顺序',exact:true})).toBeVisible();
  await page.locator('[data-node-id="group-system-bottom"] .gantt-name-button').click();
  await expect(page.locator('.task-drawer')).toHaveCount(0);await expect(page.getByRole('dialog',{name:'计划详情',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'预览变更',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'关闭计划详情',exact:true}).click();
  await page.getByLabel('搜索计划任务').fill(task.title);await expect(page.locator('.gantt-resize')).toHaveCount(0);
  await page.goto(`/projects/phase-one/plan?task=${task.id}&taskTab=plan`);await expect(page.locator('.task-drawer')).toBeVisible();
  await expect(page.getByRole('button',{name:'预览调整',exact:true})).toHaveCount(0);await expect(page.getByLabel('计划开始',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByLabel('搜索计划任务').fill('运营范围待细化');await page.locator('.gantt-name-button').filter({hasText:'运营范围待细化'}).click();
  await expect(page.getByRole('dialog',{name:'计划详情',exact:true})).toContainText('运营范围待细化');await expect(page.locator('.task-drawer')).toHaveCount(0);await page.getByRole('button',{name:'关闭计划详情',exact:true}).click();
  const plan=(await demo.inject(`${prefix}/gantt`)).json().data,milestone=plan.nodes.find((n:{kind:string})=>n.kind==='milestone');
  await page.getByLabel('搜索计划任务').fill(milestone.title);await page.locator('.gantt-name-button').filter({hasText:milestone.title}).click();
  await expect(page).toHaveURL(new RegExp(`milestone=${milestone.id}`));await expect(page.locator('.task-drawer')).toHaveCount(0);await expect(page.getByRole('tab',{name:'里程碑',exact:true})).toHaveAttribute('aria-selected','true');
});

test('stale detail refresh retains the same drawer and its draft',async({page,demo})=>{
  const task=await seed(demo,'同任务刷新草稿');await openPlan(page,task.title);
  await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByLabel('任务描述',{exact:true}).fill('刷新仍保留本地修改');
  const drawer=await page.locator('.task-drawer').elementHandle();await seed(demo,'并发版本变化');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.getByRole('alert')).toContainText('更新');
  await page.getByRole('button',{name:'重新读取任务（保留填写内容）',exact:true}).click();
  await expect(page.getByLabel('任务描述',{exact:true})).toHaveValue('刷新仍保留本地修改');expect(await drawer!.evaluate(el=>el.isConnected)).toBe(true);
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.locator('.task-drawer')).toContainText('刷新仍保留本地修改');
  expect((await workspace(demo)).tasks.find(t=>t.id===task.id)?.description).toBe('刷新仍保留本地修改');
});

test('failed reload never traps the dirty-drawer leave confirmation under its error modal',async({page,demo})=>{
  const task=await seed(demo,'读取失败草稿保护');await openPlan(page,task.title);await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByLabel('任务描述',{exact:true}).fill('网络失败也不能丢失');
  await seed(demo,'令详情版本过期');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.getByRole('alert')).toContainText('更新');
  await page.route(`**/tasks/${task.id}`,route=>route.fulfill({status:503,json:{error:{message:'网络暂时不可用'}}}),{times:1});
  await page.getByRole('button',{name:'重新读取任务（保留填写内容）',exact:true}).click();
  const failure=page.getByRole('dialog',{name:'任务详情暂时无法加载',exact:true});await expect(failure).toContainText('网络暂时不可用');await failure.getByRole('button',{name:'返回计划',exact:true}).click();
  await page.getByRole('button',{name:'保留并继续编辑',exact:true}).click();
  await expect(page.getByLabel('任务描述',{exact:true})).toHaveValue('网络失败也不能丢失');await expect(failure).toHaveCount(0);
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByRole('button',{name:'放弃未保存内容',exact:true}).click();await expect(page.locator('.task-drawer')).toHaveCount(0);
});
