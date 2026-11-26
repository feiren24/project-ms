import { test as base, expect } from '@playwright/test';
import { milestoneWorkdayDifference, milestoneForecastIsLate } from '../../client/src/features/milestones/metrics';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import type { FastifyInstance } from 'fastify';
const test = base.extend<{ demo: FastifyInstance }>({
 demo: async ({}, use) => { const app = buildLegacyApp({ allowedOrigins: [process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174'], dbPath: ':memory:' }); await use(app); await app.close(); },
 page: async ({ page, demo }, use) => { await page.route('**/api/v1/**', async route => { const r = route.request(); const u = new URL(r.url()); const response = await demo.inject({ method: r.method() as 'GET'|'POST'|'PATCH', url: u.pathname + u.search, headers: r.headers(), payload: r.postData() || undefined }); await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body }); }); try { await use(page); } finally { await page.unrouteAll({ behavior: 'wait' }); } },
});
test('milestones embed in plan and protect creation drafts', async ({ page }) => {
 await page.goto('/projects/phase-one/plan'); await page.getByRole('tab', { name: '里程碑', exact: true }).click();
 await expect(page.getByRole('heading', { name: '里程碑交付', exact: true })).toBeVisible();
 await page.getByRole('button', { name: '新建里程碑', exact: true }).click();
 await page.getByLabel('里程碑名称', { exact: true }).fill('端到端交付节点');
 page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '关闭里程碑详情' }).click();
 await expect(page.getByLabel('里程碑名称', { exact: true })).toHaveValue('端到端交付节点');
 await page.getByLabel('交付目标', { exact: true }).fill('验收完整业务流程');
 await page.getByLabel('里程碑负责人', {exact:true}).selectOption('chen'); await page.getByLabel('里程碑验收人').selectOption('lin');
 await page.getByLabel('必要条件 1').fill('验收报告'); await page.getByLabel('计划日期', {exact:true}).fill('2026-09-25');
 await page.getByRole('button', { name: '创建里程碑', exact: true }).click();
 await expect(page.getByRole('dialog', { name: '里程碑详情' })).toContainText('端到端交付节点');
 await page.getByRole('button', { name: '关闭里程碑详情' }).click();
 await page.getByLabel('里程碑体验身份').selectOption('chen'); await page.getByRole('button', { name: '查看里程碑 端到端交付节点', exact: true }).click();
 await page.getByLabel('整体成果说明').fill('流程回归通过'); await page.getByLabel('整体证据链接').fill('https://example.com/delivery');
 await page.getByLabel('条件说明 1').fill('验收报告通过'); await page.getByLabel('条件证据链接 1').fill('https://example.com/evidence'); await page.getByLabel('声明条件 1 已就绪').check();
 await page.getByRole('button', { name: '保存交付草稿', exact: true }).click(); await page.getByRole('button', { name: '提交验收', exact: true }).click(); await page.getByRole('button', { name: '确认提交验收', exact: true }).click();
 await expect(page.getByRole('dialog', { name: '里程碑详情' })).toContainText('待验收');
 await page.getByRole('button', { name: '关闭里程碑详情' }).click(); await page.getByLabel('里程碑体验身份').selectOption('lin'); await page.getByRole('button', { name: '查看里程碑 端到端交付节点', exact: true }).click();
 await page.getByLabel('核查通过 验收报告', { exact: true }).check(); await page.getByRole('button', { name: '验收通过', exact: true }).click(); await page.getByRole('button', { name: '确认验收通过', exact: true }).click(); await expect(page.getByRole('dialog', { name: '里程碑详情' })).toContainText('已验收');
});
for (const width of [1440, 390, 320]) test(`milestones ${width}px fit`, async ({ page }) => {
 await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await page.goto('/projects/phase-one/plan?view=milestones');
 await expect(page.getByRole('heading', { name: '里程碑交付', exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 if (width === 1440) { const shell = await page.locator('.workspace').evaluate(el => ({x:document.querySelector('#plan-page-title')!.getBoundingClientRect().x,margin:getComputedStyle(el).marginLeft,sidebar:document.querySelector('.sidebar')!.getBoundingClientRect().right})); expect(shell.x,JSON.stringify(shell)).toBeGreaterThanOrEqual(shell.sidebar); }
 await page.screenshot({ path: `test-results/milestones-${width}.png`, fullPage: true, animations:'disabled' }); await page.getByRole('button', { name: '新建里程碑', exact: true }).click(); expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); await page.screenshot({path:`test-results/milestones-form-${width}.png`,animations:'disabled'});
});

const prefix = '/api/v1/projects/phase-one/milestones';
async function milestoneData(demo: FastifyInstance) { return (await demo.inject(prefix)).json().data; }
async function writeMilestone(demo: FastifyInstance, path: string, payload: Record<string,unknown>, actor = 'zhou', method: 'POST'|'PATCH' = 'POST') {
 const w = await milestoneData(demo); const response = await demo.inject({ method, url:prefix+path, headers:{'x-preview-token':w.writeToken,'x-demo-actor':actor,'idempotency-key':crypto.randomUUID()}, payload:{...payload,expectedPlanVersion:w.planVersion} });
 expect(response.statusCode,response.body).toBe(200); return response.json().data.milestone;
}
async function seedMilestone(demo:FastifyInstance,title:string) { return writeMilestone(demo,'',{title,description:'并发场景成果',workstreamId:'system-bottom',ownerId:'chen',reviewerId:'lin',date:'2026-09-25',criteria:[{id:'evidence-one',title:'原验收条件',kind:'evidence',taskId:null}]}); }
async function completeDraft(demo:FastifyInstance,m:any,summary:string) { return writeMilestone(demo,`/${m.id}/draft`,{expectedVersion:m.version,summary,links:['https://example.com/result'],evidence:m.criteria.filter((c:any)=>c.kind==='evidence').map((c:any)=>({criterionId:c.id,description:summary,links:['https://example.com/report'],declared:true}))},'chen'); }
test('changed evidence conditions reconcile a dirty delivery draft without stale IDs',async({page,demo})=>{
 let m=await seedMilestone(demo,'条件版本更新'); await page.goto('/projects/phase-one/plan?view=milestones'); await page.getByLabel('里程碑体验身份').selectOption('chen'); await page.getByRole('button',{name:`查看里程碑 ${m.title}`,exact:true}).click();
 await page.getByLabel('整体成果说明').fill('保留我的整体成果'); await page.getByLabel('条件说明 1').fill('旧条件的本地未保存说明');
 m=await writeMilestone(demo,`/${m.id}`,{title:m.title,description:m.description,workstreamId:m.workstreamId,ownerId:m.ownerId,reviewerId:m.reviewerId,date:m.date,expectedVersion:m.version,criteria:[{id:'evidence-two',title:'新增条件',kind:'evidence',taskId:null}]},'zhou','PATCH');
 await page.getByRole('button',{name:'保存交付草稿',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible(); await page.getByRole('button',{name:'重新读取里程碑（保留填写内容）'}).click();
 await expect(page.getByLabel('整体成果说明')).toHaveValue('保留我的整体成果'); await expect(page.getByLabel('条件说明 1')).toHaveValue(''); await expect(page.getByRole('dialog')).toContainText('新增条件');
 await page.getByText('本地交付恢复副本（未提交）',{exact:true}).click(); await expect(page.locator('.ms-recovery')).toContainText('旧条件的本地未保存说明');
 await page.getByLabel('条件说明 1').fill('新条件已核查'); await page.getByRole('button',{name:'保存交付草稿',exact:true}).click(); await expect(page.getByRole('alert')).toHaveCount(0);
 const latest=(await milestoneData(demo)).milestones.find((x:any)=>x.id===m.id); expect(latest.delivery.summary).toBe('保留我的整体成果'); expect(latest.delivery.evidence.map((e:any)=>e.criterionId)).toEqual(['evidence-two']);
});
test('review refresh replaces resubmitted evidence and requires fresh criterion checks',async({page,demo})=>{
 let m=await seedMilestone(demo,'验收快照并发'); m=await completeDraft(demo,m,'第一版交付'); m=await writeMilestone(demo,`/${m.id}/transition`,{action:'submit',expectedVersion:m.version},'chen');
 await page.goto('/projects/phase-one/plan?view=milestones'); await page.getByLabel('里程碑体验身份').selectOption('lin'); await page.getByRole('button',{name:`查看里程碑 ${m.title}`,exact:true}).click(); await page.getByLabel('核查通过 原验收条件',{exact:true}).check();
 m=await writeMilestone(demo,`/${m.id}/transition`,{action:'withdraw',expectedVersion:m.version},'chen'); m=await completeDraft(demo,m,'第二版全新交付'); m=await writeMilestone(demo,`/${m.id}/transition`,{action:'submit',expectedVersion:m.version},'chen');
 await page.getByRole('button',{name:'验收通过',exact:true}).click(); await page.getByRole('button',{name:'确认验收通过',exact:true}).click(); await page.getByRole('button',{name:'重新读取里程碑（保留填写内容）'}).click();
 await expect(page.getByRole('dialog')).toContainText('第二版全新交付'); await expect(page.getByLabel('核查通过 原验收条件',{exact:true})).not.toBeChecked(); await expect(page.getByRole('button',{name:'确认验收通过',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'验收通过',exact:true}).click(); await page.getByRole('button',{name:'确认验收通过',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('逐项核查');
 await page.getByLabel('核查通过 原验收条件',{exact:true}).check(); await page.getByRole('button',{name:'确认验收通过',exact:true}).click(); await expect(page.getByRole('dialog')).toContainText('已验收');
});
test('new milestone dependency preview returns to its created detail',async({page,demo})=>{
 const tasks=(await demo.inject('/api/v1/projects/phase-one/tasks')).json().data.tasks; const task=tasks.find((t:any)=>t.status!=='cancelled'&&t.taskKind!=='summary'&&!t.isContainer&&!tasks.some((c:any)=>c.parentId===t.id));
 await page.goto('/projects/phase-one/plan?view=milestones'); await page.getByRole('button',{name:'新建里程碑',exact:true}).click(); await page.getByLabel('里程碑名称',{exact:true}).fill('带前置预览节点'); await page.getByLabel('交付目标',{exact:true}).fill('明确依赖影响'); await page.getByLabel('计划日期',{exact:true}).fill('2026-09-25'); await page.getByLabel('必要条件 1').fill('前置完成'); await page.getByLabel('条件类型 1').selectOption('task'); await page.getByLabel('关联任务 1').selectOption(task.id); await page.getByLabel('创建后同时预览设为前置依赖').check();
 await page.getByRole('button',{name:'创建里程碑',exact:true}).click(); await expect(page.getByRole('dialog',{name:'计划详情'})).toBeVisible(); await expect(page).not.toHaveURL(/milestone=new/); await expect(page.getByLabel('前置任务 1')).toHaveValue(task.id); await page.getByRole('button',{name:'关闭计划详情'}).click(); await expect(page.getByRole('dialog',{name:'里程碑详情'})).toContainText('带前置预览节点'); await expect(page.getByRole('button',{name:'创建里程碑',exact:true})).toHaveCount(0);
 const w=await milestoneData(demo);const created=w.milestones.filter((m:any)=>m.title==='带前置预览节点'); expect(created).toHaveLength(1); expect(w.dependencies.some((d:any)=>d.successorId===created[0].id)).toBe(false);
});

test('phone filter sheet applies together, clears, and restores trigger focus',async({page})=>{
 await page.setViewportSize({width:390,height:844}); await page.goto('/projects/phase-one/plan?view=milestones');
 await expect(page.getByRole('button',{name:'导出计划',exact:true})).toHaveCount(0); await expect(page.getByRole('button',{name:'基线管理',exact:true})).toBeVisible();
 await expect(page.locator('.ms-desktop-filters')).toBeHidden(); const trigger=page.locator('.ms-mobile-filter-row').getByRole('button',{name:/筛选/}); await trigger.click();
 const sheet=page.getByRole('dialog',{name:'里程碑筛选',exact:true}); await expect(sheet).toBeVisible(); await page.getByLabel('筛选里程碑验收状态',{exact:true}).selectOption('legacy_achieved'); await page.getByLabel('筛选里程碑计划日期',{exact:true}).selectOption('overdue');
 await page.screenshot({path:'test-results/milestones-filter-390.png',animations:'disabled'}); await page.getByRole('button',{name:'应用筛选',exact:true}).click(); await expect(sheet).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(page.locator('.ms-row')).toHaveCount(2);
 await trigger.click(); await expect(page.getByLabel('筛选里程碑验收状态',{exact:true})).toHaveValue('legacy_achieved'); await page.getByLabel('筛选里程碑验收状态',{exact:true}).selectOption('draft'); await page.getByRole('button',{name:'关闭里程碑筛选',exact:true}).click(); await expect(page.locator('.ms-row')).toHaveCount(2); await expect(trigger).toBeFocused();
 await trigger.click(); await page.getByRole('button',{name:'清空筛选',exact:true}).click(); await page.getByRole('button',{name:'应用筛选',exact:true}).click(); await expect(page.locator('.ms-row')).toHaveCount(6); await expect(trigger.locator('.ms-filter-count')).toHaveCount(0); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('milestone baseline forecasts and calendar deviation retain the commitment reference',()=>{
 const calendar={weekdays:[1,2,3,4,5],hoursPerDay:8,confirmed:true,exceptions:{}};
 expect(milestoneWorkdayDifference('2026-09-21','2026-09-20',calendar)).toBe(-1);
 expect(milestoneWorkdayDifference('2026-09-20','2026-09-21',calendar)).toBe(1);
 expect(milestoneForecastIsLate('2026-09-25','2026-09-23','2026-09-28')).toBe(true);
 expect(milestoneForecastIsLate('2026-09-25',null,'2026-09-28')).toBe(false);
});

test('plan remembers milestone mode and locates a node with return context',async({page,demo})=>{
 const m=await seedMilestone(demo,'甘特定位交付节点'); await page.goto('/projects/phase-one/plan?view=milestones');
 await page.getByRole('button',{name:'项目总览',exact:true}).click(); await page.getByRole('button',{name:'完整计划',exact:true}).click(); await expect(page.getByRole('tab',{name:'里程碑',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByLabel('搜索里程碑',{exact:true}).fill('甘特定位'); await page.getByRole('button',{name:`查看里程碑 ${m.title}`,exact:true}).click(); await page.getByRole('tab',{name:'计划与影响',exact:true}).click(); await page.getByRole('button',{name:'定位到甘特图',exact:true}).click(); await expect(page).toHaveURL(/view=gantt/); await expect(page.getByRole('tab',{name:'甘特图',exact:true})).toHaveAttribute('aria-selected','true'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByLabel('搜索计划任务')).toHaveValue(m.title);
 await page.getByRole('button',{name:'返回里程碑详情',exact:false}).click(); await expect(page.getByRole('dialog',{name:'里程碑详情'})).toContainText(m.title); await page.getByRole('button',{name:'关闭里程碑详情'}).click(); await expect(page.getByLabel('搜索里程碑',{exact:true})).toHaveValue('甘特定位');
});
