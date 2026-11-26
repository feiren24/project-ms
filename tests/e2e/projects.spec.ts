import { test as base, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function firstLogin(page: Page, username: string, initialPassword: string) {
  await login(page, username, initialPassword, false);
  await expect(page.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible();
  await page.getByLabel('当前密码（初始密码）', { exact: true }).fill(initialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(memberPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(memberPassword);
  await page.getByRole('button', { name: '保存并进入工作空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: /我的项目|还没有可访问的项目|项目总览/ })).toBeVisible();
}

async function createProject(page: Page, name: string, goal = `${name}的浏览器验收目标`) {
  if (!/\/workspace$/.test(page.url())) await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /创建新项目|创建第一个项目/, exact: false }).first().click();
  return fillAndConfirmProject(page, name, goal);
}

async function createProjectFromSwitcher(page: Page, name: string, goal = `${name}的浏览器验收目标`) {
  await page.getByRole('button', { name: '切换项目', exact: true }).click();
  await page.getByRole('button', { name: '＋ 创建新项目', exact: true }).click();
  return fillAndConfirmProject(page, name, goal);
}

async function fillAndConfirmProject(page: Page, name: string, goal: string) {
  const dialog = page.getByRole('dialog', { name: '创建新项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill(name);
  await dialog.getByLabel('项目目标', { exact: true }).fill(goal);
  await dialog.getByLabel('开始日期', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('结束日期', { exact: true }).fill('2026-12-31');
  await dialog.getByRole('button', { name: '核对项目资料', exact: true }).click();
  await page.getByRole('button', { name: '确认创建项目', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview$/);
  return page.url().match(/\/projects\/([^/]+)\/overview$/)![1]!;
}

async function openModule(page: Page, label: string, route: string, heading = label) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${route}$`));
  await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
}

async function createTask(page: Page, title: string) {
  await page.getByRole('button', { name: /新建任务/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/任务名称/).fill(title);
  await dialog.getByLabel('任务描述', { exact: true }).fill('仅用于多项目隔离浏览器验收。');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
}

test.describe('real login multi-project workspace', () => {
  test('creates a blank project and keeps every module and new task isolated from the legacy project', async ({ page, projectsFixture }) => {
    await login(page);
    let unexpectedLeavePrompts = 0;
    page.on('dialog', async prompt => { unexpectedLeavePrompts++; await prompt.dismiss(); });
    const legacyTasks = (projectsFixture.db.prepare("SELECT COUNT(*) AS n FROM task_meta WHERE project_id='phase-one'").get() as { n: number }).n;
    const projectId = await createProject(page, '空白交付项目');
    expect(unexpectedLeavePrompts).toBe(0);

    await expect(page.locator('.demo-strip')).toHaveCount(0);
    await expect(page.getByText('待安排任务', { exact: true })).toBeVisible();
    await expect(page.locator('.completion-card')).toContainText('已完成 0 / 0 项任务');
    await expect(page.getByText('这一分类暂时没有待处理事项。', { exact: true })).toBeVisible();

    await openModule(page, '完整计划', 'plan');
    await expect(page.getByLabel('对比基线', { exact: true })).toHaveValue('');
    await expect(page.locator('.plan-page')).toContainText('通用工作');
    await openModule(page, '任务管理', 'tasks');
    await expect(page.getByRole('heading', { name: '这里暂时没有任务', exact: true })).toBeVisible();
    await openModule(page, '统计分析', 'analytics');
    await expect(page.getByText('当前筛选没有执行任务。可调整工作分组、负责人或计划窗口查看其他任务。', { exact: true })).toBeVisible();
    await openModule(page, '风险中心', 'risks');
    await expect(page.getByRole('heading', { name: '当前筛选下没有风险', exact: true })).toBeVisible();
    await openModule(page, '成员与设置', 'settings');
    await expect(page.getByTestId('member-row')).toHaveCount(1);
    await expect(page.locator('.settings-summary')).toContainText('工作日历');
    await expect(page.locator('.settings-summary')).toContainText('待确认');

    await openModule(page, '任务管理', 'tasks');
    await createTask(page, '仅属于空白项目的任务');
    expect((projectsFixture.db.prepare('SELECT COUNT(*) AS n FROM task_meta WHERE project_id=?').get(projectId) as { n: number }).n).toBe(1);
    expect((projectsFixture.db.prepare("SELECT COUNT(*) AS n FROM task_meta WHERE project_id='phase-one'").get() as { n: number }).n).toBe(legacyTasks);
    await page.goto('/projects/phase-one/tasks');
    await expect(page.getByText('仅属于空白项目的任务', { exact: true })).toHaveCount(0);
  });

  test('switcher searches, marks the current project, preserves per-project filters and ignores a late older directory response', async ({ page, projectsFixture }) => {
    await login(page);
    const firstId = await createProject(page, '筛选项目甲');
    await openModule(page, '任务管理', 'tasks');
    await page.getByLabel('搜索任务', { exact: true }).fill('甲项目筛选');
    const secondId = await createProjectFromSwitcher(page, '筛选项目乙');
    await openModule(page, '任务管理', 'tasks');
    await page.getByLabel('搜索任务', { exact: true }).fill('乙项目筛选');

    const switcher = page.getByRole('button', { name: '切换项目', exact: true });
    await switcher.click();
    await expect(page.getByRole('button', { name: /筛选项目乙/ })).toHaveAttribute('aria-current', 'true');
    await page.getByLabel('搜索项目', { exact: true }).fill('筛选项目甲');
    await page.getByRole('button', { name: /筛选项目甲/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${firstId}/tasks$`));
    await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue('甲项目筛选');
    await switcher.click(); await page.getByRole('button', { name: /筛选项目乙/ }).click();
    await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue('乙项目筛选');

    await page.getByLabel('搜索任务', { exact: true }).fill('');
    await createTask(page, '用于详情切换的任务');
    await expect(page).toHaveURL(new RegExp(`/projects/${secondId}/tasks/[^/]+$`));
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${secondId}/tasks$`));
    await switcher.click(); await page.getByRole('button', { name: /筛选项目甲/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${firstId}/tasks$`));
    await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue('甲项目筛选');

    await page.getByLabel('搜索任务', { exact: true }).fill('');
    await page.getByRole('button', { name: /新建任务/ }).click();
    await page.getByLabel(/任务名称/).fill('浏览器返回时保留的任务草稿');
    const back = page.goBack().catch(() => null);
    await expect(page.getByRole('heading', { name: '还有未保存的内容', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保留并继续编辑', exact: true }).click();
    await back;
    await expect(page.getByLabel(/任务名称/)).toHaveValue('浏览器返回时保留的任务草稿');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '放弃未保存内容', exact: true }).click();

    let directoryRequests = 0;
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/v1/projects') return route.fallback();
      directoryRequests++;
      const response = await projectsFixture.app.inject({ url: '/api/v1/projects', headers: await route.request().allHeaders() });
      if (directoryRequests === 1) {
        const json = response.json(); json.data.projects = json.data.projects.filter((project: { id: string }) => project.id !== secondId);
        await new Promise(resolve => setTimeout(resolve, 300));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
      } else await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await switcher.click(); await switcher.click(); await switcher.click();
    await expect(page.getByRole('button', { name: /筛选项目乙/ })).toBeVisible();
    await page.waitForTimeout(350);
    await expect(page.getByRole('button', { name: /筛选项目乙/ })).toBeVisible();
    expect(directoryRequests).toBeGreaterThanOrEqual(2);
  });

  test('a slow directory response cannot unmount an admitted project or discard its task draft', async ({ page, projectsFixture }) => {
    await login(page);
    const projectId = await createProject(page, '草稿准入项目');
    await page.goto(`/projects/${projectId}/tasks`);
    await expect(page.getByRole('heading', { name: '任务管理', exact: true })).toBeVisible();

    let resolved = false;
    let releaseDirectory!: () => void;
    const directoryGate = new Promise<void>(resolve => { releaseDirectory = resolve; });
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/v1/projects') return route.fallback();
      const response = await projectsFixture.app.inject({ url: '/api/v1/projects', headers: await route.request().allHeaders() });
      const json = response.json();
      json.data.projects = json.data.projects.filter((project: { id: string }) => project.id !== projectId);
      await directoryGate; resolved = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
    });
    const switcher = page.getByRole('button', { name: '切换项目', exact: true });
    await switcher.click(); await switcher.click();
    await page.getByRole('button', { name: /新建任务/ }).click();
    await page.getByLabel(/任务名称/).fill('目录权限变化期间保留的草稿');
    releaseDirectory();
    await expect.poll(() => resolved).toBe(true);
    await expect(page.locator('.auth-access-notice')).toContainText('当前页面和填写内容已保留');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel(/任务名称/)).toHaveValue('目录权限变化期间保留的草稿');
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks$`));
  });

  test('two independent browser contexts keep different current projects', async ({ browser, page, projectsFixture }) => {
    await login(page);
    const firstId = await createProject(page, '窗口项目甲');
    await page.goto('/workspace');
    const secondId = await createProject(page, '窗口项目乙');
    await page.goto(`/projects/${firstId}/overview`);

    const otherContext = await browser.newContext();
    await installApi(otherContext, projectsFixture.app);
    const other = await otherContext.newPage();
    try {
      await login(other);
      await other.goto(`/projects/${secondId}/overview`);
      await expect(other.getByRole('button', { name: '切换项目', exact: true })).toContainText('窗口项目乙');
      await expect(page.getByRole('button', { name: '切换项目', exact: true })).toContainText('窗口项目甲');
      await other.getByRole('button', { name: '任务管理', exact: true }).click();
      await expect(other).toHaveURL(new RegExp(`/projects/${secondId}/tasks$`));
      await expect(page).toHaveURL(new RegExp(`/projects/${firstId}/overview$`));
    } finally { await otherContext.close(); }
  });

  test('a linked viewer lists only their project, cannot create, and cannot open another project', async ({ browser, page, projectsFixture }) => {
    const viewer = await createAccount(projectsFixture.app, projectsFixture.adminLogin, 'readonly.viewer', '只读验收成员');
    await login(page);
    const allowedId = await createProject(page, '只读成员可见项目');
    await openModule(page, '成员与设置', 'settings');
    await page.getByRole('button', { name: '添加项目成员', exact: true }).click();
    const memberDialog = page.getByRole('dialog', { name: '添加项目成员', exact: true });
    await memberDialog.locator('select').first().selectOption(viewer.user.id);
    await memberDialog.locator('select').nth(1).selectOption('viewer');
    await expect(memberDialog.locator('textarea')).toHaveCount(0);
    await memberDialog.getByRole('button', { name: '核对成员信息', exact: true }).click();
    await page.getByRole('button', { name: '确认添加成员', exact: true }).click();
    await expect(page.getByTestId('member-row').filter({ hasText: 'readonly.viewer' })).toContainText('只读成员');

    const viewerContext = await browser.newContext(); await installApi(viewerContext, projectsFixture.app);
    const viewerPage = await viewerContext.newPage();
    try {
      await firstLogin(viewerPage, 'readonly.viewer', viewer.initialPassword);
      if (!/\/workspace$/.test(viewerPage.url())) await viewerPage.getByRole('link', { name: 'GooodWork 项目列表', exact: true }).click();
      await expect(viewerPage.getByRole('button', { name: `打开项目 只读成员可见项目`, exact: true })).toBeVisible();
      await expect(viewerPage.getByRole('button', { name: /创建新项目|创建第一个项目/ })).toHaveCount(0);
      await expect(viewerPage.getByText('我有好活示例项目', { exact: true })).toHaveCount(0);
      await viewerPage.goto('/projects/phase-one/tasks');
      await expect(viewerPage.getByRole('heading', { name: '无法访问此项目', exact: true })).toBeVisible();
      await viewerPage.getByRole('button', { name: '返回项目列表', exact: true }).click();
      await viewerPage.getByRole('button', { name: `打开项目 只读成员可见项目`, exact: true }).click();
      await viewerPage.getByRole('button', { name: '任务管理', exact: true }).click();
      await expect(viewerPage.getByRole('button', { name: /新建任务/ })).toBeDisabled();
      await expect(viewerPage.locator('.task-page')).toContainText('只读');
      expect(viewerPage.url()).toContain(`/projects/${allowedId}/tasks`);

      const memberId = (projectsFixture.db.prepare('SELECT member_id FROM project_user_links WHERE project_id=? AND user_id=?').get(allowedId, viewer.user.id) as { member_id: string }).member_id;
      projectsFixture.db.prepare("UPDATE project_members SET role='manager' WHERE project_id=? AND id=?").run(allowedId, memberId);
      await viewerPage.getByRole('button', { name: '完整计划', exact: true }).click();
      await expect(viewerPage.getByRole('heading', { name: '完整计划', exact: true })).toBeVisible();
      await expect(viewerPage.getByRole('button', { name: '发布基线', exact: true })).toBeVisible();
    } finally { await viewerContext.close(); }
  });

  test('an administrator explicitly links an enabled account to a legacy member without changing member identity or role', async ({ page, projectsFixture }) => {
    const account = await createAccount(projectsFixture.app, projectsFixture.adminLogin, 'legacy.link', '历史成员登录账号');
    const before = projectsFixture.db.prepare("SELECT id,role FROM project_members WHERE project_id='phase-one' AND id='xu'").get() as { id: string; role: string };
    await login(page);
    await page.goto('/projects/phase-one/settings');
    await expect(page.getByRole('heading', { name: '成员与设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关联账号 许景行', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '关联成员登录账号', exact: true });
    await dialog.locator('select').first().selectOption(account.user.id);
    await dialog.locator('textarea').fill('管理员明确关联历史只读成员');
    await dialog.getByRole('button', { name: '核对成员信息', exact: true }).click();
    await page.getByRole('button', { name: '确认关联账号', exact: true }).click();
    await expect(page.getByTestId('member-row').filter({ hasText: '许景行' })).toContainText('legacy.link');
    expect(projectsFixture.db.prepare("SELECT id,role FROM project_members WHERE project_id='phase-one' AND id='xu'").get()).toEqual(before);
    expect(projectsFixture.db.prepare("SELECT member_id,user_id FROM project_user_links WHERE project_id='phase-one' AND user_id=?").get(account.user.id)).toEqual({ member_id: 'xu', user_id: account.user.id });
  });

  test('project profile stays consistent after update and preserves the draft across a version conflict', async ({ page, projectsFixture }) => {
    await login(page);
    const projectId = await createProject(page, '资料项目原名', '资料项目原目标');
    await openModule(page, '成员与设置', 'settings');
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await page.getByRole('button', { name: '编辑项目资料', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '编辑项目资料', exact: true });
    await dialog.getByLabel('项目名称', { exact: true }).fill('资料项目新名');
    await dialog.getByLabel('项目目标', { exact: true }).fill('更新后的项目目标保持一致');
    await dialog.getByLabel('开始日期', { exact: true }).fill('2026-10-02');
    await dialog.getByLabel('结束日期', { exact: true }).fill('2026-12-30');
    await expect(dialog.getByLabel('修改原因', { exact: true })).toHaveCount(0);
    projectsFixture.db.prepare('UPDATE settings_projects SET version=version+1 WHERE project_id=?').run(projectId);
    await dialog.getByRole('button', { name: '核对项目资料', exact: true }).click();
    await page.getByRole('button', { name: '确认保存项目', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '确认项目资料', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('项目资料已更新');
    await dialog.getByRole('button', { name: '读取最新状态并保留填写', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '编辑项目资料', exact: true });
    await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('资料项目新名');
    await expect(dialog.getByLabel('项目目标', { exact: true })).toHaveValue('更新后的项目目标保持一致');
    await dialog.getByRole('button', { name: '核对项目资料', exact: true }).click();
    await page.getByRole('button', { name: '确认保存项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '资料项目新名', exact: false })).toHaveCount(0);
    await expect(page.locator('.project-profile')).toContainText('资料项目新名');
    await expect(page.locator('.project-profile')).toContainText('更新后的项目目标保持一致');
    await expect(page.locator('.project-profile')).toContainText('2026-10-02 → 2026-12-30');
    await expect(page.getByRole('button', { name: '切换项目', exact: true })).toContainText('资料项目新名');
    await page.goto('/workspace');
    await expect(page.getByRole('button', { name: '打开项目 资料项目新名', exact: true })).toContainText('更新后的项目目标保持一致');
  });

  for (const width of [1440, 390, 320]) test(`project directory, switcher, creation and membership dialog fit ${width}px`, async ({ page, projectsFixture }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await createAccount(projectsFixture.app, projectsFixture.adminLogin, `candidate${width}`, `候选成员${width}`);
    await login(page);
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`projects-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: /创建新项目/, exact: false }).first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`project-create-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const projectId = await createProject(page, `响应式项目${width}`);
    await page.getByRole('button', { name: '切换项目', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`project-switcher-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.goto(`/projects/${projectId}/settings`);
    await expect(page.getByRole('heading', { name: '成员与设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加项目成员', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加项目成员', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`membership-${width}.png`), animations: 'disabled' });
  });
});
