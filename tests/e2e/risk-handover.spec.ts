import { test as base, expect, type Page, type Route } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { ManagedRisk } from '../../shared/src/risks.js';

const prefix = '/api/v1/projects/phase-one', password = 'Browser-risk-handover-2026';
interface Fixture { app: FastifyInstance; db: Database.Database; risk: ManagedRisk }
async function forward(route: Route, app: FastifyInstance) {
  const request = route.request(), url = new URL(request.url());
  const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: url.pathname + url.search, headers: await request.allHeaders(), payload: request.postData() || undefined });
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection'].includes(name)).map(([name, value]) => [name, Array.isArray(value) ? value.join('\n') : String(value)]));
  await route.fulfill({ status: response.statusCode, headers, body: response.body });
}
function readRisk(f: Fixture): ManagedRisk { return JSON.parse((f.db.prepare('SELECT snapshot_json FROM risk_records WHERE id=?').get(f.risk.id) as { snapshot_json: string }).snapshot_json); }
function storeRisk(f: Fixture, risk: ManagedRisk) { f.db.prepare('UPDATE risk_records SET snapshot_json=? WHERE id=?').run(JSON.stringify(risk), risk.id); }
const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'goodwork-risk-handover-browser-')), dbPath = join(directory, 'test.sqlite');
    const app = buildApp({ allowedOrigins: [process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5186'], dbPath, clock: () => new Date('2026-09-23T06:00:00Z'), snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0, secureCookies: false });
    const db = new Database(dbPath);
    try {
      await createInitialAdmin(db, { username: 'admin', name: '浏览器移交管理员', password }); await app.ready();
      db.prepare("UPDATE project_members SET role='project_admin' WHERE id='lin'").run();
      const risk = JSON.parse((db.prepare('SELECT snapshot_json FROM risk_records LIMIT 1').get() as { snapshot_json: string }).snapshot_json) as ManagedRisk;
      Object.assign(risk, { title: '历史风险责任移交验收', ownerId: 'chen', owner: '陈知远', closeReviewerId: 'xu', status: 'pending_close', probability: 3, impact: 4, score: 12, level: 'high', actionTaskIds: [], closure: { reason: '保留的历史关闭申请', submittedBy: 'chen', taskVersions: {}, residualReasons: {} } });
      const f = { app, db, risk }; storeRisk(f, risk); await use(f);
    } finally { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
  },
  page: async ({ page, fixture }, use) => {
    await page.route('**/api/v1/**', route => forward(route, fixture.app));
    try { await use(page); } finally { await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
  },
});
async function open(page: Page, fixture: Fixture) {
  await page.goto(`/projects/phase-one/risks/${fixture.risk.id}`);
  const form = page.locator('.auth-page:visible');
  await form.getByLabel('登录账号', { exact: true }).fill('admin'); await form.getByLabel('密码', { exact: true }).fill(password); await form.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function prepare(page: Page) {
  const drawer = page.getByRole('dialog'); await drawer.getByRole('button', { name: '移交责任', exact: true }).click();
  const owner = drawer.getByRole('combobox', { name: '接手责任人', exact: true }), reviewer = drawer.getByRole('combobox', { name: '接手关闭复核人', exact: true });
  await expect(owner).toBeVisible();
  expect(await owner.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(['', 'zhou', 'lin']);
  await owner.selectOption('lin'); await reviewer.selectOption('zhou'); return drawer;
}
for (const width of [1440, 390, 320]) test(`handover candidates, reason, cancel and pending snapshot at ${width}px`, async ({ page, fixture }, info) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await open(page, fixture);
  const drawer = page.getByRole('dialog'); await expect(drawer).toContainText('需要责任移交'); await prepare(page);
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await expect(drawer.getByRole('button', { name: '确认移交责任', exact: true })).toHaveCount(0);
  await drawer.getByLabel('移交原因', { exact: true }).fill('管理职责调整，交接范围已核对');
  await drawer.getByRole('button', { name: '取消', exact: true }).click(); await expect(drawer).toContainText('保留未保存内容'); await drawer.getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: '接手责任人', exact: true })).toHaveValue('lin');
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await expect(drawer).toContainText('责任人移交给 林若宁');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const confirmation = drawer.locator('.td-action-panel').filter({ hasText: '请核对后确认' });
  await confirmation.scrollIntoViewIfNeeded(); await expect(confirmation).toBeInViewport();
  await page.screenshot({ path: info.outputPath(`handover-confirm-${width}.png`), animations: 'disabled' });
  await drawer.getByRole('button', { name: '确认移交责任', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '确认移交责任', exact: true })).toHaveCount(0);
  await expect(drawer).not.toContainText('需要责任移交'); await expect(drawer).toContainText('管理职责调整，交接范围已核对');
  expect(readRisk(fixture)).toMatchObject({ ownerId: 'lin', closeReviewerId: 'zhou', status: 'pending_close', closure: fixture.risk.closure, version: fixture.risk.version + 1 });
});

test('handover version conflict retains choices and reason, reload requires review, lost response retries once', async ({ page, fixture }) => {
  await open(page, fixture); const drawer = await prepare(page);
  await drawer.getByLabel('移交原因', { exact: true }).fill('冲突后保留的交接原因'); await drawer.getByRole('button', { name: '核对操作', exact: true }).click();
  storeRisk(fixture, { ...readRisk(fixture), version: fixture.risk.version + 1 });
  await drawer.getByRole('button', { name: '确认移交责任', exact: true }).click(); await expect(drawer.getByRole('alert')).toContainText('已更新');
  await drawer.getByRole('button', { name: '保留草稿并读取最新记录', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: '接手责任人', exact: true })).toHaveValue('lin'); await expect(drawer.getByLabel('移交原因', { exact: true })).toHaveValue('冲突后保留的交接原因');
  await expect(drawer.getByRole('button', { name: '核对操作', exact: true })).toBeVisible();
  let dropped = false;
  await page.route('**/risks/*/responsibilities', async route => {
    if (dropped) return route.fallback(); dropped = true;
    const req = route.request(), url = new URL(req.url()); const committed = await fixture.app.inject({ method: 'POST', url: url.pathname, headers: await req.allHeaders(), payload: req.postData()! }); expect(committed.statusCode, committed.body).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '移交响应中断，请重试' } }) });
  });
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await drawer.getByRole('button', { name: '确认移交责任', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('响应中断'); await drawer.getByRole('button', { name: '确认移交责任', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '确认移交责任', exact: true })).toHaveCount(0);
  expect(readRisk(fixture).events.filter(e => e.action === 'responsibilities')).toHaveLength(1);
});

test('closed historical responsibility can transfer before reopening', async ({ page, fixture }) => {
  storeRisk(fixture, { ...fixture.risk, status: 'closed' }); await open(page, fixture); const drawer = page.getByRole('dialog'); await expect(drawer).toContainText('重开前须完成责任移交');
  await prepare(page); await drawer.getByLabel('移交原因', { exact: true }).fill('历史关闭风险重新分配责任'); await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await drawer.getByRole('button', { name: '确认移交责任', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '确认移交责任', exact: true })).toHaveCount(0); expect(readRisk(fixture).status).toBe('closed'); expect(readRisk(fixture).closure).toEqual(fixture.risk.closure);
  const reopen = drawer.getByRole('button', { name: '重新打开', exact: true }); await reopen.click(); await drawer.getByRole('button', { name: '确认重新打开', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '确认重新打开', exact: true })).toHaveCount(0); expect(readRisk(fixture).status).toBe('monitoring'); expect(readRisk(fixture).closure).toEqual(fixture.risk.closure);
});

for (const recovery of ['save', 'cancel']) test(`concurrent handover rebases read-only edit fields and baseline on reload: ${recovery}`, async ({ page, fixture }) => {
  const original = { ...fixture.risk, status: 'identified' as const, ownerId: 'zhou', owner: '周亦安', closeReviewerId: 'lin', closure: null };
  storeRisk(fixture, original);
  // A separate authenticated project administrator performs the concurrent handover.
  fixture.db.prepare("INSERT INTO auth_users SELECT 'handover-manager','handover-manager','并发项目管理员','user',1,0,0,1,password_hash,created_at,updated_at FROM auth_users WHERE username='admin'").run();
  fixture.db.prepare("INSERT INTO project_user_links VALUES('phase-one','lin','handover-manager')").run();
  const login = await fixture.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'handover-manager', password } });
  expect(login.statusCode, login.body).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  await open(page, fixture);
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: '编辑风险', exact: true }).click();
  const owner = drawer.getByRole('combobox', { name: '责任人', exact: true });
  const reviewer = drawer.getByRole('combobox', { name: /^关闭复核人/ });
  await expect(owner).toBeDisabled(); await expect(reviewer).toBeDisabled();
  await drawer.getByLabel('风险标题', { exact: true }).fill('保留并发编辑的标题');
  await drawer.getByLabel('原因与影响', { exact: true }).fill('保留编辑者的风险说明');
  await drawer.getByLabel('应对措施', { exact: true }).fill('保留编辑者的应对措施');
  await drawer.getByLabel('处理期限', { exact: true }).fill('2026-10-20');
  await drawer.getByLabel('发生概率').selectOption('4');
  const transferred = await fixture.app.inject({ method: 'POST', url: `${prefix}/risks/${original.id}/responsibilities`, headers: { cookie, 'x-csrf-token': login.json().data.csrfToken, 'idempotency-key': crypto.randomUUID() }, payload: { expectedVersion: original.version, ownerId: 'lin', closeReviewerId: 'zhou', reason: '另一管理者完成责任移交' } });
  expect(transferred.statusCode, transferred.body).toBe(200);
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click();
  await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('已更新');
  await drawer.getByRole('button', { name: '保留草稿并读取最新记录', exact: true }).click();
  await expect(owner).toHaveValue('lin'); await expect(reviewer).toHaveValue('zhou');
  await expect(owner).toBeDisabled(); await expect(reviewer).toBeDisabled();
  await expect(drawer.getByLabel('风险标题', { exact: true })).toHaveValue('保留并发编辑的标题');
  await expect(drawer.getByLabel('原因与影响', { exact: true })).toHaveValue('保留编辑者的风险说明');
  await expect(drawer.getByLabel('应对措施', { exact: true })).toHaveValue('保留编辑者的应对措施');
  await expect(drawer.getByLabel('处理期限', { exact: true })).toHaveValue('2026-10-20');
  await expect(drawer.getByLabel('发生概率')).toHaveValue('4');
  await expect(drawer.getByRole('button', { name: '核对操作', exact: true })).toBeVisible();
  if (recovery === 'cancel') {
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await expect(drawer).toContainText('保留未保存内容');
    await drawer.getByRole('button', { name: '放弃草稿并继续', exact: true }).click();
    await drawer.getByRole('button', { name: '编辑风险', exact: true }).click();
    await expect(owner).toHaveValue('lin'); await expect(reviewer).toHaveValue('zhou');
    await expect(drawer.getByLabel('风险标题', { exact: true })).toHaveValue(original.title);
    // Rebasing the baseline must not make an untouched form dirty after cancellation.
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '编辑风险', exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '放弃草稿并继续', exact: true })).toHaveCount(0);
    await drawer.getByRole('button', { name: '编辑风险', exact: true }).click();
    await drawer.getByLabel('风险标题', { exact: true }).fill('取消后再次编辑');
  }
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click();
  await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '编辑风险', exact: true })).toBeVisible();
  await expect(drawer.getByRole('alert')).toHaveCount(0);
  expect(readRisk(fixture)).toMatchObject({ ownerId: 'lin', closeReviewerId: 'zhou', title: recovery === 'save' ? '保留并发编辑的标题' : '取消后再次编辑', version: original.version + 2 });
  if (recovery === 'save') expect(readRisk(fixture)).toMatchObject({ description: '保留编辑者的风险说明', response: '保留编辑者的应对措施', due: '2026-10-20', probability: 4 });
});
