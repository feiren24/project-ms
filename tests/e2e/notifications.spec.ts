import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { enqueueJob } from '../../server/src/jobs/store';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
const prefix = '/api/v1/projects/phase-one';
const test = base.extend<{ demo: FastifyInstance; dbPath: string }>({
  dbPath: async ({}, use) => { const dir = await mkdtemp(join(tmpdir(), 'goodwork-notification-browser-')); try { await use(join(dir, 'fixture.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); } },
  demo: async ({dbPath}, use) => { const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath, jobIntervalMs: 0, clock: () => new Date('2026-09-23T06:00:00Z') }); await app.ready(); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => { const r = route.request(), url = new URL(r.url()); const response = await demo.inject({ method: r.method() as 'GET'|'POST'|'PATCH', url: url.pathname + url.search, headers: r.headers(), payload: r.postData() || undefined }); await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body }); }); await use(page);
  },
});
async function addMember(demo: FastifyInstance, name = '通知测试成员') {
  const w = (await demo.inject(`${prefix}/settings`)).json().data;
  const r = await demo.inject({ method: 'POST', url: `${prefix}/settings/member_create`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() }, payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: 'DEMO · 验证通知与协作刷新', member: { name, role: 'member', active: true } } }); expect(r.statusCode, r.body).toBe(200);
}
test('notification read state persists and settings target returns to module', async ({ page, demo }) => {
  await addMember(demo); await page.goto('/projects/phase-one/overview?notifications=open');
  const row = page.getByTestId('notification-row').filter({ hasText: '成员与设置已更新' }).first(); await expect(row).toBeVisible();
  await row.getByRole('button', { name: /标为已读/ }).click();
  await page.getByRole('button', { name: '全部通知', exact: true }).click(); await expect(row).toContainText('已读');
  await page.reload(); await page.getByRole('button', { name: '全部通知', exact: true }).click(); await expect(row).toContainText('已读');
  await row.getByRole('button', { name: /查看/ }).click(); await expect(page).toHaveURL(/\/settings$/); await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('readonly notification identity cannot manage jobs and empty state is explicit', async ({ page }) => {
  await page.goto('/projects/phase-one/settings?notifications=open'); await page.getByLabel('通知体验身份', { exact: true }).selectOption('xu');
  await expect(page.getByRole('button', { name: '后台作业', exact: true })).toHaveCount(0); await expect(page.getByRole('dialog')).toContainText('暂无');
});
test('version changes preserve an open draft; explicit refresh keeps filters and reads latest members', async ({ page, demo }) => {
  await page.goto('/projects/phase-one/settings'); await expect(page.getByTestId('member-row')).toHaveCount(4);
  await page.getByRole('button', { name: '添加项目成员', exact: true }).click(); await page.getByLabel('成员姓名', { exact: true }).fill('未保存的草稿');
  await addMember(demo, '另一页面成员'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.collaboration-banner')).toContainText('项目有新版本'); await expect(page.getByLabel('成员姓名', { exact: true })).toHaveValue('未保存的草稿');
  // Native modal makes the underlying refresh inaccessible; even programmatic activation is guarded.
  await page.getByRole('button', { name: '更新当前页面', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByLabel('成员姓名', { exact: true })).toHaveValue('未保存的草稿');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: /丢弃.*离开|放弃.*离开|确认离开/ }).click();
  await page.getByRole('button', { name: '个人容量', exact: true }).click(); await page.getByRole('button', { name: '更新当前页面', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人容量', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.collaboration-banner')).toHaveCount(0);
  await page.getByRole('button', { name: '项目成员', exact: true }).click(); await expect(page.getByTestId('member-row')).toHaveCount(5);
});
test('automatic alert notification opens the matching evidence drawer', async ({ page, demo }) => {
  const w = (await demo.inject(`${prefix}/notifications?actorId=zhou`)).json().data;
  const item = w.notifications.find((n: { target: { id?: string } }) => n.target.id?.startsWith('alert-')); expect(item).toBeTruthy();
  await page.goto('/projects/phase-one/overview?notifications=open');
  await page.getByTestId('notification-row').filter({ hasText: item.title }).first().getByRole('button', { name: /查看/ }).click();
  await expect(page).toHaveURL(/risks\?alertId=/); await expect(page.getByRole('dialog')).toContainText(item.title.replace('风险预警 · ', '')); await expect(page.getByText('未找到这个风险', { exact: false })).toHaveCount(0);
});
for (const width of [1440, 390, 320]) test(`notification panel and job list fit ${width}px`, async ({ page, demo }) => {
  await addMember(demo); await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await page.goto('/projects/phase-one/settings?notifications=open');
  await expect(page.getByTestId('notification-row').first()).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/notifications-${width}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '后台作业', exact: true }).click(); await expect(page.getByTestId('background-job').first()).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/jobs-${width}.png`, animations: 'disabled' });
});

test('a second browser context sees the update without losing its local draft', async ({ browser, page, demo }) => {
  await page.goto('/projects/phase-one/settings'); await expect(page.getByTestId('member-row')).toHaveCount(4);
  const second = await browser.newContext(); const editor = await second.newPage();
  try {
    await editor.route('**/api/v1/**', async route => { const r = route.request(), url = new URL(r.url()); const response = await demo.inject({ method: r.method() as 'GET'|'POST', url: url.pathname + url.search, headers: r.headers(), payload: r.postData() || undefined }); await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body }); });
    await editor.goto('/projects/phase-one/settings'); await expect(editor.getByTestId('member-row')).toHaveCount(4);
    await editor.getByRole('button', { name: '添加项目成员', exact: true }).click(); await editor.getByLabel('成员姓名', { exact: true }).fill('第二窗口草稿');
    await page.getByRole('button', { name: '添加项目成员', exact: true }).click(); await page.getByLabel('成员姓名', { exact: true }).fill('第一窗口已保存'); await expect(page.getByLabel('变更原因', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '核对变更', exact: true }).click(); await page.getByRole('button', { name: '确认保存', exact: true }).click(); await expect(page.getByTestId('member-row')).toHaveCount(5);
    await editor.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(editor.locator('.collaboration-banner')).toContainText('项目有新版本'); await expect(editor.getByLabel('成员姓名', { exact: true })).toHaveValue('第二窗口草稿');
  } finally { await second.close(); }
});
test('failed job requires confirmation and recovers after a lost retry response', async ({ page, demo, dbPath }) => {
  const db = new Database(dbPath); const now = new Date('2026-09-23T06:00:00Z');
  const id = enqueueJob(db, { projectId: 'phase-one', kind: 'notification', dedupeKey: 'browser-retry', dueAt: now, payload: { eventKey: 'browser-retry', recipientId: 'zhou', kind: 'settings.updated', title: 'DEMO · 重试恢复通知', message: '隔离测试通知', target: { kind: 'settings' } } }, now);
  db.prepare("UPDATE background_jobs SET status='failed',attempts=4,error='DEMO · 测试故障' WHERE id=?").run(id); db.close();
  await page.goto('/projects/phase-one/settings?notifications=open'); await page.getByRole('button', { name: '后台作业', exact: true }).click();
  await page.getByRole('button', { name: `重试作业 ${id}`, exact: true }).click();
  let dropped = false;
  await page.route('**/notifications/jobs/*/retry', async route => { if (dropped) return route.fallback(); dropped = true; const r = route.request(); const response = await demo.inject({ method: 'POST', url: `${prefix}/notifications/jobs/${id}/retry`, headers: r.headers(), payload: r.postData()! }); expect(response.statusCode).toBe(200); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'DEMO · 重试响应中断' } }) }); });
  await page.getByRole('button', { name: '确认重试', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('响应中断'); await page.getByRole('button', { name: '重试操作', exact: true }).click();
  await expect(page.getByTestId('background-job').filter({ hasText: id })).toContainText('执行成功');
  const w = (await demo.inject(`${prefix}/notifications?actorId=zhou`)).json().data; expect(w.notifications.filter((n: { title: string }) => n.title === 'DEMO · 重试恢复通知')).toHaveLength(1);
});
