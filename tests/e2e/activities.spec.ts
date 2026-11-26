import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import type { ActivitySummary, ActivityItem, ActivityTarget } from '../../shared/src/activities';
import { buildLegacyApp } from '../helpers/legacy-app';
const target={kind:'task',id:'task-3',name:'完成成果',available:true};
const summary=(index:number):ActivitySummary=>({snapshotVersion:1,id:`a${index}`,type:'task_complete',category:'task',actor:{id:'zhou',name:'测试成员'},occurredAt:'2026-09-08T02:00:00Z',lastOccurredAt:'2026-09-08T02:08:00Z',count:index===0?25:1,preview:[`成果 ${index}`],historical:false,target,summary:index===0?'完成了 25 项任务':'完成了任务',itemsCursor:`detail-${index}`});
const detail=(index:number):ActivityItem=>({id:`i${index}`,target:{...target,name:`完成成果 ${index}`,available:index!==0},summary:'完成任务',occurredAt:'2026-09-08T02:00:00Z',historical:index===0,changes:[]});
const backfill={status:'complete',processedTasks:48,error:null};
interface Feed {version:number;fail:boolean;empty:boolean;requests:string[];targetOverride?:ActivityTarget}
const test=base.extend<{demo:FastifyInstance;feed:Feed}>({
 demo:async({},use)=>{const app=buildLegacyApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174'],dbPath:':memory:',clock:()=>new Date('2026-09-08T06:00:00Z'),jobIntervalMs:0});try{await use(app);}finally{await app.close();}},
 feed:async({},use)=>{await use({version:1,fail:false,empty:false,requests:[]});},
 page:async({page,demo,feed},use)=>{
  await page.route('**/api/v1/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.pathname.includes('/activities')){
    feed.requests.push(url.pathname+url.search);
    if(feed.fail){await route.fulfill({status:503,json:{error:{message:'项目动态暂时无法读取，请重试。'}}});return;}
    const details=url.pathname.endsWith('/items'),cursor=url.searchParams.get('cursor');
    const category=url.searchParams.get('category');
    const limit=Number(url.searchParams.get('limit')||20),offset=cursor==='next'?20:cursor==='next40'?40:cursor==='next60'?60:0;
    const items=feed.empty||(category&&category!=='all'&&category!=='task')?[]:details?Array.from({length:cursor==='details-next'?5:20},(_,i)=>detail(i+(cursor==='details-next'?20:0))):Array.from({length:Math.min(limit,65-offset)},(_,i)=>({...summary(i+offset),snapshotVersion:cursor?1:feed.version,...(feed.targetOverride?{target:feed.targetOverride}: {})}));
    await route.fulfill({json:{data:{items,nextCursor:details?(cursor==='details-next'?null:'details-next'):(!items.length||offset===60?null:offset===40?'next60':offset===20?'next40':'next'),activityVersion:feed.version,backfill}}});return;
   }
   const res=await demo.inject({method:req.method() as 'GET',url:url.pathname+url.search,headers:req.headers(),payload:req.postData()||undefined});
   if(url.pathname.endsWith('/revision')&&res.statusCode===200){const data=res.json();data.data.revision+=`-activity-${feed.version}`;await route.fulfill({status:200,json:data});return;}
   await route.fulfill({status:res.statusCode,contentType:'application/json',body:res.body});
  });
  await use(page);
 }
});
test.beforeEach(async({page})=>{await page.goto('/');await expect(page.getByRole('heading',{name:'项目总览',exact:true})).toBeVisible();});
test('homepage 2/5 and paginated 20-row drawer, aggregate snapshot, missing target, retry and filters',async({page,feed})=>{
 const panel=page.getByRole('region',{name:'项目动态'});
 await expect(panel.locator('.pa-row')).toHaveCount(2);
 await panel.getByRole('button',{name:'展开',exact:true}).click();await expect(panel.locator('.pa-row')).toHaveCount(5);
 await panel.getByRole('button',{name:'查看全部'}).click();
 const drawer=page.getByRole('dialog',{name:'项目动态',exact:true});await expect(drawer.locator('.pa-row')).toHaveCount(20);
 await drawer.getByRole('button',{name:'加载更多动态'}).click();await expect(drawer.locator('.pa-row')).toHaveCount(40);
 await drawer.locator('.pa-row').first().click();
 const detailDialog=page.getByRole('dialog',{name:'动态详情',exact:true});await expect(detailDialog.locator('.pa-detail-item')).toHaveCount(20);
 expect(feed.requests.some(url=>url.includes('/a0/items?')&&url.includes('cursor=detail-0'))).toBe(true);
 await expect(detailDialog.locator('.pa-detail-item').first()).toContainText('该对象已移除或当前无权访问');
 await detailDialog.getByRole('button',{name:'加载更多明细'}).click();await expect(detailDialog.locator('.pa-detail-item')).toHaveCount(25);
 await detailDialog.getByRole('button',{name:'返回动态列表'}).click();await expect(drawer.locator('.pa-row')).toHaveCount(40);
 await drawer.getByLabel('动态分类').selectOption('risk');await expect(drawer).toContainText('当前条件下暂无动态');
 feed.fail=true;await drawer.getByLabel('动态时间范围').selectOption('all');await expect(drawer.getByRole('alert')).toContainText('暂时无法读取');
 feed.fail=false;await drawer.getByRole('button',{name:'重试动态'}).click();await expect(drawer.getByRole('alert')).toHaveCount(0);
 await drawer.getByLabel('动态分类').selectOption('task');await expect(drawer.locator('.pa-row')).toHaveCount(20);
 await drawer.getByRole('button',{name:'关闭项目动态'}).click();await expect(panel.getByRole('button',{name:'查看全部'})).toBeFocused();
});
test('existing revision check prompts without resetting reading state',async({page,feed})=>{
 await page.getByRole('region',{name:'项目动态'}).getByRole('button',{name:'查看全部'}).click();
 const drawer=page.getByRole('dialog',{name:'项目动态',exact:true});
 await drawer.getByLabel('动态时间范围').selectOption('all');await expect(drawer.locator('.pa-row')).toHaveCount(20);
 await drawer.locator('.td-body').evaluate(el=>{el.scrollTop=300;});
 feed.version=2;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(drawer).toContainText('有新动态');await expect(drawer.locator('.pa-row')).toHaveCount(20);
 const scroll=await drawer.locator('.td-body').evaluate(el=>el.scrollTop);
 await drawer.getByRole('button',{name:'刷新动态'}).click();await expect(drawer.locator('.pa-update')).toHaveCount(0);
 await expect(drawer.getByLabel('动态时间范围')).toHaveValue('all');
 expect(await drawer.locator('.td-body').evaluate(el=>el.scrollTop)).toBeGreaterThanOrEqual(Math.min(scroll,100));
});

test('loading an old snapshot page does not acknowledge newer activities',async({page,feed})=>{
 await page.getByRole('region',{name:'项目动态'}).getByRole('button',{name:'查看全部'}).click();
 const drawer=page.getByRole('dialog',{name:'项目动态',exact:true});await expect(drawer.locator('.pa-row')).toHaveCount(20);
 feed.version=2;
 await drawer.getByRole('button',{name:'加载更多动态'}).click();await expect(drawer.locator('.pa-row')).toHaveCount(40);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(drawer).toContainText('有新动态');
});


test('refresh retains loaded page depth and the visible record anchor',async({page,feed})=>{
 await page.getByRole('region',{name:'项目动态'}).getByRole('button',{name:'查看全部'}).click();
 const drawer=page.getByRole('dialog',{name:'项目动态',exact:true});await expect(drawer.locator('.pa-row')).toHaveCount(20);
 await drawer.getByRole('button',{name:'加载更多动态'}).click();await expect(drawer.locator('.pa-row')).toHaveCount(40);
 await drawer.locator('.td-body').evaluate(el=>{const row=el.querySelector('[data-activity-id="a30"]')!;el.scrollTop+=row.getBoundingClientRect().top-el.getBoundingClientRect().top;});
 const anchor=drawer.locator('[data-activity-id="a30"]');const before=(await anchor.boundingBox())!.y;
 feed.version=2;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(drawer).toContainText('有新动态');
 await drawer.getByRole('button',{name:'刷新动态'}).click();await expect(drawer.locator('.pa-update')).toHaveCount(0);
 await expect(drawer.locator('.pa-row')).toHaveCount(40);expect(Math.abs((await anchor.boundingBox())!.y-before)).toBeLessThan(2);
});


test('opening an old homepage summary after polling immediately shows new activity',async({page,feed})=>{
 const panel=page.getByRole('region',{name:'项目动态'});await expect(panel.locator('.pa-row')).toHaveCount(2);
 feed.version=2;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(panel).toContainText('有新动态');
 await panel.locator('.pa-row').first().click();
 const drawer=page.getByRole('dialog',{name:'动态详情',exact:true});await expect(drawer.locator('.pa-detail-item')).toHaveCount(20);await expect(drawer).toContainText('有新动态');
});

for(const width of [1440,390,320])test(`activity drawer accessible at ${width}px`,async({page,feed},testInfo)=>{
 await page.setViewportSize({width,height:width===1440?900:844});
 const panel=page.getByRole('region',{name:'项目动态'});await expect(panel.locator('.pa-row')).toHaveCount(2);
 await panel.getByRole('button',{name:'查看全部'}).click();
 const drawer=page.getByRole('dialog',{name:'项目动态',exact:true});await expect(drawer.locator('.pa-row')).toHaveCount(20);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await drawer.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath(`activities-${width}.png`)});
 await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);
 feed.empty=true;await panel.getByRole('button',{name:'查看全部'}).click();await expect(page.getByRole('dialog')).toContainText('当前条件下暂无动态');
});

for (const kind of ['baseline','plan_history'] as const) test(`activity ${kind} navigation opens its record after a milestone visit`,async({page,demo,feed})=>{
 let plan=(await demo.inject('/api/v1/projects/phase-one/gantt')).json().data;
 if(kind==='plan_history') {
  const headers={'x-preview-token':plan.writeToken,'x-demo-actor':'zhou'};
  const preview=await demo.inject({method:'POST',url:'/api/v1/projects/phase-one/schedule/preview',headers,payload:{expectedPlanVersion:plan.planVersion,changes:[{taskId:'task-006',start:'2026-10-01',end:'2026-10-05'}],mode:'push_successors'}});
  expect(preview.statusCode,preview.body).toBe(200);
  const applied=await demo.inject({method:'POST',url:'/api/v1/projects/phase-one/schedule/apply',headers:{...headers,'idempotency-key':'activity-history-navigation'},payload:{previewId:preview.json().data.id,expectedPlanVersion:plan.planVersion}});
  expect(applied.statusCode,applied.body).toBe(200);
  plan=(await demo.inject('/api/v1/projects/phase-one/gantt')).json().data;
 }
 const record=kind==='baseline'?plan.baselines[0]:plan.history[0];
 expect(record).toBeTruthy();
 feed.targetOverride={kind,id:record.id,name:kind==='baseline'?record.name:'既有计划变更',available:true};
 await page.goto('/projects/phase-one/plan');
 await page.getByRole('tab',{name:'里程碑',exact:true}).click();
 await expect(page.getByRole('heading',{name:'里程碑交付',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'项目总览',exact:true}).click();
 const panel=page.getByRole('region',{name:'项目动态'});await panel.locator('.pa-row').first().click();
 await page.getByRole('dialog',{name:'动态详情',exact:true}).getByRole('button',{name:'打开相关记录',exact:true}).click();
 await expect(page.getByRole('dialog',{name:kind==='baseline'?'与基线的偏差':'计划变更记录',exact:true})).toBeVisible();
 await expect(page.getByRole('tab',{name:'甘特图',exact:true})).toHaveAttribute('aria-selected','true');
 if(kind==='plan_history')await expect(page.locator(`[data-history-id="${record.id}"]`)).toBeVisible();
});
