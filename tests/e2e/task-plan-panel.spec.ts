import {test as base,expect} from '@playwright/test';
import type {FastifyInstance} from 'fastify';
import {buildLegacyApp} from '../helpers/legacy-app.js';
const prefix='/api/v1/projects/phase-one';
const test=base.extend<{demo:FastifyInstance}>({
 demo:async({},use)=>{const app=buildLegacyApp({dbPath:':memory:',jobIntervalMs:0,allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174']});await use(app);await app.close();},
 page:async({page,demo},use)=>{await page.route('**/api/v1/**',async route=>{const r=route.request(),u=new URL(r.url());const response=await demo.inject({method:r.method() as 'GET'|'POST'|'PATCH',url:u.pathname+u.search,headers:r.headers(),payload:r.postData()||undefined});await route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});});await use(page);await page.unrouteAll({behavior:'wait'});}
});
async function seed(demo:FastifyInstance,title:string,scheduled=false){const w=(await demo.inject(prefix+'/tasks')).json().data;const r=await demo.inject({method:'POST',url:prefix+'/tasks',headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{title,description:'原始描述',workstreamId:'system-bottom',parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion,...(scheduled?{start:'2026-10-12',end:'2026-10-14'}:{})}});expect(r.statusCode,r.body).toBe(200);return r.json().data.task;}
async function plan(demo:FastifyInstance){return (await demo.inject(prefix+'/gantt')).json().data;}
for(const width of [1440,390,320])test(`unplanned dependencies preserve dates, basic draft, and drawer at ${width}px`,async({page,demo})=>{
 const predecessor=await seed(demo,'前置未排期'),task=await seed(demo,'待设置依赖任务');const before=await plan(demo);
 await page.setViewportSize({width,height:width===1440?900:844});await page.goto(`/projects/phase-one/tasks/${task.id}`);
 await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByRole('textbox',{name:'任务描述',exact:true}).fill('尚未保存的描述');
 await page.getByRole('tab',{name:'计划与依赖',exact:true}).click();await page.getByRole('button',{name:'调整计划',exact:true}).click();
 await expect(page.getByLabel('保存方式',{exact:true})).toHaveValue('relationships_only');await expect(page.getByLabel('计划开始',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'＋ 添加依赖',exact:true}).click();await page.getByLabel('搜索前置对象',{exact:true}).fill(predecessor.title);await page.getByLabel('前置对象 1',{exact:true}).selectOption(predecessor.id);await page.getByLabel('依赖间隔 1',{exact:true}).fill('2');
 await page.getByRole('tab',{name:'详情',exact:true}).click();await expect(page.getByRole('textbox',{name:'任务描述',exact:true})).toHaveValue('尚未保存的描述');await page.getByRole('tab',{name:'计划与依赖',exact:true}).click();await expect(page.getByLabel('依赖间隔 1',{exact:true})).toHaveValue('2');
 await page.getByRole('button',{name:'预览调整',exact:true}).click();await expect(page.locator('.task-plan-panel')).toContainText('仅保存依赖关系，所有日期保持原样。');await expect(page.locator('.tp-diff')).toContainText('新增：');
 await page.screenshot({path:`/private/tmp/goodwork-task-plan-preview-${width}.png`});
 const handle=await page.locator('.task-drawer').elementHandle();await page.getByRole('button',{name:'确认保存调整',exact:true}).click();await expect(page.getByRole('button',{name:'调整计划',exact:true})).toBeVisible();expect(await handle!.evaluate(el=>el.isConnected)).toBe(true);
 const after=await plan(demo);expect(after.dependencies).toContainEqual({predecessorId:predecessor.id,successorId:task.id,type:'FS',lagDays:2});expect(after.nodes.map((n:any)=>[n.id,n.start,n.end,n.durationDays])).toEqual(before.nodes.map((n:any)=>[n.id,n.start,n.end,n.durationDays]));
 await page.getByRole('tab',{name:'详情',exact:true}).click();await expect(page.getByRole('textbox',{name:'任务描述',exact:true})).toHaveValue('尚未保存的描述');await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.getByRole('heading',{name:'还有未保存的内容'})).toBeVisible();await page.getByRole('button',{name:'保留并继续编辑'}).click();
 expect(await page.locator('.task-drawer').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`/private/tmp/goodwork-task-plan-${width}.png`});
});
test('date drafts require explicit discard when switching to relationship-only mode',async({page,demo})=>{
 const task=await seed(demo,'日期草稿保留',true);await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByRole('button',{name:'查看计划与依赖',exact:true}).click();
 await page.getByLabel('计划开始',{exact:true}).fill('2026-10-13');await page.getByLabel('保存方式',{exact:true}).selectOption('relationships_only');await expect(page.getByRole('heading',{name:'切换后将丢弃本次日期修改'})).toBeVisible();
 await page.getByRole('button',{name:'继续编辑',exact:true}).click();await expect(page.getByLabel('计划开始',{exact:true})).toHaveValue('2026-10-13');await expect(page.getByLabel('保存方式',{exact:true})).toHaveValue('schedule');
 await page.getByLabel('保存方式',{exact:true}).selectOption('relationships_only');await page.getByRole('button',{name:'丢弃日期修改并切换'}).click();await expect(page.getByLabel('计划开始',{exact:true})).toHaveValue('2026-10-12');await expect(page.getByLabel('保存方式',{exact:true})).toHaveValue('relationships_only');
});
test('saving basic information retains a separate plan draft and refreshes conflict explicitly',async({page,demo})=>{
 const task=await seed(demo,'双草稿保存',true);await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByRole('button',{name:'查看计划与依赖',exact:true}).click();await page.getByLabel('计划结束',{exact:true}).fill('2026-10-15');
 await page.getByRole('tab',{name:'详情',exact:true}).click();await page.getByRole('button',{name:'编辑任务',exact:true}).click();await page.getByRole('textbox',{name:'任务描述',exact:true}).fill('已保存描述');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.locator('#td-panel-detail')).toContainText('已保存描述');
 await page.getByRole('tab',{name:'计划与依赖',exact:true}).click();await expect(page.getByLabel('计划结束',{exact:true})).toHaveValue('2026-10-15');await expect(page.getByRole('button',{name:'预览调整',exact:true})).toBeDisabled();
 await expect(page.locator('.task-plan-panel [role=alert]')).toBeVisible();await page.getByRole('button',{name:'重新读取计划（保留填写内容）',exact:true}).click();await expect(page.getByLabel('计划结束',{exact:true})).toHaveValue('2026-10-15');
 await page.getByRole('button',{name:'预览调整',exact:true}).click();await expect(page.locator('.tp-change')).toContainText('直接调整');await page.getByRole('button',{name:'确认保存调整',exact:true}).click();await expect(page.getByRole('button',{name:'调整计划',exact:true})).toBeVisible();expect((await plan(demo)).nodes.find((n:any)=>n.id===task.id).end).toBe('2026-10-15');
});
test('lost apply response retries one receipt and related task navigation offers return',async({page,demo})=>{
 const predecessor=await seed(demo,'返回前置任务'),task=await seed(demo,'原任务返回');await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByRole('button',{name:'查看计划与依赖',exact:true}).click();await page.getByRole('button',{name:'＋ 添加依赖',exact:true}).click();await page.getByLabel('前置对象 1',{exact:true}).selectOption(predecessor.id);await page.getByRole('button',{name:'预览调整',exact:true}).click();
 await page.route('**/schedule/apply',async route=>{const r=route.request();await demo.inject({method:'POST',url:prefix+'/schedule/apply',headers:r.headers(),payload:r.postData()!});await route.abort('failed');},{times:1});
 await page.getByRole('button',{name:'确认保存调整',exact:true}).click();await expect(page.locator('.task-plan-panel [role=alert]')).toBeVisible();await page.getByRole('button',{name:'确认保存调整',exact:true}).click();await expect(page.getByRole('button',{name:'调整计划',exact:true})).toBeVisible();
 await page.locator('.task-plan-panel .td-related-task').filter({hasText:predecessor.title}).click();await expect(page.locator('#td-title')).toHaveText(predecessor.title);await page.getByRole('button',{name:`‹ 返回 ${task.title}`,exact:true}).click();await expect(page.locator('#td-title')).toHaveText(task.title);
});
test('task owner cannot edit schedule and failed initial plan read can retry',async({page,demo})=>{
 const task=await seed(demo,'成员计划只读');await page.goto('/projects/phase-one/tasks');await page.getByLabel('任务体验身份').selectOption('chen');await page.getByLabel('搜索任务',{exact:true}).fill(task.title);await page.locator('.task-name-cell button').filter({hasText:task.title}).click();
 await page.route('**/gantt',route=>route.fulfill({status:503,json:{error:{message:'暂时无法读取计划'}}}),{times:1});await page.getByRole('tab',{name:'计划与依赖',exact:true}).click();await expect(page.locator('.task-plan-panel [role=alert]')).toContainText('暂时无法读取计划');await page.getByRole('button',{name:'重新读取计划（保留填写内容）',exact:true}).click();await expect(page.locator('.task-plan-panel')).toContainText('仅本项目负责人或项目管理员');await expect(page.getByRole('button',{name:'调整计划',exact:true})).toHaveCount(0);
});
test('collapsing an untouched execution action retains the plan draft without a discard prompt',async({page,demo})=>{
 const task=await seed(demo,'操作与计划草稿独立',true);await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByRole('button',{name:'开始任务',exact:true}).click();
 await page.getByRole('tab',{name:'计划与依赖',exact:true}).click();await page.getByRole('button',{name:'调整计划',exact:true}).click();await page.getByLabel('计划结束',{exact:true}).fill('2026-10-15');
 await page.getByRole('tab',{name:'详情',exact:true}).click();await page.getByRole('button',{name:'收起操作确认',exact:true}).click();await expect(page.getByRole('heading',{name:'还有未保存的内容'})).toHaveCount(0);
 await page.getByRole('tab',{name:'计划与依赖',exact:true}).click();await expect(page.getByLabel('计划结束',{exact:true})).toHaveValue('2026-10-15');await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page.getByRole('heading',{name:'还有未保存的内容'})).toBeVisible();
});
test('a relationship-first unplanned chain can later receive all dates in one explicit preview',async({page,demo})=>{
 const predecessor=await seed(demo,'先建关系的前置'),task=await seed(demo,'后补排期的任务');const w=await plan(demo),headers={'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()};
 const p=await demo.inject({method:'POST',url:prefix+'/schedule/preview',headers,payload:{expectedPlanVersion:w.planVersion,calculation:'relationships_only',changes:[],mode:'push_successors',dependencyTargetId:task.id,incomingDependencies:[{predecessorId:predecessor.id,lagDays:0}]}});expect(p.statusCode,p.body).toBe(200);const preview=p.json().data;expect((await demo.inject({method:'POST',url:prefix+'/schedule/apply',headers,payload:{previewId:preview.id,expectedPlanVersion:preview.basePlanVersion}})).statusCode).toBe(200);
 await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByRole('button',{name:'查看计划与依赖',exact:true}).click();await page.getByLabel('保存方式',{exact:true}).selectOption('schedule');await page.getByLabel('计划开始',{exact:true}).fill('2026-10-14');await page.getByLabel('计划结束',{exact:true}).fill('2026-10-15');
 await page.getByLabel(`补齐开始 ${predecessor.title}`,{exact:true}).fill('2026-10-12');await page.getByLabel(`补齐结束 ${predecessor.title}`,{exact:true}).fill('2026-10-13');
 expect((await plan(demo)).nodes.find((n:any)=>n.id===task.id).start).toBeNull();await page.getByRole('button',{name:'预览调整',exact:true}).click();await expect(page.locator('.tp-change')).toHaveCount(2);expect((await plan(demo)).nodes.find((n:any)=>n.id===predecessor.id).start).toBeNull();
 await page.getByRole('button',{name:'确认保存调整',exact:true}).click();await expect(page.getByRole('button',{name:'调整计划',exact:true})).toBeVisible();const after=await plan(demo);expect(after.nodes.find((n:any)=>n.id===predecessor.id).start).toBe('2026-10-12');expect(after.nodes.find((n:any)=>n.id===task.id).start).toBe('2026-10-14');
});
