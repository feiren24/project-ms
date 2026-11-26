import { test as base, expect, type Page, type Route } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthUser } from '../../shared/src/auth.js';

// All credentials and business data below belong exclusively to this temporary test database.
const adminPassword = 'Browser-test-admin-2026';
const workerPassword = 'Browser-test-worker-2026';
interface AuthFixture { app: FastifyInstance; db: Database.Database; admin: AuthUser }
async function forward(route: Route, app: FastifyInstance) {
  const request = route.request(), url = new URL(request.url());
  const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: url.pathname + url.search, headers: await request.allHeaders(), payload: request.postData() || undefined });
  // Preserve Set-Cookie so the browser manages a real HttpOnly session cookie.
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection'].includes(name)).map(([name, value]) => [name, Array.isArray(value) ? value.join('\n') : String(value)]));
  await route.fulfill({ status: response.statusCode, headers, body: response.body });
}
const test = base.extend<{ authFixture: AuthFixture }>({
  authFixture: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'goodwork-auth-browser-')), dbPath = join(directory, 'auth.sqlite');
    const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath, clock: () => new Date('2026-09-07T03:00:00Z'), snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0, secureCookies: false });
    const db = new Database(dbPath);
    try { const admin = await createInitialAdmin(db, { username: 'admin', name: '浏览器测试管理员', password: adminPassword }); await app.ready(); await use({ app, db, admin }); }
    finally { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
  },
  page: async ({ page, authFixture }, use) => {
    await page.route('**/api/v1/**', route => forward(route, authFixture.app));
    try { await use(page); }
    finally {
      // Drain callbacks before the dependent app fixture closes, including foreground session checks.
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
    }
  },
});
async function login(page: Page, username = 'admin', password = adminPassword) {
  const form = page.locator('.auth-page:visible');
  await form.getByLabel('登录账号', { exact: true }).fill(username);
  await form.getByLabel('密码', { exact: true }).fill(password);
  await form.getByRole('button', { name: '登录', exact: true }).click();
}
async function enterAdmin(page: Page) {
  await page.goto('/login'); await login(page);
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible();
  await page.goto('/admin/users'); await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
}
async function openCreate(page: Page, username = 'newworker') {
  await page.getByRole('button', { name: '＋ 开通账号', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '开通账号', exact: true });
  await dialog.getByLabel('姓名', { exact: true }).fill('浏览器测试成员');
  await dialog.getByLabel('登录账号').fill(username);
  await dialog.getByRole('button', { name: '核对并继续', exact: true }).click();
}
async function createWorker(page: Page, username = 'newworker') {
  await openCreate(page, username); await page.getByRole('button', { name: '确认开通账号', exact: true }).click();
  const password = await page.getByTestId('issued-password').innerText();
  await page.getByRole('button', { name: '已保存凭据，关闭', exact: true }).click();
  await expect(page.getByTestId('issued-password')).toHaveCount(0);
  return password;
}
async function logout(page: Page) {
  await page.goto('/projects/phase-one/overview');
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
}
async function fillPassword(page: Page, current: string) {
  await page.getByLabel('当前密码（初始密码）', { exact: true }).fill(current);
  await page.getByLabel('新密码', { exact: true }).fill(workerPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(workerPassword);
}

test.describe('real auth', () => {
for (const width of [1440, 390, 320]) test(`real login and user directory fit ${width}px without exposing demo identity controls`, async ({ page, context, authFixture }, testInfo) => {
  await page.setViewportSize({ width, height: 844 }); await page.goto('/projects/phase-one/tasks');
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
  await login(page, 'admin', 'Incorrect-password-2026'); await expect(page.getByRole('alert')).toContainText('账号或密码不正确');
  await login(page); await expect(page.getByRole('heading', { name: '任务管理', exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find(item => item.name === 'goodwork_session'); expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('goodwork_session');
  expect(authFixture.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 1 });
  await expect(page.getByLabel(/体验身份/)).toHaveCount(0);
  await page.goto('/admin/users'); await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  await expect(page.getByTestId(width > 640 ? 'user-row' : 'user-card').filter({ hasText: '浏览器测试管理员' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`users-${width}.png`), fullPage: true });
  await openCreate(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width <= 640) expect((await page.getByRole('dialog').boundingBox())?.width).toBe(width);
  await page.screenshot({ path: testInfo.outputPath(`create-confirm-${width}.png`), fullPage: true });
});

test('account creation shows credentials once, then first login forces password change and grants no project', async ({ page, authFixture }) => {
  await enterAdmin(page); const initial = await createWorker(page);
  const row = authFixture.db.prepare('SELECT id,must_change_password FROM auth_users WHERE username=?').get('newworker') as { id: string; must_change_password: number };
  expect(row.must_change_password).toBe(1); await logout(page); await login(page, 'newworker', initial);
  await expect(page.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toHaveCount(0);
  await fillPassword(page, initial); await page.getByRole('button', { name: '保存并进入工作空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有可访问的项目', exact: true })).toBeVisible();
  await expect(page.getByText('请联系项目负责人将你的账号加入项目。创建项目需管理员授权。', { exact: true })).toBeVisible();
  expect(authFixture.db.prepare('SELECT must_change_password FROM auth_users WHERE id=?').get(row.id)).toEqual({ must_change_password: 0 });
  expect(authFixture.db.prepare('SELECT * FROM project_user_links').all()).toEqual([]);
  await page.reload(); await expect(page.getByRole('heading', { name: '还没有可访问的项目', exact: true })).toBeVisible();
});

for (const requirePasswordChange of [false, true]) test(`expired real session preserves task draft${requirePasswordChange ? ' through forced password change' : ' through re-login'} without replaying its write`, async ({ page, authFixture }) => {
  await page.goto('/projects/phase-one/tasks'); await login(page);
  await expect(page.getByRole('heading', { name: '任务管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /新建任务/ }).click();
  await page.getByPlaceholder('例如：完成数据接口联调').fill('重新登录后保留的草稿');
  await page.getByLabel('任务描述', { exact: true }).fill('此内容不应随认证恢复丢失。');
  const before = authFixture.db.prepare('SELECT COUNT(*) AS n FROM task_meta').get();
  if (requirePasswordChange) authFixture.db.prepare('UPDATE auth_users SET must_change_password=1,version=version+1 WHERE id=?').run(authFixture.admin.id);
  authFixture.db.prepare('DELETE FROM auth_sessions').run();
  // Trigger the foreground session check without submitting or navigating away from the editor.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const reauth = page.getByRole('dialog', { name: '登录已过期', exact: true });
  await expect(reauth).toBeVisible(); await login(page);
  if (requirePasswordChange) {
    await expect(reauth.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible();
    await fillPassword(page, adminPassword); await reauth.getByRole('button', { name: '保存并进入工作空间', exact: true }).click();
  }
  await expect(reauth).not.toBeVisible();
  await expect(page.getByPlaceholder('例如：完成数据接口联调')).toHaveValue('重新登录后保留的草稿');
  await expect(page.getByLabel('任务描述', { exact: true })).toHaveValue('此内容不应随认证恢复丢失。');
  expect(authFixture.db.prepare('SELECT COUNT(*) AS n FROM task_meta').get()).toEqual(before);
});

test('lost password-change response recovers through explicit new-password login without a second change', async ({ page, authFixture }) => {
  await enterAdmin(page); const initial = await createWorker(page); await logout(page); await login(page, 'newworker', initial);
  await expect(page.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible();
  await page.route('**/api/v1/auth/password', async route => {
    const request = route.request(); const response = await authFixture.app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: await request.allHeaders(), payload: request.postData()! });
    expect(response.statusCode, response.body).toBe(200);
    // Drop both result and rotated cookie, matching a genuinely interrupted response.
    await route.fulfill({ status: 503, json: { error: { message: '响应中断，请确认修改结果。' } } });
  });
  await fillPassword(page, initial); await page.getByRole('button', { name: '保存并进入工作空间', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('响应中断');
  await page.getByRole('button', { name: '使用新密码重新登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有可访问的项目', exact: true })).toBeVisible();
  expect(authFixture.db.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE action='password_change'").get()).toEqual({ n: 1 });
});

test('lost initial credential response requires an explicit fresh reset with no duplicate account', async ({ page, authFixture }) => {
  await enterAdmin(page); let interrupted = false; const createKeys: string[] = [];
  await page.route('**/api/v1/admin/users', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const request = route.request(); createKeys.push((await request.allHeaders())['idempotency-key']!);
    if (interrupted) return route.fallback(); interrupted = true;
    const response = await authFixture.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: await request.allHeaders(), payload: request.postData()! }); expect(response.statusCode, response.body).toBe(200);
    await route.fulfill({ status: 503, json: { error: { message: '开户响应中断，请重试。' } } });
  });
  await openCreate(page); await page.getByRole('button', { name: '确认开通账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('响应中断');
  await page.getByRole('button', { name: '确认开通账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法再次显示');
  await page.getByRole('button', { name: '读取最新账号状态', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认重置密码', exact: true })).toBeVisible();
  expect(authFixture.db.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE action='password_reset'").get()).toEqual({ n: 0 });
  await page.getByRole('button', { name: '确认重置密码', exact: true }).click(); await expect(page.getByTestId('issued-password')).toBeVisible();
  expect(createKeys[0]).toBe(createKeys[1]); expect(authFixture.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get()).toEqual({ n: 2 });
  expect(authFixture.db.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE action='password_reset'").get()).toEqual({ n: 1 });
});

test('user version recovery with an expired session preserves the account draft until explicit re-login', async ({ page, authFixture }) => {
  await enterAdmin(page); await createWorker(page);
  const user = authFixture.db.prepare('SELECT id,version FROM auth_users WHERE username=?').get('newworker') as { id: string; version: number };
  await page.getByTestId('user-row').filter({ hasText: 'newworker' }).getByRole('button', { name: '编辑账号 newworker', exact: true }).click();
  await page.getByRole('dialog').getByLabel('姓名', { exact: true }).fill('保留账号编辑草稿');
  authFixture.db.prepare('UPDATE auth_users SET name=?,version=version+1 WHERE id=?').run('其他管理员更新的姓名', user.id);
  await page.getByRole('button', { name: '核对并继续', exact: true }).click();
  await page.getByRole('button', { name: '确认保存修改', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账号已被更新');
  authFixture.db.prepare('DELETE FROM auth_sessions').run();
  await page.getByRole('button', { name: '读取最新账号状态', exact: true }).click();
  const reauth = page.getByRole('dialog', { name: '登录已过期', exact: true });
  await expect(reauth).toBeVisible(); await login(page); await expect(reauth).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: '确认修改账号', exact: true })).toContainText('保留账号编辑草稿');
  await page.getByRole('button', { name: '读取最新账号状态', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('姓名', { exact: true })).toHaveValue('保留账号编辑草稿');
  await expect(page.getByRole('button', { name: '确认保存修改', exact: true })).toHaveCount(0);
  expect(authFixture.db.prepare('SELECT name,version FROM auth_users WHERE id=?').get(user.id)).toEqual({ name: '其他管理员更新的姓名', version: user.version + 1 });
});

test('login redirect to workspace opens the authenticated project directory', async ({ page }) => {
  await page.goto('/login?redirect=/workspace'); await login(page);
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开项目 我有好活示例项目', exact: true })).toBeVisible();
});

test('stale session CSRF prompts explicit re-login and preserves an unsubmitted task without replay', async ({ page, authFixture }) => {
  await page.goto('/projects/phase-one/tasks'); await login(page);
  await expect(page.getByRole('heading', { name: '任务管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /新建任务/ }).click();
  await page.getByPlaceholder('例如：完成数据接口联调').fill('安全凭据轮换后的原始任务草稿');
  await page.getByLabel('任务描述', { exact: true }).fill('重新登录只能恢复身份，不能自动创建任务。');
  const before = authFixture.db.prepare('SELECT COUNT(*) AS n FROM task_meta').get();
  // A valid browser cookie now points at a different CSRF token, as after a session
  // rotation in another tab. Keep the browser's in-memory token deliberately stale.
  authFixture.db.prepare('UPDATE auth_sessions SET csrf_token=? WHERE user_id=?').run(crypto.randomUUID(), authFixture.admin.id);
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/projects/phase-one/tasks') writes++; });
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/projects/phase-one/tasks' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const response = await rejected; expect(response.status()).toBe(403); expect((await response.json()).error.code).toBe('CSRF_REQUIRED');
  const reauth = page.getByRole('dialog', { name: '登录已过期', exact: true });
  await expect(reauth).toBeVisible(); await login(page); await expect(reauth).not.toBeVisible();
  await expect(page.getByPlaceholder('例如：完成数据接口联调')).toHaveValue('安全凭据轮换后的原始任务草稿');
  await expect(page.getByLabel('任务描述', { exact: true })).toHaveValue('重新登录只能恢复身份，不能自动创建任务。');
  expect(writes).toBe(1); expect(authFixture.db.prepare('SELECT COUNT(*) AS n FROM task_meta').get()).toEqual(before);
});
});
