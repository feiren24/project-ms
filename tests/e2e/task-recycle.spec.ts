import {test as base,expect} from '@playwright/test';
import {buildLegacyApp} from '../helpers/legacy-app.js';
import type {FastifyInstance} from 'fastify';
const prefix='/api/v1/projects/phase-one/tasks';
const test=base.extend<{demo:FastifyInstance}>({
 demo:async({},use)=>{const app=buildLegacyApp({dbPath:':memory:',allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174']});await use(app);await app.close();},
 page:async({page,demo},use)=>{await page.route('**/api/v1/**',async route=>{const r=route.request(),u=new URL(r.url());const response=await demo.inject({method:r.method() as 'GET'|'POST',url:u.pathname+u.search,headers:r.headers(),payload:r.postData()||undefined});await route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});});await use(page);await page.unrouteAll({behavior:'wait'});}
});
async function seed(demo:FastifyInstance){const w=(await demo.inject(prefix)).json().data;const r=await demo.inject({method:'POST',url:prefix,headers:{'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{title:'回收站界面验收',description:'虚构任务内容',workstreamId:w.workstreams[0].id,parentId:null,ownerId:'chen',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',expectedPlanVersion:w.planVersion}});expect(r.statusCode).toBe(200);return r.json().data.task;}
for(const width of [1440,390,320])test(`delete and restore with reason at ${width}px`,async({page,demo})=>{
 await seed(demo);await page.setViewportSize({width,height:width===1440?900:844});await page.goto('/projects/phase-one/tasks');
 await page.getByLabel('搜索任务',{exact:true}).fill('回收站界面验收');await page.locator('.task-name-cell button:visible, .task-mobile-cards article > button:visible').filter({hasText:'回收站界面验收'}).click();
 await page.getByLabel('任务更多操作',{exact:true}).click();await page.getByRole('button',{name:'删除任务',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'删除任务',exact:true});await expect(dialog).toContainText('关联检查：已通过');
 await expect(dialog.getByRole('button',{name:'移入回收站',exact:true})).toBeDisabled();await dialog.getByLabel('删除原因',{exact:false}).fill('重复创建的演示任务');
 await page.screenshot({path:`/private/tmp/goodwork-recycle-delete-${width}.png`});
 await dialog.getByRole('button',{name:'移入回收站',exact:true}).click();await expect(dialog).toHaveCount(0);
 await expect(page.getByLabel('搜索任务',{exact:true})).toHaveValue('回收站界面验收');
 await page.getByRole('button',{name:'已删除任务',exact:true}).click();await expect(page.getByRole('heading',{name:'已删除任务',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看记录',exact:true}).click();await expect(page.getByText('重复创建的演示任务',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'检查并恢复任务',exact:true}).click();const restore=page.getByRole('dialog',{name:'恢复任务',exact:true});await expect(restore).toContainText('关联检查：已通过');
 await restore.getByLabel('恢复原因',{exact:false}).fill('误删，恢复原任务');await restore.getByRole('button',{name:'确认恢复任务',exact:true}).click();await expect(restore).toHaveCount(0);
 await page.getByRole('button',{name:'查看任务',exact:true}).click();await expect(page.locator('.task-drawer')).toContainText('回收站界面验收');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('stale preview keeps the deletion reason and requires a fresh impact check',async({page,demo})=>{
 const task=await seed(demo);await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByLabel('任务更多操作',{exact:true}).click();await page.getByRole('button',{name:'删除任务',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'删除任务',exact:true});await expect(dialog).toContainText('关联检查：已通过');await dialog.getByLabel('删除原因',{exact:false}).fill('误创建的任务');await seed(demo);
 await dialog.getByRole('button',{name:'移入回收站',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('已变化');await expect(dialog.getByLabel('删除原因',{exact:false})).toHaveValue('误创建的任务');
 await expect(dialog.getByRole('button',{name:'移入回收站',exact:true})).toBeDisabled();await dialog.getByRole('button',{name:'重新检查',exact:true}).click();await expect(dialog.getByRole('button',{name:'移入回收站',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'移入回收站',exact:true}).click();await expect(dialog).toHaveCount(0);
});

test('a lost deletion response retries the original operation exactly once',async({page,demo})=>{
 const task=await seed(demo);await page.goto(`/projects/phase-one/tasks/${task.id}`);await page.getByLabel('任务更多操作',{exact:true}).click();await page.getByRole('button',{name:'删除任务',exact:true}).click();const dialog=page.getByRole('dialog',{name:'删除任务',exact:true});await expect(dialog).toContainText('关联检查：已通过');await dialog.getByLabel('删除原因',{exact:false}).fill('重复记录');
 await page.route(`**/tasks/${task.id}/delete`,async route=>{const r=route.request();await demo.inject({method:'POST',url:prefix+`/${task.id}/delete`,headers:r.headers(),payload:r.postData()!});await route.abort('failed');},{times:1});
 await dialog.getByRole('button',{name:'移入回收站',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByLabel('删除原因',{exact:false})).toHaveValue('重复记录');await dialog.getByRole('button',{name:'移入回收站',exact:true}).click();await expect(dialog).toHaveCount(0);
 const r=await demo.inject({url:prefix+`/deleted/${task.id}`,headers:{'x-demo-actor':'zhou'}});expect(r.json().data.history).toHaveLength(1);
});

test('owner has no delete entry and old task links display deleted status',async({page,demo})=>{
 const task=await seed(demo);await page.goto('/projects/phase-one/tasks');await page.getByLabel('任务体验身份').selectOption('chen');await page.locator('.task-name-cell button').filter({hasText:task.title}).click();await expect(page.locator('.task-drawer')).toContainText(task.title);await expect(page.getByLabel('任务更多操作',{exact:true})).toHaveCount(0);
 const w=(await demo.inject(prefix)).json().data,headers={'x-preview-token':w.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()};const p=(await demo.inject({method:'POST',url:prefix+`/${task.id}/delete-preview`,headers,payload:{}})).json().data;
 expect((await demo.inject({method:'POST',url:prefix+`/${task.id}/delete`,headers,payload:{previewToken:p.previewToken,reason:'重复任务'}})).statusCode).toBe(200);
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(page).toHaveURL(/\/tasks$/);await page.goBack();await expect(page.getByRole('heading',{name:'任务已删除',exact:true})).toBeVisible();await page.getByRole('button',{name:'查看删除记录',exact:true}).click();await expect(page.getByRole('alert')).toContainText('无权查看');
});

test('opening recycle bin directly retains a valid task workspace on return',async({page})=>{
 await page.goto('/projects/phase-one/tasks/deleted');await expect(page.getByRole('heading',{name:'已删除任务',exact:true})).toBeVisible();await page.getByRole('button',{name:'返回任务管理',exact:true}).click();await expect(page.locator('.task-summary-line')).toBeVisible();await expect(page.locator('.task-table tbody tr')).toHaveCount(30);await expect(page.getByRole('alert')).toHaveCount(0);
});
