import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp } from '../../server/src/app.js';
import { hashPassword } from '../../server/src/modules/auth/passwords.js';
import { issueSession, publicUser, userById } from '../../server/src/modules/auth/store.js';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174';
const prefix = '/api/v1/projects/phase-one';
const now = new Date('2026-09-11T03:00:00Z');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goodwork-module-privacy-'));
  const dbPath = join(directory, 'fixture.sqlite');
  const app = buildApp({ allowedOrigins: [baseURL], dbPath, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0, secureCookies: false });
  await app.ready();
  const db = new Database(dbPath), password = await hashPassword('Isolated-privacy-browser-2026');
  for (const [id, role] of Object.entries({ owner: 'manager', admin: 'project_admin', member: 'member', viewer: 'viewer', system: 'viewer' })) {
    db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,1,0,0,1,?,?,?)').run(id, id, `测试${id}`, id === 'system' ? 'admin' : 'user', password, now.toISOString(), now.toISOString());
    db.prepare("INSERT INTO project_members(project_id,id,name,role,active) VALUES('phase-one',?,?,?,1)").run(id, `测试${id}`, role);
    db.prepare("INSERT INTO project_user_links VALUES('phase-one',?,?)").run(id, id);
  }
  return { app, db, paths: [] as string[], session: (id: string) => issueSession(db, publicUser(userById(db, id)!), now),
    downgrade(id = 'admin') { db.prepare("UPDATE project_members SET role='member' WHERE project_id='phase-one' AND id=?").run(id); },
    async close() { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ system: Fixture }>({
  system: async ({}, use) => { const system = await fixture(); try { await use(system); } finally { await system.close(); } },
  context: async ({ context, system }, use) => {
    await context.route('**/api/v1/**', async route => {
      const request = route.request(), url = new URL(request.url()); system.paths.push(url.pathname);
      const response = await system.app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: url.pathname + url.search, headers: await request.allHeaders(), payload: request.postData() || undefined });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await use(context); await context.unrouteAll({ behavior: 'wait' });
  },
});
// These scenarios include isolated database setup and several full-page navigations.
test.setTimeout(60_000);
async function enter(context: BrowserContext, page: Page, system: Fixture, id: string, path = 'overview') {
  const login = system.session(id);
  await context.clearCookies(); await context.addCookies([{ name: 'goodwork_session', value: login.token, url: baseURL, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(`/projects/phase-one/${path}`);
}
async function hiddenNav(page: Page) {
  for (const name of ['统计分析', '风险中心', '成员与设置']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
}
for (const [role, width] of [['member', 1440], ['viewer', 390], ['member', 320]] as const) test(`${role} privacy and team collaboration at ${width}px`, async ({ page, context, system }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await enter(context, page, system, role);
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
  await hiddenNav(page);
  await expect(page.getByText('高风险事项', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '风险', exact: true })).toHaveCount(0);
  await expect(page.locator('.stream-table')).toContainText('陈知远');
  await expect(page.locator('.pa-panel')).toContainText('完成任务、调整计划或更新工作分组后');
  await expect(page.locator('.pa-panel')).not.toContainText('重要风险');
  // Fast-forward initial layout transitions so the screenshot captures the settled shell.
  await page.screenshot({ path: info.outputPath(`overview-${width}.png`), fullPage: true, animations: 'disabled' });
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const grid = document.querySelector('.metric-grid')!;
    return { sidebarRight: bounds('.sidebar').right, contentLeft: bounds('.workspace').left,
      titleLeft: bounds('.heading-title').left, breadcrumbLeft: bounds('.breadcrumb').left,
      metricLeft: bounds('.metric-card').left, lastMetricRight: bounds('.metric-card:last-child').right,
      gridRight: bounds('.metric-grid').right, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      scrollX, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(layout.scrollX).toBe(0); expect(layout.overflow).toBe(false);
  expect(layout.columns).toBe(width >= 768 ? 3 : 2);
  if (width >= 768) {
    for (const left of [layout.contentLeft, layout.titleLeft, layout.breadcrumbLeft, layout.metricLeft]) expect(left).toBeGreaterThanOrEqual(layout.sidebarRight - 1);
    expect(Math.abs(layout.lastMetricRight - layout.gridRight)).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: '搜索任务', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或负责人' }).fill('陈知远');
  await expect(page.locator('[data-search-task]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '风险', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  for (const [path, heading] of [['tasks', '任务管理'], ['plan', '完整计划'], ['workstreams', '工作分组']]) {
    await page.goto(`/projects/phase-one/${path}`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByTestId('module-access-denied')).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(system.paths.filter(path => /\/(analytics|risks|settings)(\/|$)/.test(path))).toEqual([]);
});
for (const role of ['owner', 'admin', 'system']) test(`${role} retains all management modules`, async ({ page, context, system }) => {
  await enter(context, page, system, role);
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
  for (const name of ['统计分析', '风险中心', '成员与设置']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.getByText('高风险事项', { exact: true })).toBeVisible();
});
for (const path of ['analytics', 'risks', 'risks/risk-001', 'settings?tab=integrations']) test(`restricted direct URL ${path} denies before module fetch`, async ({ page, context, system }) => {
  await enter(context, page, system, 'member', path);
  await expect(page.getByTestId('module-access-denied')).toBeVisible();
  await hiddenNav(page);
  expect(system.paths.filter(path => /\/(analytics|risks|settings)(\/|$)/.test(path))).toEqual([]);
  await page.getByRole('button', { name: '返回项目总览', exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
});
test('revision downgrade removes dirty settings without prompting and clears cached tabs', async ({ page, context, system }) => {
  await enter(context, page, system, 'admin', 'settings');
  await page.getByRole('button', { name: '编辑成员 测试member', exact: true }).click();
  await page.getByLabel('成员角色', { exact: true }).selectOption('viewer');
  await page.getByLabel('变更原因', { exact: true }).fill('敏感管理草稿不可留存');
  const prompts: string[] = []; page.on('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); });
  system.downgrade();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByText('敏感管理草稿不可留存')).toHaveCount(0);
  await hiddenNav(page); expect(prompts).toEqual([]);
  await page.goBack();
  await expect(page.locator('.settings-page')).toHaveCount(0);
});
test('downgrade closes search and keeps restricted notifications usable', async ({ page, context, system }) => {
  await enter(context, page, system, 'admin');
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '搜索任务与风险', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务或风险' }).fill('风险');
  system.downgrade(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('dialog[open]')).toHaveCount(0); await hiddenNav(page);
  await page.getByRole('button', { name: '站内通知', exact: true }).click();
  await expect(page.getByRole('heading', { name: '站内通知', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '后台作业', exact: true })).toHaveCount(0);
});

test('an old overview response cannot restore revoked capabilities or cached private data', async ({ page, context, system }) => {
  await enter(context, page, system, 'admin');
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  await page.route('**/overview', async route => {
    if (!first) return route.fallback(); first = false;
    const response = await system.app.inject({ method: 'GET', url: `${prefix}/overview`, headers: await route.request().allHeaders() });
    const body = response.json(); body.data.project.description = '过期响应中的敏感快照';
    started(); await held;
    await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '刷新首页', exact: true }).click(); await requested;
    system.downgrade(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await hiddenNav(page); release();
    await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '搜索任务', exact: true }).click();
    await expect(page.getByText('过期响应中的敏感快照')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '搜索任务或负责人' })).toBeVisible();
    await hiddenNav(page);
  } finally { release(); }
});

test('revision without capabilities refreshes session before keeping analytics mounted', async ({ page, context, system }) => {
  await page.route('**/revision?*', async route => {
    const url = new URL(route.request().url());
    const response = await system.app.inject({ method: 'GET', url: url.pathname + url.search, headers: await route.request().allHeaders() });
    const body = response.json(); if (body.data) delete body.data.capabilities;
    await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await enter(context, page, system, 'admin', 'analytics');
  await expect(page.getByRole('heading', { name: '统计分析', exact: true })).toBeVisible();
  const previous = system.paths.filter(path => path === '/api/v1/auth/session').length;
  system.downgrade(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/overview$/); await hiddenNav(page);
  expect(system.paths.filter(path => path === '/api/v1/auth/session').length).toBeGreaterThan(previous);
});

test('restricted activity and notification surfaces reject private categories and indirect targets', async ({ page, context, system }) => {
  await page.route('**/activities?*', async route => {
    const items = ['task', 'risk', 'member', 'project'].map(category => ({ id: category, category, type: `${category}.update`, snapshotVersion: 1, itemsCursor: '', actor: { id: 'owner', name: '协作同事' }, occurredAt: now.toISOString(), lastOccurredAt: now.toISOString(), count: 1, preview: [], historical: false, target: { kind: category, id: 'task-001', name: category === 'task' ? '公开任务动态' : '私密动态' }, summary: category === 'task' ? '公开任务动态' : '私密动态' }));
    await route.fulfill({ json: { data: { items, nextCursor: null, activityVersion: 1, backfill: { status: 'complete', processedTasks: 0, error: null } } } });
  });
  await page.route('**/notifications?*', async route => {
    const url = new URL(route.request().url());
    const response = await system.app.inject({ method: 'GET', url: url.pathname + url.search, headers: await route.request().allHeaders() });
    const body = response.json();
    body.data.notifications = [
      ['task.update', 'task', '公开任务提醒'], ['risk.update', 'risk', '私密风险提醒'], ['settings.calendar', 'plan', '私密日历提醒'], ['member.update', 'settings', '私密成员提醒'],
    ].map(([kind, target, title]) => ({ id: kind, recipientId: 'member', kind, target: { kind: target, id: 'task-001' }, title, message: title, createdAt: now.toISOString(), readAt: null }));
    body.data.unread = 4;
    await route.fulfill({ status: 200, json: body });
  });
  await enter(context, page, system, 'member');
  await expect(page.locator('.pa-row')).toHaveCount(1);
  await expect(page.locator('.pa-row')).toContainText('公开任务动态');
  await expect(page.getByText('私密动态', { exact: true })).toHaveCount(0);
  await page.locator('.pa-panel').getByRole('button', { name: '查看全部', exact: true }).click();
  const categories = await page.getByLabel('动态分类').locator('option').allTextContents();
  expect(categories).toEqual(['全部动态', '任务成果', '计划变更', '工作分组']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '站内通知', exact: true }).click();
  await expect(page.getByTestId('notification-row')).toHaveCount(1);
  await expect(page.getByTestId('notification-row')).toContainText('公开任务提醒');
  await expect(page.getByText(/私密.*提醒/)).toHaveCount(0);
});

test('recycle blocks private risk and member links while preserving collaboration links', async ({ page, context, system }) => {
  const login = system.session('member');
  const headers = { cookie: `goodwork_session=${login.token}`, 'x-csrf-token': login.record.csrfToken, 'idempotency-key': crypto.randomUUID() };
  const list = await system.app.inject({ method: 'GET', url: `${prefix}/tasks`, headers });
  const created = await system.app.inject({ method: 'POST', url: `${prefix}/tasks`, headers, payload: {
    expectedPlanVersion: list.json().data.planVersion, title: '成员删除关联测试', description: '', workstreamId: 'system-bottom', parentId: null,
    ownerId: 'member', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: null, end: null,
  } });
  expect(created.statusCode, created.body).toBe(200);
  const task = created.json().data.task;
  await page.route('**/delete-preview', async route => {
    const response = await system.app.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/delete-preview`, headers: await route.request().allHeaders(), payload: route.request().postData() || '{}' });
    const body = response.json();
    body.data.blockers = [
      { kind: 'risk', id: 'restricted', title: '存在需管理人员处理的关联', message: '请联系项目负责人或项目管理员处理关联后再重试。' },
      { kind: 'member', id: 'owner', title: '需要管理人员调整成员', message: '联系项目负责人。' },
      { kind: 'workstream', id: 'system-bottom', title: '协作分组', message: '仍可查看工作分组。' },
    ];
    await route.fulfill({ status: response.statusCode, json: body });
  });
  await enter(context, page, system, 'member', `tasks/${task.id}`);
  await page.getByLabel('任务更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '删除任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除任务', exact: true });
  await expect(dialog).toContainText('存在需管理人员处理的关联');
  await expect(dialog.getByRole('button', { name: '前往处理', exact: true })).toHaveCount(1);
  await expect(dialog.locator('li').filter({ hasText: '协作分组' }).getByRole('button', { name: '前往处理' })).toBeVisible();
});

test('downgrade dismisses an open notification panel and clears its private rows', async ({ page, context, system }) => {
  await page.route('**/notifications?*', async route => {
    const url = new URL(route.request().url());
    const response = await system.app.inject({ method: 'GET', url: url.pathname + url.search, headers: await route.request().allHeaders() });
    const body = response.json();
    body.data.notifications = [{ id: 'sensitive', recipientId: 'admin', kind: 'risk.update', title: '仅管理人员可见提醒', message: '需要清理的风险内容', createdAt: now.toISOString(), readAt: null, target: { kind: 'risk', id: 'risk-001' } }];
    await route.fulfill({ status: response.statusCode, json: body });
  });
  await enter(context, page, system, 'admin');
  await page.getByRole('button', { name: '站内通知', exact: true }).click();
  await expect(page.getByText('仅管理人员可见提醒', { exact: true })).toBeVisible();
  system.downgrade(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('仅管理人员可见提醒', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('notification-row')).toHaveCount(0);
  await hiddenNav(page);
});

test('delayed directory body cannot restore same-user permissions after a revision downgrade', async ({ page, context, system }) => {
  await enter(context, page, system, 'admin');
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
  // Deliver real fixture headers immediately, but hold the Response body inside
  // the browser. route.fulfill alone cannot reproduce the headers/body boundary.
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...args);
      const input = args[0], url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== '/api/v1/projects') return response;
      window.fetch = nativeFetch;
      const bytes = await response.arrayBuffer();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const held = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
      Object.assign(window, { directoryBodyHeld: true, releaseDirectoryBody: () => { streamController.enqueue(new Uint8Array(bytes)); streamController.close(); } });
      return new Response(held, { status: response.status, headers: response.headers });
    };
  });
  await page.getByRole('button', { name: '切换项目', exact: true }).click();
  await page.waitForFunction(() => (window as Window & { directoryBodyHeld?: boolean }).directoryBodyHeld);
  system.downgrade();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await hiddenNav(page);
  await page.evaluate(async () => {
    (window as Window & { releaseDirectoryBody?: () => void }).releaseDirectoryBody?.();
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  await hiddenNav(page);
  await expect(page.getByRole('heading', { name: '项目总览', exact: true })).toBeVisible();
  // Reopening the picker waits for a fresh load; the old body cannot reinstall
  // manager roles/capabilities between the downgrade and this authoritative read.
  await page.getByRole('button', { name: '切换项目', exact: true }).click();
  await expect(page.locator('.project-picker-list button')).toHaveCount(1);
  await hiddenNav(page);
});

test('project B draft and filter survive project A downgrade discovered by session refresh', async ({ page, context, system }) => {
  system.db.prepare("UPDATE auth_users SET can_create_projects=1 WHERE id='admin'").run();
  const login = system.session('admin');
  const response = await system.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: `goodwork_session=${login.token}`, 'x-csrf-token': login.record.csrfToken, 'idempotency-key': crypto.randomUUID() }, payload: { name: '独立协作项目B', goal: '保留B的任务协作', start: '2026-09-01', end: '2026-12-31' } });
  expect(response.statusCode, response.body).toBe(200);
  const projectB = response.json().data.id;
  await enter(context, page, system, 'admin');
  await page.goto(`/projects/${projectB}/tasks`);
  await expect(page.getByRole('heading', { name: '任务管理', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('保留B筛选');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('textbox', { name: '任务名称 *', exact: true }).fill('未保存的B任务草稿');
  const dialog = page.locator('dialog[open]');
  await dialog.evaluate(element => element.setAttribute('data-preserved-editor', 'project-b'));
  await page.route(`**/projects/${projectB}/revision?*`, async route => {
    const url = new URL(route.request().url());
    const result = await system.app.inject({ method: 'GET', url: url.pathname + url.search, headers: await route.request().allHeaders() });
    const body = result.json(); delete body.data.capabilities;
    await route.fulfill({ status: result.statusCode, json: body });
  });
  system.downgrade();
  const refreshed = page.waitForResponse('**/auth/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const session = await (await refreshed).json();
  expect(session.data.projects.find((p: { id: string }) => p.id === 'phase-one').capabilities.analytics).toBe(false);
  await expect(page.getByRole('textbox', { name: '任务名称 *', exact: true })).toHaveValue('未保存的B任务草稿');
  await expect(page.locator('dialog[data-preserved-editor="project-b"]')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true, includeHidden: true })).toHaveValue('保留B筛选');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectB}/tasks$`));
});

for (const mode of ['initial-detail', 'feed-pagination', 'detail-pagination'] as const) test(`invalid legacy activity cursor recovers from initial feed: ${mode}`, async ({ page, context, system }) => {
  const summary = { id: 'legacy-event', category: 'task', type: 'task.complete', snapshotVersion: 1, itemsCursor: 'old-readable-cursor', actor: { id: 'owner', name: '协作同事' }, occurredAt: now.toISOString(), lastOccurredAt: now.toISOString(), count: 1, preview: [], historical: false, target: { kind: 'task', id: 'task-001', name: '可恢复动态' }, summary: '可恢复动态' };
  const backfill = { status: 'complete', processedTasks: 0, error: null };
  let rejected = false, readsAfterRejection = 0;
  const cursors: string[] = [];
  await page.route('**/api/v1/projects/*/activities**', async route => {
    const url = new URL(route.request().url()), cursor = url.searchParams.get('cursor'), detail = url.pathname.endsWith('/items');
    if (cursor) cursors.push(cursor);
    if ((mode === 'initial-detail' && detail) || cursor === 'old-next-cursor') {
      rejected = true;
      await route.fulfill({ status: 422, json: { error: { code: mode === 'detail-pagination' ? 'ACTIVITY_CURSOR_MISMATCH' : 'ACTIVITY_CURSOR_INVALID', message: '旧游标不再有效' } } }); return;
    }
    if (detail) { await route.fulfill({ json: { data: { items: [], nextCursor: 'old-next-cursor', activityVersion: 1, backfill } } }); return; }
    if (rejected && url.searchParams.get('limit') === '20') readsAfterRejection++;
    await route.fulfill({ json: { data: { items: rejected ? [] : [summary], nextCursor: mode === 'feed-pagination' && !rejected ? 'old-next-cursor' : null, activityVersion: 1, backfill } } });
  });
  await enter(context, page, system, 'member');
  await expect(page.locator('.pa-panel .pa-row')).toHaveCount(1);
  if (mode === 'feed-pagination') {
    await page.locator('.pa-panel').getByRole('button', { name: '查看全部', exact: true }).click();
    await page.getByRole('button', { name: '加载更多动态', exact: true }).click();
  } else {
    await page.locator('.pa-panel .pa-row').click();
    if (mode === 'detail-pagination') await page.getByRole('button', { name: '加载更多明细', exact: true }).click();
  }
  await expect(page.getByRole('alert')).toContainText('动态阅读位置已失效');
  const attempts = cursors.length;
  await page.getByRole('button', { name: '重试动态', exact: true }).click();
  await expect(page.locator('.pa-drawer .pa-empty')).toContainText('更新工作分组后');
  await expect(page.locator('.pa-drawer')).not.toContainText('重要风险');
  expect(readsAfterRejection).toBe(1); expect(cursors.length).toBe(attempts);
});
