import { test as base, expect, type Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { SettingsWorkspace, SettingsMutation, SettingsOperation } from '../../shared/src/settings';
const prefix = '/api/v1/projects/phase-one';
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: ':memory:', clock: () => new Date('2026-09-23T06:00:00Z') }); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const r = route.request(), url = new URL(r.url());
      const result = await demo.inject({ method: r.method() as 'GET' | 'POST' | 'PATCH', url: url.pathname + url.search, headers: r.headers(), payload: r.postData() || undefined });
      await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
    }); await use(page);
  },
});
async function workspace(demo: FastifyInstance): Promise<SettingsWorkspace> { const r = await demo.inject(`${prefix}/settings`); expect(r.statusCode, r.body).toBe(200); return r.json().data; }
async function write(demo: FastifyInstance, operation: SettingsOperation, data: Partial<SettingsMutation>) {
  const w = await workspace(demo); const r = await demo.inject({ method: 'POST', url: `${prefix}/settings/${operation}`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() }, payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: 'DEMO · 设置浏览器验收', ...data } });
  expect(r.statusCode, r.body).toBe(200); return r.json().data as SettingsWorkspace;
}
async function enter(page: Page) { await page.goto('/projects/phase-one/settings'); await expect(page.getByRole('heading', { name: '成员与设置', exact: true })).toBeVisible(); await expect(page.getByTestId('member-row')).toHaveCount(4); }
async function fillMember(page: Page, name: string) { await page.getByRole('button', { name: '添加项目成员', exact: true }).click(); await page.getByLabel('成员姓名', { exact: true }).fill(name); await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0); }
async function confirm(page: Page) { await page.getByRole('button', { name: '核对变更', exact: true }).click(); await page.getByRole('button', { name: '确认保存', exact: true }).click(); }

test('new member persists and becomes a task assignment candidate', async ({ page, demo }) => {
  await enter(page); await fillMember(page, '沈予安'); await confirm(page);
  await expect(page.getByTestId('member-row').filter({ hasText: '沈予安' })).toBeVisible();
  const added = (await workspace(demo)).members.find(m => m.name === '沈予安')!; expect(added.active).toBe(true);
  await page.getByRole('button', { name: '任务管理', exact: true }).click(); await page.getByRole('button', { name: /新建任务/ }).click();
  await expect(page.getByRole('dialog').getByLabel(/负责人/).locator('option').filter({ hasText: '沈予安' })).toHaveCount(1);
  const tasks = (await demo.inject(`${prefix}/tasks`)).json().data; expect(tasks.actors.some((a: { id: string }) => a.id === added.id)).toBe(true);
});

test('save response interruption retries without creating duplicate members', async ({ page, demo }) => {
  await enter(page); let dropped = false;
  await page.route('**/settings/member_create', async route => {
    if (dropped) return route.fallback(); dropped = true; const r = route.request();
    const result = await demo.inject({ method: 'POST', url: `${prefix}/settings/member_create`, headers: r.headers(), payload: r.postData()! }); expect(result.statusCode).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '保存响应中断，请重试。' } }) });
  });
  await fillMember(page, '叶清和'); await confirm(page); await expect(page.getByRole('dialog')).toContainText('响应中断');
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(page.getByTestId('member-row').filter({ hasText: '叶清和' })).toHaveCount(1);
  expect((await workspace(demo)).members.filter(m => m.name === '叶清和')).toHaveLength(1);
});

test('stale settings retain drafts and require a fresh confirmation after recovery', async ({ page, demo }) => {
  await enter(page); await fillMember(page, '程望舒');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toContainText('离开将丢弃');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(page.getByLabel('成员姓名', { exact: true })).toHaveValue('程望舒');
  await write(demo, 'capacity', { capacity: { memberId: 'chen', hoursPerDay: 4, exceptions: {} } });
  await confirm(page); await expect(page.getByRole('dialog')).toContainText('设置已更新');
  await page.getByRole('button', { name: '刷新最新设置并保留草稿', exact: true }).click();
  await expect(page.getByLabel('成员姓名', { exact: true })).toHaveValue('程望舒');
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toHaveCount(0);
  await confirm(page); await expect(page.getByTestId('member-row').filter({ hasText: '程望舒' })).toBeVisible();
});

test('member with active responsibilities cannot be disabled and draft remains editable', async ({ page, demo }) => {
  await enter(page); await page.getByRole('button', { name: '编辑成员 陈知远', exact: true }).click();
  await page.getByLabel('成员启用状态', { exact: true }).uncheck(); await page.getByLabel('变更原因', { exact: true }).fill('DEMO · 验证移交保护'); await confirm(page);
  await expect(page.getByRole('dialog')).toContainText('请先移交');
  expect((await workspace(demo)).members.find(m => m.id === 'chen')?.active).toBe(true);
  await page.getByRole('button', { name: '返回修改', exact: true }).click(); await expect(page.getByLabel('成员启用状态', { exact: true })).not.toBeChecked();
});

test('readonly identity sees configuration without mutation actions', async ({ page }) => {
  await enter(page); await page.getByLabel('设置体验身份', { exact: true }).selectOption('xu');
  await expect(page.locator('.settings-page')).toContainText('只读');
  const add = page.getByRole('button', { name: '添加项目成员', exact: true });
  if (await add.count()) await expect(add).toBeDisabled();
  for (const tab of ['工作日历', '个人容量']) { await page.getByRole('button', { name: tab, exact: true }).click(); await expect(page.getByRole('button', { name: /编辑工作日历|设置容量/ })).toHaveCount(0); }
});

test('calendar confirmation and configured capacity flow through to analytics and risk evaluation', async ({ page, demo }) => {
  await enter(page); const initial = (await demo.inject(`${prefix}/gantt`)).json().data;
  await page.getByRole('button', { name: '工作日历', exact: true }).click(); await page.getByRole('button', { name: '编辑工作日历', exact: true }).click();
  await page.getByLabel('日历已确认', { exact: true }).check(); await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0); await confirm(page);
  await expect(page.locator('.settings-page')).toContainText('已确认');
  await page.getByRole('button', { name: '个人容量', exact: true }).click(); await page.getByRole('button', { name: '设置容量 陈知远', exact: true }).click();
  await page.getByLabel('容量未配置', { exact: true }).uncheck(); await page.getByLabel('每日容量', { exact: true }).fill('1'); await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0); await confirm(page);
  const state = await workspace(demo); expect(state.capacities.find(c => c.memberId === 'chen')?.hoursPerDay).toBe(1);
  const plan = (await demo.inject(`${prefix}/gantt`)).json().data;
  expect(plan.baselines).toEqual(initial.baselines); expect(plan.nodes.map((n: { id: string; start: string; end: string }) => [n.id,n.start,n.end])).toEqual(initial.nodes.map((n: { id: string; start: string; end: string }) => [n.id,n.start,n.end]));
  await page.getByRole('button', { name: '统计分析', exact: true }).click(); await page.getByRole('button', { name: '资源负荷', exact: true }).click(); await page.getByLabel('容量计算方式', { exact: true }).selectOption('configured');
  await expect(page.locator('.analytics-capacity-notice')).toContainText('已配置个人容量');
  const report = (await demo.inject(`${prefix}/analytics?capacityMode=configured`)).json().data;
  expect(report.capacity.members.find((m: { id: string }) => m.id === 'chen').cells.some((c: { status: string }) => c.status === 'overload')).toBe(true);
  const risks = (await demo.inject(`${prefix}/risks`)).json().data; expect(risks.alerts.some((a: { rule: string; status: string }) => a.rule === 'capacity_overload' && a.status === 'open')).toBe(true);
});

test('an invalidated identity is not silently replaced by a project manager', async ({ page, demo }) => {
  const w = await write(demo, 'member_create', { member: { name: '苏星遥', role: 'member', active: true } });
  const member = w.members.find(m => m.name === '苏星遥')!;
  await page.goto('/projects/phase-one/settings'); await expect(page.getByTestId('member-row')).toHaveCount(5);
  await page.getByLabel('设置体验身份', { exact: true }).selectOption(member.id);
  await write(demo, 'member_update', { member: { id: member.id, name: member.name, role: member.role, active: false } });
  await page.getByRole('button', { name: '刷新设置', exact: true }).click();
  await expect(page.getByLabel('设置体验身份', { exact: true })).toHaveValue('');
  await expect(page.locator('.settings-page')).toContainText('请重新选择');
  await expect(page.getByRole('button', { name: '添加项目成员', exact: true })).toHaveCount(0);
});

test('permission recovery allows an explicit identity choice without discarding the draft', async ({ page, demo }) => {
  const w = await write(demo, 'member_create', { member: { name: '顾时安', role: 'manager', active: true } });
  const manager = w.members.find(m => m.name === '顾时安')!;
  await page.goto('/projects/phase-one/settings'); await expect(page.getByTestId('member-row')).toHaveCount(5);
  await page.getByLabel('设置体验身份', { exact: true }).selectOption(manager.id); await fillMember(page, '江知禾');
  await write(demo, 'member_update', { member: { id: manager.id, name: manager.name, active: manager.active, role: 'viewer' } });
  await confirm(page); await expect(page.getByRole('dialog')).toContainText('负责人');
  await page.getByRole('button', { name: '刷新最新设置并保留草稿', exact: true }).click();
  await page.getByLabel('恢复体验身份', { exact: true }).selectOption('zhou');
  await expect(page.getByLabel('成员姓名', { exact: true })).toHaveValue('江知禾'); await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toHaveCount(0); await confirm(page);
  await expect(page.getByTestId('member-row').filter({ hasText: '江知禾' })).toBeVisible();
});

test('date exceptions are editable and previewed on a narrow screen', async ({ page, demo }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await enter(page);
  await page.getByRole('button', { name: '工作日历', exact: true }).click(); await page.getByRole('button', { name: '编辑工作日历', exact: true }).click();
  await page.getByRole('button', { name: /添加日期例外/ }).click(); await page.getByLabel('第 1 条日期例外', { exact: true }).fill('2026-10-01');
  await page.getByLabel('第 1 条例外安排', { exact: true }).selectOption('false');
  await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0); await page.getByRole('button', { name: '核对变更', exact: true }).click();
  await expect(page.locator('.settings-preview')).toContainText('2026-10-01'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/settings-320-日历确认.png', animations: 'disabled' });
  await page.getByRole('button', { name: '确认保存', exact: true }).click(); expect((await workspace(demo)).calendar.exceptions['2026-10-01']).toBe(false);
  await page.getByRole('button', { name: '个人容量', exact: true }).click(); await page.getByRole('button', { name: '设置容量 陈知远', exact: true }).click();
  await page.getByRole('button', { name: /添加日期例外/ }).click(); await page.getByLabel('第 1 条日期例外', { exact: true }).fill('2026-10-02'); await page.getByLabel('第 1 条例外工时', { exact: true }).fill('0');
  await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0); await page.getByRole('button', { name: '核对变更', exact: true }).click();
  await expect(page.locator('.settings-preview')).toContainText('2026-10-02'); await page.screenshot({ path: 'test-results/settings-320-容量确认.png', animations: 'disabled' }); await page.getByRole('button', { name: '确认保存', exact: true }).click();
  expect((await workspace(demo)).capacities.find(c => c.memberId === 'chen')?.exceptions['2026-10-02']).toBe(0);
});

for (const width of [1440, 390, 320]) test(`settings ${width}px tabs and member form fit`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await enter(page);
  for (const view of ['项目成员','工作日历','个人容量']) {
    await page.getByRole('button', { name: view, exact: true }).click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/settings-${width}-${view}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '项目成员', exact: true }).click(); await page.getByRole('button', { name: '添加项目成员', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/settings-${width}-成员表单.png`, animations: 'disabled' });
});

test('reason requirement follows the latest member role after conflict recovery', async ({ page, demo }) => {
 await enter(page);await fillMember(page,'分级冲突成员');await confirm(page);
 const member=(await workspace(demo)).members.find(m=>m.name==='分级冲突成员')!;
 await page.getByRole('button',{name:'编辑成员 分级冲突成员',exact:true}).click();
 await expect(page.getByLabel('变更原因',{exact:true})).toHaveCount(0);
 await page.getByLabel('成员角色',{exact:true}).selectOption('project_admin');
 await expect(page.getByLabel('变更原因',{exact:true})).toHaveAttribute('required','');
 await page.getByLabel('成员角色',{exact:true}).selectOption('member');
 await expect(page.getByLabel('变更原因',{exact:true})).toHaveCount(0);
 await write(demo,'member_update',{member:{id:member.id,name:member.name,role:'viewer',active:true}});
 await confirm(page);await expect(page.getByRole('dialog')).toContainText('设置已更新');
 await page.getByRole('button',{name:'刷新最新设置并保留草稿',exact:true}).click();
 await expect(page.getByLabel('变更原因',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'核对变更',exact:true}).click();
 await expect(page.getByRole('button',{name:'确认保存',exact:true})).toHaveCount(0);
 expect((await workspace(demo)).members.find(m=>m.id===member.id)?.role).toBe('viewer');
 await page.getByLabel('变更原因',{exact:true}).fill('恢复当前协作职责');await confirm(page);
 expect((await workspace(demo)).members.find(m=>m.id===member.id)?.role).toBe('member');
});
