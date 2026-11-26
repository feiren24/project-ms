import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { AnalyticsReport } from '../../shared/src/analytics';
import type { ManagedTask, TaskWorkspace } from '../../shared/src/tasks';
const prefix='/api/v1/projects/phase-one';
const test=base.extend<{demo:FastifyInstance}>({
 demo:async({},use)=>{const app=buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'],dbPath:':memory:',clock:()=>new Date('2026-09-23T06:00:00.000Z')});await use(app);await app.close();},
 page:async({page,demo},use)=>{await page.route('**/api/v1/**',async route=>{const r=route.request();const u=new URL(r.url());const response=await demo.inject({method:r.method() as 'GET'|'POST'|'PATCH',url:u.pathname+u.search,headers:r.headers(),payload:r.postData()||undefined});await route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});});await use(page);}
});
async function report(demo:FastifyInstance,query:Record<string,string>={}):Promise<AnalyticsReport>{const r=await demo.inject(`${prefix}/analytics?${new URLSearchParams(query)}`);expect(r.statusCode,r.body).toBe(200);return r.json().data;}
async function workspace(demo:FastifyInstance):Promise<TaskWorkspace>{return(await demo.inject(`${prefix}/tasks`)).json().data;}
async function create(demo:FastifyInstance,title:string):Promise<ManagedTask>{const w=await workspace(demo);const r=await demo.inject({method:'POST',url:`${prefix}/tasks`,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{title,description:'统计隔离验证',workstreamId:'system-bottom',parentId:null,ownerId:'chen',priority:'P1',effortHours:16,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:'2026-09-23',end:'2026-09-24',expectedPlanVersion:w.planVersion}});expect(r.statusCode,r.body).toBe(200);return r.json().data.task;}
async function transition(demo:FastifyInstance,id:string,action:string){const w=await workspace(demo);const t=w.tasks.find(t=>t.id===id)!;const r=await demo.inject({method:'POST',url:`${prefix}/tasks/${id}/transition`,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{expectedVersion:t.version,expectedPlanVersion:w.planVersion,action,reason:'统计验收'}});expect(r.statusCode,r.body).toBe(200);}
async function gotoAnalytics(page:import('@playwright/test').Page){await page.goto('/projects/phase-one/analytics');await expect(page.getByRole('heading',{name:'统计分析',exact:true})).toBeVisible();await expect(page.getByTestId('analytics-metric-completion')).toBeVisible();}

test('navigation shows honest metrics, missing dates and real captured trend only',async({page,demo})=>{
 await page.goto('/');await page.getByRole('button',{name:'统计分析',exact:true}).click();await expect(page).toHaveURL(/analytics$/);
 await expect(page.getByTestId('analytics-metric-completion')).toContainText('37.5%');
 const r=await report(demo);expect(r.metrics.completion).toMatchObject({value:.375,numerator:18,denominator:48});expect(r.metrics.onTime.value).toBeNull();expect(r.metrics.onTime.missing).toBe(18);
 expect(r.trend.points.filter(p=>p.actual!==null)).toHaveLength(1);expect(r.trend.points.find(p=>p.actual!==null)?.date).toBe('2026-09-23');
 await expect(page.getByTestId('analytics-metric-onTime')).toContainText('18');await expect(page.locator('.analytics-page')).toContainText('DEMO');
 await page.getByTestId('analytics-metric-completion').click();await expect(page.getByRole('heading',{name:'任务明细',exact:true})).toBeVisible();
});

test('workflow and owner filters share API scope and survive task drilldown return',async({page,demo})=>{
 await gotoAnalytics(page);await page.getByLabel('统计工作分组筛选',{exact:true}).selectOption('system-bottom');await page.getByLabel('统计负责人筛选',{exact:true}).selectOption('chen');
 const r=await report(demo,{workstreamId:'system-bottom',ownerId:'chen'});await page.getByTestId('analytics-metric-completion').click();const rows=page.getByTestId('analytics-task-row').filter({visible:true});await expect(rows).toHaveCount(r.tasks.length);
 const task=r.tasks[0]!;await rows.filter({hasText:task.title}).getByRole('link',{name:'打开任务详情'}).click();await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?from=analytics$`));await expect(page.getByRole('dialog')).toContainText(task.title);
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.getByLabel('统计工作分组筛选',{exact:true})).toHaveValue('system-bottom');await expect(page.getByLabel('统计负责人筛选',{exact:true})).toHaveValue('chen');
});

test('new completion uses frozen date and statistics refresh after task execution',async({page,demo})=>{
 const task=await create(demo,'按期完成统计任务');await gotoAnalytics(page);await transition(demo,task.id,'start');await transition(demo,task.id,'complete');await page.getByRole('button',{name:'刷新统计',exact:true}).click();
 await expect(page.getByTestId('analytics-metric-onTime')).toContainText('100%');const r=await report(demo);expect(r.metrics.onTime).toMatchObject({numerator:1,denominator:1,missing:18});expect(r.tasks.find(t=>t.id===task.id)?.completionPlanEnd).toBe('2026-09-24');
});

test('plan deviations distinguish new and cancelled tasks; CSV escapes formula titles',async({page,demo})=>{
 const created=await create(demo,'=统计导出安全验证');const cancelled=await create(demo,'取消统计对比任务');await transition(demo,cancelled.id,'cancel');await gotoAnalytics(page);await page.getByRole('button',{name:'计划偏差',exact:true}).click();
 const r=await report(demo);expect(r.deviations.find(d=>d.taskId===created.id)?.state).toBe('new');expect(r.deviations.find(d=>d.taskId===cancelled.id)?.state).toBe('cancelled');
 await expect(page.getByTestId('analytics-deviation-row').filter({visible:true,hasText:created.title})).toBeVisible();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出当前分析',exact:true}).click();const download=await downloadPromise;const csv=await readFile((await download.path())!,'utf8');expect(csv).toContain("'=统计导出安全验证");expect(csv).toContain('取消统计对比任务');
 await page.getByTestId('analytics-deviation-row').filter({hasText:cancelled.title}).getByRole('button',{name:'查看任务明细'}).click();await page.getByTestId('analytics-task-row').getByRole('link',{name:'打开任务详情'}).click();await expect(page.getByRole('dialog')).toContainText(cancelled.title);await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.locator('.analytics-tabs button[aria-pressed=true]')).toHaveText('计划偏差');
});

test('resource load requires a chosen calendar scenario and cell opens allocation details',async({page,demo})=>{
 await gotoAnalytics(page);await page.getByRole('button',{name:'资源负荷',exact:true}).click();const original=await report(demo);expect(original.capacity.members.every(m=>m.cells.every(c=>c.availableHours===null&&c.ratio===null))).toBe(true);
 await page.getByLabel('容量计算方式',{exact:true}).selectOption('calendar');await expect(page.locator('.analytics-page')).toContainText('试算');
 const cells=page.getByTestId('analytics-capacity-cell').filter({visible:true});await expect(cells.first()).toBeVisible();await cells.first().click();await expect(page.locator('.analytics-page')).toContainText('工时');
});

test('empty scope and failed request can recover without displaying a previous filter as current',async({page})=>{
 await gotoAnalytics(page);await page.getByLabel('统计开始日期',{exact:true}).fill('2026-12-01');await page.getByLabel('统计结束日期',{exact:true}).fill('2026-12-31');await expect(page.locator('.analytics-page')).toContainText('当前筛选没有执行任务');
 let failed=false;await page.route('**/api/v1/projects/phase-one/analytics**',async route=>{if(!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'统计读取暂时失败，请重试。'}})});}else await route.fallback();});await page.getByRole('button',{name:'刷新统计',exact:true}).click();await expect(page.getByRole('alert')).toContainText('统计读取暂时失败');await page.getByRole('button',{name:/重试|重新加载/}).click();await expect(page.getByTestId('analytics-metric-completion')).toBeVisible();
});

for(const width of [1440,390,320])test(`analytics ${width}px tabs charts and resource cells fit`,async({page})=>{
 await page.setViewportSize({width,height:width===1440?900:844});await gotoAnalytics(page);await expect(page.locator('.analytics-page svg').first()).toBeVisible();
 for(const label of ['交付进展','计划偏差','资源负荷','人员任务分析']){await page.getByRole('button',{name:label,exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/analytics-${width}-${label}.png`,fullPage:true});}
});

 test('resource week position survives task detail return',async({page})=>{
 await page.setViewportSize({width:390,height:844});await gotoAnalytics(page);await page.getByRole('button',{name:'资源负荷',exact:true}).click();await page.getByRole('button',{name:'查看后几周'}).click();await page.getByRole('button',{name:'查看后几周'}).click();await expect(page.locator('.analytics-week-pager')).toContainText('2026-W39');await page.getByTestId('analytics-capacity-cell').first().click();await page.getByTestId('analytics-task-row').first().getByRole('link',{name:'打开任务详情'}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.locator('.analytics-week-pager')).toContainText('2026-W39');
 });

for(const tab of ['资源负荷','计划偏差','人员任务分析'])test(`switching to ${tab} before the initial summary arrives loads full detail`,async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let summaryStarted!:()=>void;const started=new Promise<void>(resolve=>{summaryStarted=resolve;});let held=false,fullReads=0;
 await page.route('**/api/v1/projects/phase-one/analytics**',async route=>{const url=new URL(route.request().url());if(url.searchParams.get('detail')==='full')fullReads++;if(!held){held=true;summaryStarted();await gate;}await route.fallback();});
 await page.goto('/projects/phase-one/analytics');await started;await page.getByRole('button',{name:tab,exact:true}).click();release();
 if(tab==='资源负荷')await expect(page.getByTestId('analytics-capacity-cell').first()).toBeVisible();else if(tab==='人员任务分析')await expect(page.getByTestId('personnel-total')).toContainText('48');else await expect(page.getByTestId('analytics-deviation-row').first()).toBeVisible();expect(fullReads).toBeGreaterThan(0);
});

test('failed lazy analytics detail is retryable without losing the chosen tab',async({page})=>{
 await gotoAnalytics(page);let failures=0;
 await page.route('**/api/v1/projects/phase-one/analytics**',async route=>{if(new URL(route.request().url()).searchParams.get('detail')==='full'&&failures++===0)await route.fulfill({status:503,json:{error:{message:'统计明细暂时失败，请重试。'}}});else await route.fallback();});
 await page.getByRole('button',{name:'资源负荷',exact:true}).click();await expect(page.locator('.analytics-error')).toContainText('统计明细暂时失败');await page.getByRole('button',{name:'重试统计',exact:true}).click();await expect(page.getByTestId('analytics-capacity-cell').first()).toBeVisible();await expect(page.getByRole('button',{name:'资源负荷',exact:true})).toHaveAttribute('aria-pressed','true');
});


test('a delayed old analytics response cannot replace a newer filter during debounce',async({page,demo})=>{
 await gotoAnalytics(page);let release!:()=>void,signal!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{signal=resolve;});let held=false;
 await page.route('**/api/v1/projects/phase-one/analytics**',async route=>{const url=new URL(route.request().url());if(!held&&url.searchParams.get('ownerId')==='chen'){held=true;const response=await demo.inject(url.pathname+url.search);signal();await gate;await route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});}else await route.fallback();});
 await page.getByLabel('统计负责人筛选',{exact:true}).selectOption('chen');await started;
 const latest=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/analytics')&&url.searchParams.get('ownerId')==='lin';});
 await page.getByLabel('统计负责人筛选',{exact:true}).selectOption('lin');release();await latest;
 const expected=await report(demo,{ownerId:'lin'});await expect(page.getByLabel('统计负责人筛选',{exact:true})).toHaveValue('lin');await expect(page.getByTestId('analytics-metric-completion')).toContainText(`分母 ${expected.metrics.completion.denominator}`);await page.getByTestId('analytics-metric-completion').click();await expect(page.getByTestId('analytics-task-row').filter({visible:true})).toHaveCount(expected.tasks.length);await expect(page.getByLabel('统计负责人筛选',{exact:true})).toHaveValue('lin');
});

test('personnel analysis expands denominator and missing tasks, retains state on return and exports facts', async ({page,demo}) => {
  await gotoAnalytics(page);
  await page.getByRole('button',{name:'人员任务分析',exact:true}).click();
  const r=await report(demo);
  await expect(page.getByTestId('personnel-total')).toContainText('48');
  await expect(page.getByTestId('personnel-metric-completion')).toContainText('37.5%');
  await expect(page.getByTestId('personnel-metric-late')).toContainText('暂无可计算数据');
  await page.getByLabel('人员排序指标').selectOption('completion');
  await page.getByLabel('人员排序方向').selectOption('asc');
  const member=r.personnel.members.find(m=>m.metrics.late.missing>0)!;
  const target=page.locator(`[data-testid="personnel-row"][data-member-id="${member.id}"]`);
  await target.getByRole('button',{name:`展开${member.name}指标`,exact:true}).click();
  const late=target.locator('.personnel-detail-metrics section').filter({has:page.getByRole('heading',{name:'已完成任务延期率',exact:true})});
  await late.getByRole('button',{name:`缺失 ${member.metrics.late.missing} 项`,exact:true}).click();
  await expect(page.getByTestId('analytics-task-row')).toHaveCount(member.metrics.late.missing);
  await expect(page.getByTestId('analytics-task-row').first()).toContainText('无法判定时效');
  await page.getByTestId('analytics-task-row').first().getByRole('link',{name:'打开任务详情'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
  await expect(page.locator('.analytics-tabs button[aria-pressed=true]')).toHaveText('人员任务分析');
  await expect(page.getByLabel('人员排序指标')).toHaveValue('completion');
  await expect(page.getByLabel('人员排序方向')).toHaveValue('asc');
  await expect(target.getByRole('button',{name:`收起${member.name}指标`,exact:true})).toHaveAttribute('aria-expanded','true');
  await expect(page.getByTestId('analytics-task-row')).toHaveCount(member.metrics.late.missing);
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出当前分析',exact:true}).click();
  const file=await download, csv=await readFile((await file.path())!,'utf8');
  expect(csv).toContain('人员任务分析'); expect(csv).toContain('分母任务ID');
  for(const task of r.tasks) expect(csv).toContain(task.id);
});

test('personnel refresh recomputes selected numerator and failure retries retain view', async ({page,demo}) => {
  const task=await create(demo,'人员分析刷新任务');
  await gotoAnalytics(page);
  await page.getByRole('button',{name:'人员任务分析',exact:true}).click();
  await page.getByLabel('统计负责人筛选',{exact:true}).selectOption('chen');
  await expect(page.getByTestId('personnel-row')).toHaveCount(1);
  await page.getByTestId('personnel-metric-completion').getByRole('button').click();
  const before=(await report(demo,{ownerId:'chen'})).personnel.summary.metrics.completion.numerator;
  await transition(demo,task.id,'complete');
  await page.getByRole('button',{name:'刷新统计',exact:true}).click();
  await expect(page.getByTestId('analytics-task-row')).toHaveCount(before+1);
  await expect(page.getByTestId('analytics-task-row').filter({hasText:'人员分析刷新任务'})).toContainText('按期完成');
  let failed=false;
  await page.route('**/api/v1/projects/phase-one/analytics**',async route=>{if(!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'人员分析读取失败，请重试。'}})});}else await route.fallback();});
  await page.getByRole('button',{name:'刷新统计',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('人员分析读取失败');
  await expect(page.getByTestId('personnel-total')).toHaveCount(0);
  await page.getByRole('button',{name:/重试|重新加载/}).click();
  await expect(page.getByTestId('personnel-total')).toBeVisible();
  await expect(page.getByLabel('统计负责人筛选',{exact:true})).toHaveValue('chen');
  await page.getByLabel('统计结束日期',{exact:true}).fill('2028-01-31');
  await page.getByLabel('统计开始日期',{exact:true}).fill('2028-01-01');
  await expect(page.getByTestId('personnel-total')).toContainText('0');
  await expect(page.getByTestId('personnel-row')).toHaveCount(1);
  await expect(page.getByTestId('personnel-metric-completion')).toContainText('暂无可计算数据');
  await expect(page.locator('.personnel-analysis')).toContainText('当前筛选没有执行任务');
});

for(const width of [1440,390,320]) test(`personnel expanded cards and keyboard drilldowns fit ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:width===1440?900:844});
  await gotoAnalytics(page); await page.getByRole('button',{name:'人员任务分析',exact:true}).click();
  if(width>=768) {
    const geometry=await page.evaluate(()=>{ const shell=document.querySelector('.app-shell')!, workspace=document.querySelector('.workspace')!, sidebar=document.querySelector('.sidebar')!, title=document.querySelector('#analytics-title')!; return {margin:getComputedStyle(workspace).marginLeft,variable:getComputedStyle(shell).getPropertyValue('--sidebar-width'),workspace:workspace.getBoundingClientRect().x,sidebar:sidebar.getBoundingClientRect().right,title:title.getBoundingClientRect().x}; });
    expect(geometry.title, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.sidebar);
  }
  await page.screenshot({path:info.outputPath(`personnel-${width}.png`),fullPage:true,animations:'disabled'});
  const row=page.getByTestId('personnel-row').first();
  const toggle=row.locator('button[aria-expanded]');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded','true');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`personnel-expanded-${width}.png`),fullPage:true,animations:'disabled'});
  const link=row.locator('.personnel-detail-metrics section').first().getByRole('button',{name:/^分母/});
  await link.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.analytics-task-details')).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
