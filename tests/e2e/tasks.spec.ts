import { test as base, expect, type Page } from '@playwright/test';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { TaskWorkspace, TaskDraft } from '../../shared/src/tasks';
const prefix='/api/v1/projects/phase-one/tasks';
const test=base.extend<{demo:FastifyInstance}>({
 demo:async({},use)=>{const app=buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'],dbPath:':memory:'});await use(app);await app.close();},
 page:async({page,demo},use)=>{await page.route('**/api/v1/**',async route=>{const r=route.request();const response=await demo.inject({method:r.method() as 'GET'|'POST'|'PATCH',url:new URL(r.url()).pathname+new URL(r.url()).search,headers:r.headers(),payload:r.postData()||undefined});await route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});});try { await use(page); } finally { await page.unrouteAll({behavior:'wait'}); await page.close(); }}
});
async function data(demo:FastifyInstance):Promise<TaskWorkspace>{return(await demo.inject(prefix)).json().data;}
async function seed(demo:FastifyInstance,title:string,extra:Partial<TaskDraft>={}){const w=await data(demo);const r=await demo.inject({method:'POST',url:prefix,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{title,description:'浏览验收独立示例',workstreamId:'system-bottom',parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:'2026-10-01',end:'2026-10-01',expectedPlanVersion:w.planVersion,...extra}});expect(r.statusCode,r.body).toBe(200);return r.json().data.task;}
async function closeSavedDrawer(page:Page){await expect(page.locator('.task-drawer')).toBeVisible();await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.locator('.task-drawer')).toHaveCount(0);}
async function confirmTransition(page:Page,name:string){const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/transition'));await page.getByRole('button',{name,exact:true}).click();if((await response).ok()){await expect(page.locator('.td-action-panel')).toHaveCount(0);await closeSavedDrawer(page);}}
async function open(page:Page,title:string){await page.getByLabel('搜索任务',{exact:true}).fill(title);await page.locator('.task-name-cell button').filter({hasText:title}).click();await expect(page.getByRole('dialog')).toBeVisible();}
async function action(page:Page,name:string,confirm:string,reason='浏览验收操作'){await page.getByRole('button',{name,exact:true}).click();if (['重开任务','取消任务'].includes(name)) await page.getByRole('textbox',{name:/操作说明/}).fill(reason); else if (['标记阻塞','解除阻塞'].includes(name)) await page.getByRole('textbox',{name:/阻塞说明/}).fill(reason); else if (name === '退回修改') await page.getByRole('textbox',{name:/验收意见/}).fill(reason); else await expect(page.getByRole('textbox',{name:/操作说明|验收意见/})).toHaveCount(0);await confirmTransition(page,confirm);}
async function gotoTasks(page:Page){await page.goto('/projects/phase-one/tasks');await expect(page.getByRole('heading',{name:'任务管理',exact:true})).toBeVisible();await expect(page.locator('.task-summary-line')).toBeVisible();}

test('list and board share filters; readonly identity has no write controls',async({page})=>{
 await gotoTasks(page);await expect(page.locator('.task-table tbody tr')).toHaveCount(30);
 await page.getByLabel('任务状态筛选').selectOption('all');await expect(page.locator('.task-table tbody tr')).toHaveCount(48);
 await page.getByRole('button',{name:'看板',exact:true}).click();await expect(page.locator('.task-board-card')).toHaveCount(48);
 await page.getByLabel('任务工作分组筛选').selectOption('system-bottom');await expect(page.locator('.task-board-card')).toHaveCount(8);
 await page.getByLabel('任务体验身份').selectOption('xu');await expect(page.getByRole('button',{name:'新建任务',exact:true})).toBeDisabled();
 await page.locator('.task-board-card').first().getByRole('button').click();await expect(page.getByRole('dialog')).toContainText('只读身份');await expect(page.getByRole('button',{name:'编辑任务',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByLabel('搜索任务',{exact:true}).fill('不存在999');await expect(page.getByRole('heading',{name:'这里暂时没有任务'})).toBeVisible();
});
test('create an unplanned task, keep dirty input, and open its inline plan editor',async({page,demo})=>{
 await gotoTasks(page);await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await page.getByRole('textbox',{name:/任务名称/}).fill('待排期的测试任务');await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.getByRole('heading',{name:'还有未保存的内容'})).toBeVisible();await page.getByRole('button',{name:'保留并继续编辑'}).click();
 await expect(page.getByRole('textbox',{name:/任务名称/})).toHaveValue('待排期的测试任务');
 await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await expect(page.getByRole('dialog')).toContainText('待排期的测试任务');await expect(page.getByRole('dialog')).toContainText('待排期');
 const task=(await data(demo)).tasks.find(t=>t.title==='待排期的测试任务')!;expect(task.start).toBeNull();expect(task.end).toBeNull();
 const overview=(await demo.inject('/api/v1/projects/phase-one/overview')).json().data;expect(overview.summary.overdueTasks).toBe(4);expect(overview.summary.totalTasks).toBe(49);
 await page.getByRole('button',{name:'查看计划与依赖',exact:true}).click();await expect(page).toHaveURL(new RegExp('/tasks/'+task.id));await expect(page.getByRole('tab',{name:'计划与依赖',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('dialog')).toContainText(task.title);
});
test('ordinary task start, progress, block/unblock, complete, reopen and cancel persist',async({page,demo})=>{
 const task=await seed(demo,'普通执行闭环');await gotoTasks(page);await open(page,task.title);
 await action(page,'开始任务','确认开始');await expect(page.getByRole('dialog')).toHaveCount(0);
 await open(page,task.title);await page.getByRole('button',{name:'更新进度',exact:true}).click();await page.getByLabel('当前进度（%）').fill('45');await expect(page.getByRole('textbox',{name:/操作说明/})).toHaveCount(0);await confirmTransition(page,'确认更新进度');
 await open(page,task.title);await action(page,'标记阻塞','确认标记阻塞','等待接口说明');await open(page,task.title);await expect(page.getByRole('dialog')).toContainText('等待接口说明');await action(page,'标记完成','确认完成');await expect(page.getByRole('alert')).toContainText('阻塞');
 await page.getByRole('button',{name:'收起操作确认',exact:true}).click();await expect(page.getByRole('button',{name:'放弃未保存内容',exact:true})).toHaveCount(0);await action(page,'解除阻塞','确认解除阻塞');await open(page,task.title);await action(page,'标记完成','确认完成');
 await page.getByLabel('任务状态筛选').selectOption('done');await open(page,task.title);await page.getByRole('button',{name:'重开任务',exact:true}).click();await page.getByLabel('重开后的进度（%）').fill('20');await page.getByRole('textbox',{name:/操作说明/}).fill('回归发现需补充场景');await confirmTransition(page,'确认重开');
 await page.getByLabel('任务状态筛选').selectOption('active');await open(page,task.title);await action(page,'取消任务','确认取消','工作范围取消，保留历史');
 const after=(await data(demo)).tasks.find(t=>t.id===task.id)!;expect(after.status).toBe('cancelled');expect(after.actualStart).toBeTruthy();expect(after.actualEnd).toBeNull();expect(after.events.length).toBeGreaterThanOrEqual(8);
 await page.getByLabel('任务状态筛选').selectOption('cancelled');await expect(page.locator('.task-table tbody tr')).toHaveCount(1);
});
test('key deliverable supports independent rejection, resubmission and acceptance',async({page,demo})=>{
 const task=await seed(demo,'独立验收闭环',{requiresReview:true,reviewerId:'lin',acceptanceCriteria:'接口场景检查通过'});await gotoTasks(page);await open(page,task.title);await action(page,'开始任务','确认开始');
 await page.getByLabel('任务体验身份').selectOption('chen');await open(page,task.title);await expect(page.getByRole('button',{name:'标记完成',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'提交验收',exact:true}).click();await page.locator('.td-action-panel').getByLabel('成果说明与链接').fill('第一版接口场景说明');await expect(page.getByRole('textbox',{name:/操作说明/})).toHaveCount(0);await confirmTransition(page,'确认提交验收');
 await page.getByLabel('任务体验身份').selectOption('lin');await open(page,task.title);await action(page,'退回修改','确认退回修改','补充异常输入场景');
 await page.getByLabel('任务体验身份').selectOption('chen');await open(page,task.title);await page.getByRole('button',{name:'提交验收',exact:true}).click();await page.locator('.td-action-panel').getByLabel('成果说明与链接').fill('第二版已补充异常输入场景');await expect(page.getByRole('textbox',{name:/操作说明/})).toHaveCount(0);await confirmTransition(page,'确认提交验收');
 await page.getByLabel('任务体验身份').selectOption('lin');await open(page,task.title);await expect(page.locator('.td-review-evidence')).toHaveCount(0);await action(page,'验收通过','确认验收通过','检查全部通过');
 const after=(await data(demo)).tasks.find(t=>t.id===task.id)!;expect(after.status).toBe('done');expect(after.progress).toBe(100);expect(after.submissions.map(s=>s.status)).toEqual(['rejected','accepted']);
});
test('comments stay open and stale edits retain draft and require explicit refresh',async({page,demo})=>{
 const task=await seed(demo,'并发编辑校验');await gotoTasks(page);await open(page,task.title);await page.getByRole('tab',{name:'活动记录',exact:true}).click();await page.getByLabel('补充进展').fill('本机协作评论');await page.getByRole('button',{name:'保存评论',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('.td-event').first()).toContainText('本机协作评论');
 await page.getByRole('tab',{name:'详情',exact:true}).click();await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByRole('textbox',{name:'任务描述',exact:true}).fill('本地尚未保存的说明');
 await seed(demo,'另一处改变了计划版本');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.getByRole('alert')).toContainText('更新');await expect(page.getByRole('textbox',{name:'任务描述',exact:true})).toHaveValue('本地尚未保存的说明');await page.getByRole('button',{name:'重新读取任务（保留填写内容）',exact:true}).click();await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.getByRole('button',{name:'编辑任务',exact:true})).toBeVisible();await closeSavedDrawer(page);
 expect((await data(demo)).tasks.find(t=>t.id===task.id)?.description).toBe('本地尚未保存的说明');
});
test('browser back preserves unsaved input until discard is explicit',async({page,demo})=>{
 const task=await seed(demo,'导航草稿保护');await gotoTasks(page);await open(page,task.title);await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByRole('textbox',{name:'任务描述',exact:true}).fill('不可丢失的草稿');
 await page.goBack();await expect(page.getByRole('heading',{name:'还有未保存的内容'})).toBeVisible();await page.getByRole('button',{name:'保留并继续编辑'}).click();await expect(page.getByRole('textbox',{name:'任务描述',exact:true})).toHaveValue('不可丢失的草稿');
 await page.goBack();await page.getByRole('button',{name:'放弃未保存内容',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await data(demo)).tasks.find(t=>t.id===task.id)?.description).not.toBe('不可丢失的草稿');
});
test('batch edit previews all selected tasks and applies as one operation',async({page,demo})=>{
 await seed(demo,'批量确认任务甲');await seed(demo,'批量确认任务乙');await gotoTasks(page);await page.getByLabel('搜索任务',{exact:true}).fill('批量确认任务');await page.getByRole('checkbox',{name:'选择全部筛选任务',exact:true}).check();await page.getByRole('button',{name:'批量修改',exact:true}).click();await page.getByRole('combobox',{name:'修改为',exact:true}).selectOption('P0');await page.getByLabel('修改原因',{exact:true}).fill('需要优先交付');await page.getByRole('button',{name:'核对修改范围',exact:true}).click();
 expect((await data(demo)).tasks.filter(t=>t.title.startsWith('批量确认任务')).every(t=>t.priority==='P1')).toBe(true);await page.getByRole('button',{name:'确认修改 2 项任务',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await data(demo)).tasks.filter(t=>t.title.startsWith('批量确认任务')).every(t=>t.priority==='P0')).toBe(true);
});
test('kanban drag opens a confirmation instead of changing state immediately',async({page,demo})=>{
 const task=await seed(demo,'看板拖动确认');await gotoTasks(page);await page.getByLabel('搜索任务',{exact:true}).fill(task.title);await expect(page.locator('.task-result-bar')).toContainText('共 1 项');await page.getByRole('button',{name:'看板',exact:true}).click();await expect(page.locator('.task-board-card')).toHaveCount(1);await page.locator('.task-board-card').filter({hasText:task.title}).dragTo(page.getByRole('region',{name:'进行中看板列'}));await expect(page.getByRole('heading',{name:'开始任务',exact:true})).toBeVisible();expect((await data(demo)).tasks.find(t=>t.id===task.id)?.status).toBe('todo');
});
for(const width of [1440,390,320])test(`tasks ${width}px layout and detail forms fit`,async({page})=>{
 await page.setViewportSize({width,height:width===1440?900:844});await gotoTasks(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/tasks-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await expect(page.getByRole('textbox',{name:/任务名称/})).toBeVisible();expect(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:`test-results/tasks-form-${width}.png`,fullPage:true});await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByRole('button',{name:'看板',exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/tasks-board-${width}.png`,fullPage:true});
});

test('existing estimated root can become a parent; conversion preserves original work and prevents a third level',async({page,demo})=>{
 const before=await data(demo);const stream=before.workstreams.find(s=>s.name==='收费模式')!;
 const original=before.tasks.find(t=>t.workstreamId===stream.id&&t.status==='in_progress')!;
 await gotoTasks(page);await page.getByLabel('任务工作分组筛选').selectOption(stream.id);await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'所属工作分组',exact:true})).toHaveValue(stream.id);
 await page.getByRole('textbox',{name:/任务名称/}).fill('父任务转换验收子项');
 await page.getByLabel('搜索父任务',{exact:true}).fill(original.title);
 const parentSelect=page.getByRole('combobox',{name:'父任务（可选）',exact:true});
 await expect(parentSelect.locator(`option[value="${original.id}"]`)).toHaveJSProperty('disabled',false);await parentSelect.selectOption(original.id);
 await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await expect(page.getByRole('heading',{name:'转为汇总父任务',exact:true})).toBeVisible();
 expect((await data(demo)).tasks).toHaveLength(48);
 await page.getByRole('button',{name:'返回编辑',exact:true}).click();await expect(page.getByRole('textbox',{name:/任务名称/})).toHaveValue('父任务转换验收子项');
 expect((await data(demo)).planVersion).toBe(before.planVersion);
 await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await page.getByRole('button',{name:'确认转换并创建',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('父任务转换验收子项');
 const after=await data(demo);const child=after.tasks.find(t=>t.title==='父任务转换验收子项')!;const retained=after.tasks.find(t=>t.id===original.id)!;const parent=after.tasks.find(t=>t.id===child.parentId)!;
 expect(after.tasks).toHaveLength(50);expect(parent.taskKind).toBe('summary');expect(parent.parentId).toBeNull();expect(retained.parentId).toBe(parent.id);expect(retained.originalWork).toBe(true);
 for(const key of ['wbs','effortHours','progress','status','ownerId','start','end','evidence','actualStart','actualEnd'] as const)expect(retained[key]).toEqual(original[key]);
 expect(after.dependencies).toEqual(before.dependencies);
 const overview=(await demo.inject('/api/v1/projects/phase-one/overview')).json().data;expect(overview.summary.totalTasks).toBe(49);
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await expect(parentSelect.locator(`option[value="${parent.id}"]`)).toHaveJSProperty('disabled',false);await expect(parentSelect.locator(`option[value="${child.id}"]`)).toHaveCount(0);await expect(parentSelect.locator(`option[value="${original.id}"]`)).toHaveCount(0);
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.goto(`/projects/phase-one/tasks/${original.id}`);await expect(page.getByRole('dialog')).toContainText('原有工作');await expect(page.getByRole('dialog')).toContainText('父任务');
 await page.getByRole('button',{name:'查看计划与依赖',exact:true}).click();await expect(page.getByRole('tab',{name:'计划与依赖',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('dialog')).toContainText(original.title);
});

test('parent candidates explain blocked states and inherit a changed workstream',async({page,demo})=>{
 const before=await data(demo);const done=before.tasks.find(t=>t.status==='done')!;
 await gotoTasks(page);await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('combobox',{name:'所属工作分组',exact:true}).selectOption(done.workstreamId);
 const option=page.getByRole('combobox',{name:'父任务（可选）',exact:true}).locator(`option[value="${done.id}"]`);await expect(option).toHaveJSProperty('disabled',true);await expect(option).toContainText('重开');
 await page.getByLabel('搜索父任务',{exact:true}).fill('没有这个父任务999');await expect(page.getByRole('dialog')).toContainText('没有匹配');
});

test('lost conversion response retries idempotently without duplicate summaries',async({page,demo})=>{
 const parent=await seed(demo,'转换响应重试原任务');await gotoTasks(page);await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('textbox',{name:/任务名称/}).fill('转换响应重试子任务');await page.getByRole('combobox',{name:'父任务（可选）',exact:true}).selectOption(parent.id);await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await expect(page.getByRole('heading',{name:'转为汇总父任务',exact:true})).toBeVisible();
 let lost=false;await page.route('**/api/v1/projects/phase-one/tasks',async route=>{if(route.request().method()!=='POST'||lost){await route.fallback();return;}lost=true;const r=route.request();const result=await demo.inject({method:'POST',url:prefix,headers:r.headers(),payload:r.postData()!});expect(result.statusCode,result.body).toBe(200);await route.abort('failed');});
 await page.getByRole('button',{name:'确认转换并创建',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();expect((await data(demo)).tasks).toHaveLength(51);
 await page.getByRole('button',{name:'确认转换并创建',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('转换响应重试子任务');expect((await data(demo)).tasks).toHaveLength(51);
});

test('conversion conflict retains draft and requires a fresh preview',async({page,demo})=>{
 const parent=await seed(demo,'转换并发原任务');await gotoTasks(page);await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('textbox',{name:/任务名称/}).fill('转换并发子任务');await page.getByRole('combobox',{name:'父任务（可选）',exact:true}).selectOption(parent.id);await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await expect(page.getByRole('heading',{name:'转为汇总父任务',exact:true})).toBeVisible();
 await seed(demo,'另一个计划写入');await page.getByRole('button',{name:'确认转换并创建',exact:true}).click();await expect(page.getByRole('alert')).toContainText('更新');expect((await data(demo)).tasks.find(t=>t.id===parent.id)?.parentId).toBeNull();
 await page.getByRole('button',{name:'重新读取任务（保留填写内容）',exact:true}).click();await expect(page.getByRole('textbox',{name:/任务名称/})).toHaveValue('转换并发子任务');await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await expect(page.getByRole('heading',{name:'转为汇总父任务',exact:true})).toBeVisible();await page.getByRole('button',{name:'确认转换并创建',exact:true}).click();
 expect((await data(demo)).tasks.filter(t=>t.title==='转换并发子任务')).toHaveLength(1);
});

for(const width of [1440,390,320])test(`parent conversion preview at ${width}px is usable`,async({page,demo})=>{
 const parent=await seed(demo,'两级任务响应式父任务');await page.setViewportSize({width,height:width===1440?900:844});await gotoTasks(page);await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('textbox',{name:/任务名称/}).fill('响应式二级任务');await page.getByRole('combobox',{name:'父任务（可选）',exact:true}).selectOption(parent.id);await page.getByRole('button',{name:/^(?:预览转换并创建|创建任务)$/}).click();await expect(page.getByRole('heading',{name:'转为汇总父任务',exact:true})).toBeVisible();
 const dialog=page.getByRole('dialog');expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole('button',{name:'确认转换并创建',exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'确认转换并创建',exact:true})).toBeVisible();await page.screenshot({path:`test-results/parent-preview-${width}.png`});
});

test('batch selection excludes summary parents and updates only execution children',async({page,demo})=>{
 const original=await seed(demo,'汇总批量范围原任务');const w=await data(demo);
 const r=await demo.inject({method:'POST',url:prefix,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{title:'汇总批量范围新任务',description:'',workstreamId:original.workstreamId,parentId:original.id,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion,confirmParentConversion:true,expectedParentVersion:original.version}});expect(r.statusCode,r.body).toBe(200);const parentId=r.json().data.parentTask.id;
 await gotoTasks(page);await page.getByLabel('搜索任务',{exact:true}).fill('汇总批量范围');await expect(page.locator('.task-table tbody tr')).toHaveCount(3);await expect(page.locator('.task-table tbody input[type=checkbox]:disabled')).toHaveCount(1);
 await page.getByRole('checkbox',{name:'选择全部筛选任务',exact:true}).check();await page.getByRole('button',{name:'批量修改',exact:true}).click();await page.getByRole('combobox',{name:'修改为',exact:true}).selectOption('P0');await page.getByLabel('修改原因',{exact:true}).fill('只调整执行任务');await page.getByRole('button',{name:'核对修改范围',exact:true}).click();await page.getByRole('button',{name:'确认修改 2 项任务',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const after=await data(demo);expect(after.tasks.find(t=>t.id===parentId)?.priority).toBe('P1');expect(after.tasks.filter(t=>t.parentId===parentId).every(t=>t.priority==='P0')).toBe(true);
});

test('cancelled legacy summary can restore from the drawer without an execution progress input',async({page})=>{
 const directory=mkdtempSync(join(tmpdir(),'goodwork-summary-restore-'));const dbPath=join(directory,'demo.sqlite');const isolated=buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'],dbPath});
 try {
  const original=await seed(isolated,'历史汇总恢复原任务');const w=await data(isolated);const r=await isolated.inject({method:'POST',url:prefix,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{title:'历史汇总恢复子任务',description:'',workstreamId:original.workstreamId,parentId:original.id,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion,confirmParentConversion:true,expectedParentVersion:original.version}});expect(r.statusCode,r.body).toBe(200);const parentId=r.json().data.parentTask.id;
  const fixture=new Database(dbPath);fixture.prepare("UPDATE task_meta SET meta_json=json_set(meta_json,'$.cancelled',1) WHERE task_id=?").run(parentId);fixture.close();
  await page.route('**/api/v1/**',async route=>{const r=route.request();const response=await isolated.inject({method:r.method() as 'GET'|'POST'|'PATCH',url:new URL(r.url()).pathname+new URL(r.url()).search,headers:r.headers(),payload:r.postData()||undefined});await route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});});
  await page.goto(`/projects/phase-one/tasks/${parentId}`);await expect(page.getByRole('dialog')).toContainText('已取消');await page.getByRole('button',{name:'重开任务',exact:true}).click();await expect(page.getByLabel('重开后的进度（%）')).toHaveCount(0);await page.getByRole('textbox',{name:/操作说明/}).fill('恢复历史汇总节点');await confirmTransition(page,'确认重开');await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await data(isolated)).tasks.find(t=>t.id===parentId)).toMatchObject({taskKind:'summary',status:'todo',progress:0,actualStart:null,actualEnd:null});
 } finally {await isolated.close();rmSync(directory,{recursive:true,force:true});}
});

test('task detail read failure retries the detail endpoint and opens the original task',async({page,demo})=>{
 const task=await seed(demo,'详情读取失败恢复');let detailReads=0;
 await page.route(`**/api/v1/projects/phase-one/tasks/${task.id}`,async route=>{if(route.request().method()!=='GET'){await route.fallback();return;}detailReads++;if(detailReads===1)await route.fulfill({status:503,json:{error:{code:'TEMPORARILY_UNAVAILABLE',message:'详情读取暂时失败，请重新加载。'}}});else await route.fallback();});
 await page.goto(`/projects/phase-one/tasks/${task.id}`);await expect(page.locator('.task-page-error')).toContainText('详情读取暂时失败');await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'重新加载任务',exact:true}).click();await expect(page.getByRole('dialog')).toContainText(task.title);expect(detailReads).toBe(2);
});

test('stale task draft freezes structure version and changes request key only after explicit reload',async({page,demo})=>{
 const task=await seed(demo,'结构版本冻结回归');await gotoTasks(page);await open(page,task.title);await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByLabel('任务描述',{exact:true}).fill('结构变化后仍应保留的草稿');
 const original=await data(demo);const writes:Array<{key:string|undefined;body:any}>=[];page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname===`${prefix}/${task.id}`)writes.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});});
 await seed(demo,'来自另一个协作会话的结构变化');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.getByRole('alert')).toContainText('更新');expect(writes[0]?.body.expectedStructureVersion).toBe(original.structureVersion);expect((await data(demo)).tasks.find(t=>t.id===task.id)?.description).not.toBe('结构变化后仍应保留的草稿');
 await expect(page.getByLabel('任务描述',{exact:true})).toHaveValue('结构变化后仍应保留的草稿');await page.getByRole('button',{name:'重新读取任务（保留填写内容）',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('已重新读取最新记录');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.getByRole('button',{name:'编辑任务',exact:true})).toBeVisible();await closeSavedDrawer(page);expect(writes[1]?.body.expectedStructureVersion).toBeGreaterThan(original.structureVersion!);expect(writes[1]?.key).not.toBe(writes[0]?.key);expect((await data(demo)).tasks.find(t=>t.id===task.id)?.description).toBe('结构变化后仍应保留的草稿');
});
