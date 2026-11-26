import { test as base, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthSession, IssuedCredential } from '../../shared/src/auth.js';

// Every account, password and project in this file belongs to a throw-away SQLite database.
const adminPassword = 'Projects-browser-admin-2026';
const memberPassword = 'Projects-browser-member-2026';
type Login = { cookie: string; session: AuthSession };
interface ProjectsFixture { app: FastifyInstance; db: Database.Database; adminLogin: Login }

async function fulfill(route: Route, app: FastifyInstance) {
  const request = route.request(), url = new URL(request.url());
  const response = await app.inject({
    method: request.method() as 'GET' | 'POST' | 'PATCH',
    url: url.pathname + url.search,
    headers: await request.allHeaders(),
    payload: request.postData() || undefined,
  });
  const headers = Object.fromEntries(Object.entries(response.headers)
    .filter(([name]) => !['content-length', 'transfer-encoding', 'connection'].includes(name))
    .map(([name, value]) => [name, Array.isArray(value) ? value.join('\n') : String(value)]));
  await route.fulfill({ status: response.statusCode, headers, body: response.body });
}

async function installApi(context: BrowserContext, app: FastifyInstance) {
  await context.route('**/api/v1/**', route => fulfill(route, app));
}

const test = base.extend<{ projectsFixture: ProjectsFixture }>({
  projectsFixture: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'goodwork-projects-browser-'));
    const dbPath = join(directory, 'projects.sqlite');
    const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath, clock: () => new Date('2026-09-07T08:00:00Z'), snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0, secureCookies: false });
    const db = new Database(dbPath);
    try {
      await createInitialAdmin(db, { username: 'admin', name: '多项目测试管理员', password: adminPassword });
      await app.ready();
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: adminPassword } });
      expect(response.statusCode, response.body).toBe(200);
      const adminLogin = { cookie: String(response.headers['set-cookie']).split(';')[0]!, session: response.json().data as AuthSession };
      await use({ app, db, adminLogin });
    } finally {
      await app.close(); db.close(); await rm(directory, { recursive: true, force: true });
    }
  },
  context: async ({ context, projectsFixture }, use) => {
    await installApi(context, projectsFixture.app);
    try { await use(context); } finally { await context.unrouteAll({ behavior: 'wait' }); }
  },
});

function writeHeaders(login: Login) {
  return { cookie: login.cookie, 'x-csrf-token': login.session.csrfToken, origin: 'http://127.0.0.1:5174', 'idempotency-key': crypto.randomUUID() };
}

async function createAccount(app: FastifyInstance, admin: Login, username: string, name: string) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/admin/users', headers: writeHeaders(admin),
    payload: { username, name, systemRole: 'user', canCreateProjects: false },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data as IssuedCredential;
}

async function login(page: Page, username = 'admin', password = adminPassword, expectWorkspace = true) {
  await page.goto('/login?redirect=/workspace');
  await page.getByLabel('登录账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  if (expectWorkspace) await expect(page.getByRole('heading', { name: /我的项目|还没有可访问的项目/ })).toBeVisible();
}


async function ordinaryProject(fixture: ProjectsFixture) {
  const response = await fixture.app.inject({ method: 'POST', url: '/api/v1/projects', headers: writeHeaders(fixture.adminLogin), payload: { name: '交付管理项目', goal: '交付管理验收', start: '2026-09-01', end: '2026-12-31' } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data.id as string;
}
async function assertOrdinary(page: Page) {
  await expect(page.locator('.demo-label:visible')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('DEMO');
  await expect(page.locator('body')).not.toContainText('本机示例');
  await expect(page.locator('.task-demo-note, .task-demo, .demo-strip, .plan-demo-banner, .risk-demo-note, .settings-demo, .analytics-notice').filter({ visible: true })).toHaveCount(0);
}
const modules = [
  ['overview', '项目总览'], ['plan', '完整计划'], ['tasks', '任务管理'],
  ['analytics', '统计分析'], ['risks', '风险中心'], ['settings', '成员与设置'], ['workstreams', '工作分组'],
];

test('ordinary project pages, dialogs, CSV and refresh consistently omit demo wrappers', async ({page, projectsFixture}) => {
  test.setTimeout(60000);
  const id = await ordinaryProject(projectsFixture);
  await login(page);
  for (const [path, heading] of modules) {
    await page.goto(`/projects/${id}/${path}`);
    await expect(page.getByRole('heading', {name: heading, exact: true}).first()).toBeVisible();
    // Footer/content appears only after the module data has loaded.
    await expect(page.locator('.page-loading, .task-loading').filter({visible:true})).toHaveCount(0);
    await assertOrdinary(page);
  }
  await page.goto(`/projects/${id}/tasks`);
  await page.getByRole('button', {name: /新建任务/}).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await assertOrdinary(page);
  await page.getByLabel(/任务名称/).fill('正式交付任务');
  await page.getByRole('button', {name: '创建任务', exact:true}).click();
  await expect(page.getByText('正式交付任务', {exact:true}).first()).toBeVisible();
  await assertOrdinary(page);
  await page.reload(); await expect(page.getByRole('dialog')).toBeVisible(); await assertOrdinary(page);
  await page.getByRole('button', {name:'关闭任务详情',exact:true}).click();
  await page.goto(`/projects/${id}/plan`);
  await page.getByRole('button', {name: '展开通用工作', exact: true}).click();
  await expect(page.getByText('正式交付任务', {exact:true}).first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name: /导出/}).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toContain('交付管理项目');
  expect(file.suggestedFilename()).not.toContain('DEMO');
  expect(await readFile((await file.path())!, 'utf8')).not.toContain('DEMO');
  await page.goto(`/projects/${id}/analytics`);
  await expect(page.getByRole('heading', {name:'统计分析',exact:true})).toBeVisible();
  const analyticDownload = page.waitForEvent('download');
  await page.getByRole('button', {name:/导出/}).first().click();
  const csv = await analyticDownload;
  expect(csv.suggestedFilename()).toContain('交付管理项目');
  expect(csv.suggestedFilename()).not.toContain('DEMO');
  const csvText = await readFile((await csv.path())!, 'utf8');
  expect(csvText).not.toContain('DEMO'); expect(csvText).toContain('已验收且无需复核'); expect(csvText).toContain('取消项不计分母');
});

test('switching sample and ordinary projects and direct links retain correct labels and guide', async ({page,projectsFixture}) => {
  const id = await ordinaryProject(projectsFixture);
  await login(page);
  await page.goto('/projects/phase-one/tasks');
  await expect(page.locator('.demo-label').first()).toBeVisible();
  await page.getByRole('button',{name:'切换项目',exact:true}).click();
  await page.getByRole('button',{name:/交付管理项目/}).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}/tasks$`));
  await expect(page.getByRole('heading',{name:'这里暂时没有任务',exact:true})).toBeVisible();
  await assertOrdinary(page);
  await page.getByRole('button',{name:'项目指南',exact:true}).click();
  await expect(page.getByText('普通项目',{exact:true})).toBeVisible();
  await expect(page.getByText(/数据保存在运行本系统的设备上/)).toBeVisible();
  await assertOrdinary(page);
  await page.getByRole('button',{name:'返回总览',exact:true}).click();
  await page.getByRole('button',{name:'站内通知',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await assertOrdinary(page);
  await expect(page.getByRole('dialog')).toContainText('此处仅展示个人站内通知');
  await expect(page.getByRole('dialog')).toContainText('项目飞书群通知由“成员与设置 → 通知与集成”单独管理');
  await page.getByRole('button',{name:'关闭站内通知',exact:true}).click();
  await page.getByRole('button',{name:'切换项目',exact:true}).click();
  await page.getByRole('button',{name:/我有好活示例项目/}).click();
  await expect(page).toHaveURL(/phase-one\/tasks$/);
  await expect(page.locator('.demo-label').first()).toBeVisible();
  await page.reload(); await expect(page.locator('.demo-label').first()).toBeVisible();
});

for (const width of [1440,390,320]) test(`ordinary and sample task pages fit ${width}px`,async({page,projectsFixture},testInfo)=>{
  const id = await ordinaryProject(projectsFixture);
  await page.setViewportSize({width,height:width===1440?900:844}); await login(page);
  await page.goto(`/projects/${id}/tasks`);
  await expect(page.getByRole('heading',{name:'这里暂时没有任务',exact:true})).toBeVisible();
  await assertOrdinary(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`ordinary-${width}.png`),fullPage:true,animations:'disabled'});
  await page.goto('/projects/phase-one/tasks');
  await expect(page.locator('.demo-label').first()).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`sample-${width}.png`),fullPage:true,animations:'disabled'});
});
