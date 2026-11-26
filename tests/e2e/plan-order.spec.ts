import { test as base, expect, type Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import type { ProjectPlan } from '../../shared/src/planning';

const prefix = '/api/v1/projects/phase-one';
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildLegacyApp({ allowedOrigins: [process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174'], dbPath: ':memory:', jobIntervalMs: 0 }); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const result = await demo.inject({ method: request.method() as 'GET'|'POST', url: url.pathname + url.search, headers: request.headers(), payload: request.postData() || undefined });
      await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
    });
    await use(page);
  },
});
const data = async (app: FastifyInstance): Promise<ProjectPlan> => (await app.inject(`${prefix}/gantt`)).json().data;
async function enter(page: Page) {
  await page.goto('/projects/phase-one/plan');
  await expect(page.getByRole('heading', { name: '完整计划', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '调整顺序', exact: true }).click();
  await page.getByRole('button', { name: '展开全部', exact: true }).click();
}
const row = (page: Page, id: string) => page.locator(`.gantt-row[data-node-id="${id}"]`);
const select = async (page: Page, id: string) => { await row(page,id).locator('.gantt-name-button').click(); };
const firstGroup = (plan: ProjectPlan) => plan.siblingOrders.find(group => group.parentId === 'group-system-bottom')!;

test('stages multiple moves, cancels safely and persists order independently from schedule and CSV', async ({ page, demo }) => {
  const before = await data(demo), group = firstGroup(before), [first,second,third] = group.nodeIds;
  await enter(page); await select(page,third!);
  await page.getByRole('button', { name:'上移', exact:true }).click();
  await page.getByRole('button', { name:'上移', exact:true }).click();
  expect((await data(demo)).siblingOrders).toEqual(before.siblingOrders);
  await expect(page.locator('.gantt-row').nth(1)).toHaveAttribute('data-node-id',third!);
  await page.getByRole('button', { name:'取消', exact:true }).click();
  await page.getByRole('button', { name:'继续编辑', exact:true }).click();
  await page.getByRole('button', { name:'保存顺序', exact:true }).click();
  await expect(page.getByRole('button',{name:'调整顺序',exact:true})).toBeVisible();
  const after = await data(demo);
  expect(firstGroup(after).nodeIds.slice(0,3)).toEqual([third,first,second]);
  expect(after.nodes).toEqual(before.nodes); expect(after.planVersion).toBe(before.planVersion); expect(after.baselines).toEqual(before.baselines);
  await page.reload(); await page.getByRole('button',{name:'展开全部',exact:true}).click();
  await expect(page.locator('.gantt-row').nth(1)).toHaveAttribute('data-node-id',third!);
  const downloadEvent=page.waitForEvent('download'); await page.getByRole('button',{name:'导出计划',exact:true}).click();
  const csv=await readFile((await (await downloadEvent).path())!,'utf8');
  const thirdTitle=after.nodes.find(n=>n.id===third)!.title,firstTitle=after.nodes.find(n=>n.id===first)!.title;
  expect(csv.indexOf(thirdTitle)).toBeLessThan(csv.indexOf(firstTitle));
  await page.getByRole('button',{name:'变更记录',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('调整任务顺序');
  await page.getByText('查看顺序变更',{exact:true}).click(); await expect(page.getByRole('dialog')).toContainText('调整前');
});

test('position dialog searches complete siblings; cancel restores filters and order', async ({page,demo}) => {
  const before=await data(demo), group=firstGroup(before), target=before.nodes.find(n=>n.id===group.nodeIds[0])!, moving=before.nodes.find(n=>n.id===group.nodeIds[2])!;
  await page.goto('/projects/phase-one/plan');
  await page.getByRole('textbox',{name:'搜索计划任务'}).fill(moving.title);
  await page.getByRole('button',{name:'调整顺序',exact:true}).click();
  await page.getByRole('button',{name:'清除筛选并进入',exact:true}).click();
  await select(page,moving.id);
  await page.getByRole('button',{name:'移动到...',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'移动到指定位置'});
  await dialog.getByRole('searchbox').fill(target.title);
  await dialog.getByRole('radio',{name:new RegExp(target.title)}).check();
  await dialog.getByRole('button',{name:'应用到预览',exact:true}).click();
  await expect(page.locator('.gantt-row').nth(1)).toHaveAttribute('data-node-id',moving.id);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'放弃调整',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'搜索计划任务'})).toHaveValue(moving.title);
  expect((await data(demo)).siblingOrders).toEqual(before.siblingOrders);
});

test('conflict retains draft, compares latest and restarts explicitly', async ({page,demo}) => {
  const before=await data(demo), group=firstGroup(before);
  await enter(page); await select(page,group.nodeIds[1]!); await page.getByRole('button',{name:'上移',exact:true}).click();
  const response=await demo.inject({method:'POST',url:`${prefix}/plan/order`,headers:{'x-preview-token':before.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{expectedOrderVersion:before.orderVersion,orders:[{...group,nodeIds:[...group.nodeIds].reverse()}]}});
  expect(response.statusCode,response.body).toBe(200);
  await page.getByRole('button',{name:'保存顺序',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(page.getByRole('button',{name:'保存顺序',exact:true})).toBeDisabled();
  await expect(page.locator('.gantt-row').nth(1)).toHaveAttribute('data-node-id',group.nodeIds[1]!);
  await page.getByRole('button',{name:'查看最新顺序并对照',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'核对任务顺序'})).toContainText('我的未保存草稿');
  await page.getByRole('button',{name:'以最新顺序重新整理',exact:true}).click();
  await expect(page.getByText('查看重新整理前的草稿（只读参考）',{exact:true})).toBeVisible();
  await expect(page.locator('.gantt-row').nth(1)).toHaveAttribute('data-node-id',group.nodeIds.at(-1)!);
});

test('lost response retries with same receipt without duplicating history',async({page,demo})=>{
  const before=await data(demo),group=firstGroup(before); let first=true;const keys:string[]=[];
  await page.route('**/plan/order',async route=>{
    const req=route.request();keys.push(req.headers()['idempotency-key']!);
    const r=await demo.inject({method:'POST',url:`${prefix}/plan/order`,headers:req.headers(),payload:req.postData()!});
    if(first){first=false;await route.abort('failed');}else await route.fulfill({status:r.statusCode,contentType:'application/json',body:r.body});
  });
  await enter(page);await select(page,group.nodeIds[1]!);await page.getByRole('button',{name:'上移',exact:true}).click();await page.getByRole('button',{name:'保存顺序',exact:true}).click();
  await page.getByRole('button',{name:'重试保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'调整顺序',exact:true})).toBeVisible();
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect((await data(demo)).history.filter(h=>h.action==='调整任务顺序')).toHaveLength(1);
});

test('dedicated drag moves vertically and Escape cancels only current gesture',async({page,demo})=>{
  const before=await data(demo),group=firstGroup(before);await enter(page);
  const moving=row(page,group.nodeIds[2]!).locator('.gantt-order-handle'), target=row(page,group.nodeIds[0]!);
  await moving.scrollIntoViewIfNeeded();
  let box=(await moving.boundingBox())!, dest=(await target.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,dest.y+8,{steps:8});
  await expect(page.locator('.gantt-order-line')).toBeVisible();await page.keyboard.press('Escape');await page.mouse.up();
  await expect(page.getByRole('button',{name:'保存顺序',exact:true})).toBeDisabled();
  box=(await moving.boundingBox())!;dest=(await target.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,dest.y+8,{steps:8});await page.mouse.up();
  await expect(page.locator('.gantt-row').nth(1)).toHaveAttribute('data-node-id',group.nodeIds[2]!);
  expect((await data(demo)).siblingOrders).toEqual(before.siblingOrders);
});

for(const width of [1440,390,320])test(`order UI and position dialog fit ${width}px`,async({page,demo},info)=>{
  await page.setViewportSize({width,height:900});const p=await data(demo),group=firstGroup(p);
  await enter(page);
  if(width<768)await page.locator(`[data-order-id="${group.nodeIds[1]}"] .plan-mobile-task`).click();else await select(page,group.nodeIds[1]!);
  await page.getByRole('button',{name:'上移',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存顺序',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width<768){const controls=await page.locator('.plan-order-controls').boundingBox(),list=await page.locator('.plan-mobile-list').boundingBox();expect(controls!.y+controls!.height).toBeLessThanOrEqual(list!.y+1);}
  await page.screenshot({path:info.outputPath(`order-${width}.png`),animations:'disabled'});
  await page.getByRole('button',{name:'移动到...',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'移动到指定位置'})).toBeVisible();
  expect(await page.evaluate(()=>{const d=document.querySelector('dialog[open]')!;return d.scrollWidth<=d.clientWidth;})).toBe(true);
  await page.screenshot({path:info.outputPath(`order-position-${width}.png`),animations:'disabled'});
});

test('desktop controls stay above internally scrolling rows; keyboard and navigation preserve a dirty draft',async({page,demo})=>{
  await page.setViewportSize({width:1440,height:900});const p=await data(demo),group=firstGroup(p);await enter(page);
  const name=row(page,group.nodeIds[1]!).locator('.gantt-name-button');await name.focus();await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'上移',exact:true}).focus();await page.keyboard.press('Enter');
  const before=await page.locator('.plan-order-controls').boundingBox();
  await page.locator('.gantt-viewport').evaluate(el=>{el.scrollTop=480;el.dispatchEvent(new Event('scroll'));});
  const toolbar=await page.locator('.plan-order-controls').boundingBox(),header=await page.locator('.topbar').boundingBox();
  expect(toolbar!.y).toBeGreaterThanOrEqual(header!.y+header!.height-1);expect(toolbar!.y).toBe(before!.y);
  expect(toolbar!.y+toolbar!.height).toBeLessThanOrEqual((await page.locator('.gantt-viewport').boundingBox())!.y+1);
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'任务管理',exact:true}).click();
  await expect(page).toHaveURL(/\/plan$/);await expect(page.getByRole('button',{name:'保存顺序',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'任务管理',exact:true}).click();
  await expect(page).toHaveURL(/\/tasks$/);expect((await data(demo)).siblingOrders).toEqual(p.siblingOrders);
});

test('task list and board expose plan order with server paging',async({page,demo})=>{
  const p=await data(demo),group=firstGroup(p),ids=[...group.nodeIds].reverse();
  const saved=await demo.inject({method:'POST',url:`${prefix}/plan/order`,headers:{'x-preview-token':p.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{expectedOrderVersion:p.orderVersion,orders:[{...group,nodeIds:ids}]}});expect(saved.statusCode).toBe(200);
  await page.goto('/projects/phase-one/tasks');await expect(page.getByRole('combobox',{name:'任务排序'})).toHaveValue('due');
  const response=page.waitForResponse(r=>r.url().includes('/tasks/query?')&&r.url().includes('sort=plan'));
  await page.getByRole('combobox',{name:'任务排序'}).selectOption('plan');
  const body=await (await response).json();expect(body.data.tasks.length).toBeGreaterThan(0);
  const firstInGroup=body.data.tasks.filter((t:{workstreamId:string})=>t.workstreamId==='system-bottom').map((t:{id:string})=>t.id);
  expect(firstInGroup).toEqual(ids.filter(id=>firstInGroup.includes(id)));
  await page.getByRole('button',{name:'看板',exact:true}).click();await expect(page.getByRole('combobox',{name:'任务排序'})).toHaveValue('plan');
});

test('5000-row canvas stays virtual and target search reaches offscreen siblings',async({page,demo})=>{
  const p=await data(demo),root=p.nodes.find(n=>n.id==='group-system-bottom')!,template=p.nodes.find(n=>n.id===firstGroup(p).nodeIds[0])!;
  const tasks=Array.from({length:5000},(_,i)=>({...template,id:`order-large-${i}`,wbs:`1.T${i+1}`,title:`长计划任务 ${i+1}`,parentId:root.id}));
  const large={...p,nodes:[root,...tasks],dependencies:[],baselines:[],issues:[],criticalIds:[],siblingOrders:[{parentId:root.id,nodeIds:tasks.map(t=>t.id)}]};
  await page.route('**/gantt',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:large})}));
  await enter(page);expect(await page.locator('.gantt-row').count()).toBeLessThan(50);
  await select(page,tasks[0]!.id);await page.getByRole('button',{name:'移动到...',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'移动到指定位置'});await dialog.getByRole('searchbox').fill('长计划任务 5000');
  await dialog.getByRole('radio',{name:/长计划任务 5000/}).check();await dialog.getByRole('radio',{name:'目标之后',exact:true}).check();
  await dialog.getByRole('button',{name:'应用到预览',exact:true}).click();
  await expect(row(page,tasks[0]!.id)).toHaveAttribute('data-row-index','5000');expect(await page.locator('.gantt-row').count()).toBeLessThan(50);
  await expect(page.getByRole('button',{name:'保存顺序',exact:true})).toBeEnabled();
});

test('summary moves with its subtree and children reorder only within that summary',async({page,demo})=>{
  async function create(title:string,extra:Record<string,unknown>={}){
    const p=await data(demo);const r=await demo.inject({method:'POST',url:`${prefix}/tasks`,headers:{'x-preview-token':p.writeToken,'x-demo-actor':'zhou','idempotency-key':crypto.randomUUID()},payload:{expectedPlanVersion:p.planVersion,title,description:'',workstreamId:'system-bottom',parentId:null,ownerId:'zhou',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:null,end:null,...extra}});
    expect(r.statusCode,r.body).toBe(200);return r.json().data;
  }
  const original=await create('排序原执行任务');await create('排序同级任务');
  const converted=await create('排序新增子任务',{parentId:original.task.id,confirmParentConversion:true,expectedParentVersion:original.task.version});
  await enter(page);await select(page,converted.parentTask.id);await expect(page.locator('.order-selection')).toContainText('2 项子任务');
  await page.getByRole('button',{name:'上移',exact:true}).click();
  const displayed=await page.locator('.gantt-row').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-node-id')));
  const at=displayed.indexOf(converted.parentTask.id);expect(displayed.slice(at,at+3)).toEqual([converted.parentTask.id,original.task.id,converted.task.id]);
  await select(page,converted.task.id);await page.getByRole('button',{name:'上移',exact:true}).click();
  await page.getByRole('button',{name:'保存顺序',exact:true}).click();await expect(page.getByRole('button',{name:'调整顺序',exact:true})).toBeVisible();
  const saved=await data(demo);expect(saved.siblingOrders.find(g=>g.parentId===converted.parentTask.id)!.nodeIds).toEqual([converted.task.id,original.task.id]);
  expect(saved.nodes.find(n=>n.id===original.task.id)!.parentId).toBe(converted.parentTask.id);
});
