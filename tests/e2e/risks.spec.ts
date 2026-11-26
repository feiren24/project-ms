import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { RiskDraft, ManagedRisk, RiskWorkspace } from '../../shared/src/risks';
const prefix = '/api/v1/projects/phase-one';
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: ':memory:', clock: () => new Date('2026-09-23T06:00:00Z') }); const w = (await app.inject(`${prefix}/settings`)).json().data; const promoted = await app.inject({ method: 'POST', url: `${prefix}/settings/member_update`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() }, payload: { expectedVersion: w.version, expectedPlanVersion: w.planVersion, reason: '风险专项测试配置实际管理复核人', member: { id: 'lin', name: '林若宁', role: 'project_admin', active: true } } }); expect(promoted.statusCode, promoted.body).toBe(200); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const result = await demo.inject({ method: request.method() as 'GET'|'POST'|'PATCH', url: url.pathname + url.search, headers: request.headers(), payload: request.postData() || undefined });
      await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
    }); await use(page);
  },
});
async function workspace(demo: FastifyInstance): Promise<RiskWorkspace> {
  const response = await demo.inject(`${prefix}/risks`); expect(response.statusCode, response.body).toBe(200); return response.json().data;
}
async function write(demo: FastifyInstance, path: string, payload: unknown, actor = 'zhou', method: 'POST'|'PATCH' = 'POST') {
  const data = await workspace(demo);
  const response = await demo.inject({ method, url: `${prefix}/risks${path}`, headers: { 'x-preview-token': data.writeToken, 'x-demo-actor': actor, 'idempotency-key': crypto.randomUUID() }, payload });
  expect(response.statusCode, response.body).toBe(200); return response.json().data;
}
const draft = (title: string, ownerId = 'zhou'): RiskDraft => ({ title, description: 'DEMO · 独立风险验收场景', workstreamId: 'system-bottom', ownerId, probability: 4, impact: 5, due: '2026-09-30', reviewDate: '2026-09-25', response: '核对影响范围并执行应对任务', taskIds: [], closeReviewerId: ownerId === 'zhou' ? 'lin' : 'zhou' });
async function create(demo: FastifyInstance, title: string, ownerId = 'zhou'): Promise<ManagedRisk> { return (await write(demo, '', draft(title, ownerId))).risk; }
async function transition(demo: FastifyInstance, riskId: string, action: string, actor = 'zhou', extra = {}) {
  const data = await workspace(demo), risk = data.risks.find(r => r.id === riskId)!;
  return write(demo, `/${riskId}/transition`, { expectedVersion: risk.version, action, reason: 'DEMO · 已核对本次处置结果', ...extra }, actor);
}
async function gotoRisks(page: import('@playwright/test').Page) {
  await page.goto('/projects/phase-one/risks'); await expect(page.getByRole('heading', { name: '风险中心', exact: true })).toBeVisible(); await expect(page.getByTestId('risk-row').first()).toBeVisible();
}
async function openRisk(page: import('@playwright/test').Page, id: string) {
  await page.goto(`/projects/phase-one/risks/${id}`); await expect(page.getByRole('dialog')).toBeVisible();
}
async function confirmAction(page: import('@playwright/test').Page, action: string, label: string, reason: string) {
  const drawer = page.getByRole('dialog'); await drawer.getByRole('button', { name: action, exact: true }).click();
  await drawer.getByLabel(label, { exact: true }).fill(reason); await drawer.getByRole('button', { name: '核对操作', exact: true }).click();
  await drawer.getByRole('button', { name: `确认${action}`, exact: true }).click();
}

test('registration preserves draft and creates an assessed score with an atomic response task', async ({ page, demo }) => {
  await gotoRisks(page); await page.getByRole('button', { name: /登记风险/ }).click(); const drawer = page.getByRole('dialog');
  await drawer.getByLabel('风险标题', { exact: true }).fill('UI登记风险与应对任务');
  await drawer.getByRole('button', { name: '关闭风险详情', exact: true }).click(); await expect(drawer).toContainText('保留未保存内容');
  await drawer.getByRole('button', { name: '继续填写', exact: true }).click(); await expect(drawer.getByLabel('风险标题', { exact: true })).toHaveValue('UI登记风险与应对任务');
  await drawer.getByLabel('发生概率').selectOption('4'); await drawer.getByLabel('影响程度').selectOption('5');
  await drawer.getByLabel('关闭复核人').selectOption('lin');
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '创建应对任务', exact: true })).toBeVisible();
  const risk = (await workspace(demo)).risks.find(r => r.title === 'UI登记风险与应对任务')!; expect(risk.score).toBe(20);
  await drawer.getByRole('button', { name: '创建应对任务', exact: true }).click();
  await drawer.getByLabel('应对任务名称', { exact: true }).fill('UI风险应对执行任务');
  await drawer.getByLabel('开始日期', { exact: true }).fill('2026-09-23'); await drawer.getByLabel('截止日期', { exact: true }).fill('2026-09-24');
  await drawer.getByLabel('估算工时', { exact: true }).fill('16'); await drawer.getByRole('button', { name: '核对操作', exact: true }).click();
  await drawer.getByRole('button', { name: '确认创建并关联', exact: true }).click();
  await expect(drawer.getByRole('button', { name: /UI风险应对执行任务/ })).toBeVisible();
  const after = await workspace(demo), task = after.tasks.find(t => t.title === 'UI风险应对执行任务')!;
  const analytics=(await demo.inject(`${prefix}/analytics`)).json().data;expect(analytics.counts.total).toBe(49);expect(analytics.warnings.some((w:string)=>w.includes('最新采集缺失'))).toBe(false);
  expect(after.tasks).toHaveLength(49); expect(after.risks.find(r => r.id === risk.id)?.actionTaskIds).toEqual([task.id]);
  await drawer.getByRole('button', { name: /UI风险应对执行任务/ }).click(); await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?`));
  await page.getByRole('button',{name:'开始任务',exact:true}).click();await expect(page.getByRole('textbox',{name:/操作说明/})).toHaveCount(0);await page.getByRole('button',{name:'确认开始',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?`));
  await page.getByRole('button',{name:'标记完成',exact:true}).click();await expect(page.getByRole('textbox',{name:/操作说明/})).toHaveCount(0);await page.getByRole('button',{name:'确认完成',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('已完成');
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText(risk.title);
});

test('risk owner submits closure and another reviewer approves; viewer has no mutation controls', async ({ page, demo }) => {
  const risk = await create(demo, '独立关闭复核风险'); await transition(demo, risk.id, 'assess'); await transition(demo, risk.id, 'mitigate'); await transition(demo, risk.id, 'monitor');
  await openRisk(page, risk.id); await confirmAction(page, '提交关闭复核', '关闭理由', '应对完成，申请独立复核');
  await expect(page.getByRole('dialog')).toContainText('关闭申请待复核');
  await expect(page.getByRole('dialog').getByRole('button', { name: '通过关闭', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '关闭风险详情', exact: true }).click(); await page.getByLabel('风险体验身份', { exact: true }).selectOption('lin');
  await page.getByTestId('risk-row').filter({ hasText: risk.title }).getByRole('button').first().click();
  await confirmAction(page, '通过关闭', '复核意见', '独立检查完成，同意关闭');
  await expect(page.getByRole('dialog')).toContainText('已关闭'); expect((await workspace(demo)).risks.find(r => r.id === risk.id)?.status).toBe('closed');
  await page.getByRole('button', { name: '关闭风险详情', exact: true }).click(); await page.getByLabel('风险体验身份', { exact: true }).selectOption('xu');
  await expect(page.getByRole('button', { name: /登记风险/ })).toBeDisabled();
  await page.getByTestId('risk-row').first().getByRole('button').first().click(); await expect(page.getByRole('dialog')).toContainText('无风险管理权限');
  await expect(page.getByRole('button', { name: '编辑风险', exact: true })).toHaveCount(0);
});

test('risk entry preserves legacy risks and exposes honest unknown rule inputs', async ({ page, demo }) => {
  await page.goto('/'); await page.getByRole('button', { name: '风险中心', exact: true }).click(); await expect(page).toHaveURL(/\/risks$/);
  const data = await workspace(demo); expect(data.risks).toHaveLength(4); expect(data.risks.every(r => r.probability === null && r.impact === null)).toBe(true);
  await expect(page.getByTestId('risk-row')).toHaveCount(4);
  await page.getByRole('button', { name: '自动预警', exact: true }).click(); await expect(page.locator('.risk-page')).toContainText('容量');
  expect(data.rules.find(r => r.key === 'capacity_overload')?.status).toBe('unknown');
  await page.getByRole('button', { name: '风险矩阵', exact: true }).click(); await expect(page.getByTestId('risk-matrix-cell')).toHaveCount(25); await expect(page.locator('.risk-page')).toContainText('待人工评分');
});

test('critical risk is reflected in homepage and matrix drills into the matching risk', async ({ page, demo }) => {
  const risk = await create(demo, '严重风险矩阵验收'); await gotoRisks(page);
  await page.getByRole('button', { name: '风险矩阵', exact: true }).click();
  await page.getByRole('button', {name:'概率 4，影响 5，严重风险，1 项',exact:true}).click();
  await expect(page.locator('.risk-matrix-risk').filter({hasText:risk.title})).toBeVisible();
  const overview = (await demo.inject(`${prefix}/overview`)).json().data; expect(overview.summary.highRisks).toBe(4);
  await page.goto('/'); await page.getByRole('button', { name: /高风险事项/ }).click(); await expect(page).toHaveURL(/risks\?level=urgent$/); await expect(page.getByTestId('risk-row').filter({ hasText: risk.title })).toBeVisible();
});

test('alert evidence can be snoozed and converted without invented scoring', async ({ page, demo }) => {
  const alert = (await workspace(demo)).alerts.find(a => a.rule === 'overdue')!;
  await gotoRisks(page); await page.getByRole('button', { name: '自动预警', exact: true }).click();
  await page.getByTestId('alert-row').filter({ hasText: alert.title }).getByRole('button').click();
  let drawer = page.getByRole('dialog'); await expect(drawer).toContainText(alert.evidence);
  await drawer.getByRole('button', { name: '暂缓预警', exact: true }).click(); await drawer.getByLabel('暂缓原因', { exact: true }).fill('等待负责人核对排期');
  await drawer.getByLabel('暂缓至', { exact: true }).fill('2026-09-30'); await drawer.getByRole('button', { name: '核对暂缓', exact: true }).click(); await drawer.getByRole('button', { name: '确认暂缓预警', exact: true }).click();
  await expect(page.getByTestId('alert-row').filter({ hasText: alert.title })).toContainText('已暂缓');
  await page.getByTestId('alert-row').filter({ hasText: alert.title }).getByRole('button').click(); await page.getByRole('button', { name: '转为风险', exact: true }).click();
  drawer = page.getByRole('dialog'); await drawer.getByLabel(/^责任人/).selectOption('zhou');
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '查看来源预警与证据', exact: true })).toBeVisible();
  const after = await workspace(demo), converted = after.risks.find(r => r.sourceAlertId === alert.id)!;
  expect(converted.probability).toBeNull(); expect(converted.impact).toBeNull(); expect(after.alerts.find(a => a.id === alert.id)?.linkedRiskId).toBe(converted.id);
});

test('lost save response retries idempotently and stale refresh credentials recover with a read', async ({ page, demo }) => {
  await gotoRisks(page); let dropped = false;
  await page.route('**/api/v1/projects/phase-one/risks', async route => {
    if (route.request().method() !== 'POST' || dropped) { await route.fallback(); return; }
    dropped = true; const req = route.request(); const committed = await demo.inject({ method: 'POST', url: `${prefix}/risks`, headers: req.headers(), payload: req.postData()! }); expect(committed.statusCode, committed.body).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '保存响应中断，请重试' } }) });
  });
  await page.getByRole('button', { name: /登记风险/ }).click(); const drawer = page.getByRole('dialog');
  await drawer.getByLabel('风险标题', { exact: true }).fill('风险保存幂等验证'); await drawer.getByLabel(/^责任人/).selectOption('zhou');
  await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('响应中断'); await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '编辑风险', exact: true })).toBeVisible(); expect((await workspace(demo)).risks.filter(r => r.title === '风险保存幂等验证')).toHaveLength(1);
  await drawer.getByRole('button', { name: '关闭风险详情', exact: true }).click();
  let denied = false, reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/risks')) reads++; });
  await page.route('**/api/v1/projects/phase-one/risks/evaluate', async route => { if (!denied) { denied = true; await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PREVIEW_TOKEN_REQUIRED', message: '本机服务已重启，请重新读取' } }) }); } else await route.fallback(); });
  await page.getByRole('button', { name: '刷新风险', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(0); await page.getByRole('button', { name: '刷新风险', exact: true }).click(); await expect(page.getByTestId('risk-row')).toHaveCount(5);
});

test('resolved alert from a cancelled task converts without a hidden invalid task selection', async ({ page, demo }) => {
  const risk = await create(demo, '历史预警转换测试'); const before = await workspace(demo);
  const result = await write(demo, `/${risk.id}/actions/create`, { expectedVersion: risk.version, expectedPlanVersion: before.planVersion, draft: { title: '已取消的历史应对任务', description: '', workstreamId: 'system-bottom', parentId: null, ownerId: 'zhou', priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: '2026-09-14', end: '2026-09-15' } });
  const task = result.task, w = await workspace(demo);
  const cancelled = await demo.inject({ method: 'POST', url: `${prefix}/tasks/${task.id}/transition`, headers: { 'x-preview-token': w.writeToken, 'x-demo-actor': 'zhou', 'idempotency-key': crypto.randomUUID() }, payload: { expectedVersion: task.version, expectedPlanVersion: w.planVersion, action: 'cancel', reason: '范围调整取消，保留历史' } }); expect(cancelled.statusCode, cancelled.body).toBe(200);
  const alert = (await workspace(demo)).alerts.find(a => a.rule === 'overdue' && a.objectId === task.id)!; expect(alert.status).toBe('resolved');
  await gotoRisks(page); await page.getByRole('button', { name: '自动预警', exact: true }).click(); await page.getByLabel('预警状态筛选', { exact: true }).selectOption('all');
  await page.getByTestId('alert-row').filter({ hasText: alert.title }).getByRole('button').click(); await page.getByRole('button', { name: '转为风险', exact: true }).click();
  const drawer = page.getByRole('dialog'); await drawer.getByLabel(/^责任人/).selectOption('zhou');
  await expect(drawer.getByLabel('影响任务', { exact: true })).toHaveValues([]); await drawer.getByRole('button', { name: '核对操作', exact: true }).click(); await drawer.getByRole('button', { name: '确认保存风险', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '编辑风险', exact: true })).toBeVisible(); expect((await workspace(demo)).risks.find(r => r.sourceAlertId === alert.id)?.taskIds).toEqual([]);
});

for (const width of [1440, 390, 320]) test(`risk ${width}px views and drawer fit without page overflow`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await gotoRisks(page);
  for (const label of ['风险台账', '自动预警', '风险矩阵']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/risks-${width}-${label}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: /登记风险/ }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/risks-${width}-登记.png`, animations: 'disabled' });
});

test('ordinary risk transitions directly confirm and closure still needs a reason',async({page,demo})=>{
 const risk=await create(demo,'风险分级交互');await openRisk(page,risk.id);const drawer=page.getByRole('dialog');
 await drawer.getByRole('button',{name:'完成评估',exact:true}).click();
 await expect(drawer.getByRole('button',{name:'核对操作',exact:true})).toHaveCount(0);
 await expect(drawer.getByLabel('操作原因',{exact:true})).toHaveCount(0);
 await drawer.getByRole('button',{name:'取消',exact:true}).click();
 expect((await workspace(demo)).risks.find(r=>r.id===risk.id)?.status).toBe('identified');
 for(const action of ['完成评估','开始应对','转入监控']) {
  await drawer.getByRole('button',{name:action,exact:true}).click();
  await drawer.getByRole('button',{name:`确认${action}`,exact:true}).click();
  await expect(drawer.getByRole('button',{name:`确认${action}`,exact:true})).toHaveCount(0);
 }
 await drawer.getByRole('button',{name:'提交关闭复核',exact:true}).click();
 await expect(drawer.getByLabel('关闭理由',{exact:true})).toHaveAttribute('required','');
 await drawer.getByRole('button',{name:'核对操作',exact:true}).click();
 await expect(drawer.getByRole('button',{name:'确认提交关闭复核',exact:true})).toHaveCount(0);
 expect((await workspace(demo)).risks.find(r=>r.id===risk.id)?.status).toBe('monitoring');
});

test('response links need no reason and cancelling removal closes the confirmation directly',async({page,demo})=>{
 const risk=await create(demo,'免填原因关联风险');const task=(await workspace(demo)).tasks.find(t=>t.status!=='cancelled'&&!t.isContainer&&t.taskKind!=='summary')!;
 await openRisk(page,risk.id);const drawer=page.getByRole('dialog');
 await drawer.getByRole('button',{name:'关联已有任务',exact:true}).click();
 await drawer.getByRole('combobox',{name:'关联应对任务',exact:true}).selectOption(task.id);
 await expect(drawer.getByLabel('操作原因',{exact:true})).toHaveCount(0);
 await drawer.getByRole('button',{name:'核对操作',exact:true}).click();await drawer.getByRole('button',{name:'确认关联任务',exact:true}).click();
 await drawer.getByRole('button',{name:'移除关联',exact:true}).click();
 await expect(drawer.getByRole('button',{name:'核对操作',exact:true})).toHaveCount(0);
 await drawer.getByRole('button',{name:'取消',exact:true}).click();
 await expect(drawer.getByRole('button',{name:'确认移除关联',exact:true})).toHaveCount(0);
 expect((await workspace(demo)).risks.find(r=>r.id===risk.id)?.actionTaskIds).toEqual([task.id]);
 await drawer.getByRole('button',{name:'移除关联',exact:true}).click();await drawer.getByRole('button',{name:'确认移除关联',exact:true}).click();
 await expect(drawer.getByRole('button',{name:'确认移除关联',exact:true})).toHaveCount(0);
 const saved=(await workspace(demo)).risks.find(r=>r.id===risk.id)!;expect(saved.actionTaskIds).toEqual([]);expect(saved.events.at(-1)?.text).toContain('移除应对任务关联');
});
