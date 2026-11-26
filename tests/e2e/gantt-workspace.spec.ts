import { writeFile } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { FastifyInstance } from 'fastify';
// Each browser flow talks to its own in-memory SQLite database. The review demo stays unchanged.
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: ':memory:' }); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const req = route.request();
      const response = await demo.inject({ method: req.method() as 'GET'|'POST', url: new URL(req.url()).pathname+new URL(req.url()).search, headers: req.headers(), payload: req.postData() || undefined });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await use(page);
  },
});

for (const [width,height] of [[1440,900],[1920,1080],[1366,768],[390,844],[320,844],[960,540]]) {
  test(`workspace uses available height and restores checks at ${width}x${height}`, async ({page}, testInfo) => {
    await page.setViewportSize({width:width!,height:height!});
    await page.goto('/projects/phase-one/plan');
    await expect(page.locator('.plan-version')).toHaveText('执行计划 V1');
    if(width!<768) await page.getByRole('button',{name:'甘特时间轴',exact:true}).click();
    const viewport=page.locator('.gantt-viewport');
    await expect(viewport).toBeVisible();
    const collapsed=(await viewport.boundingBox())!;
    if(width===1440){expect(collapsed.height).toBeGreaterThanOrEqual(600);expect(collapsed.height).toBeLessThanOrEqual(640);await expect(page.locator('.sidebar')).toBeVisible();}
    expect(collapsed.height).toBeGreaterThanOrEqual(240);
    await page.getByRole('button',{name:'展开全部',exact:true}).click();
    await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(collapsed.height);
    const metrics=await viewport.evaluate(el=>{const v=el.getBoundingClientRect();return {height:v.height,fullRows:[...el.querySelectorAll('.gantt-row')].filter(row=>{const r=row.getBoundingClientRect();return r.top>=v.top+64&&r.bottom<=v.bottom;}).length,rendered:el.querySelectorAll('.gantt-row').length};});
    if(width===1440)expect(metrics.fullRows).toBeGreaterThanOrEqual(12);
    expect(metrics.rendered).toBeLessThan(50);
    await writeFile(testInfo.outputPath('metrics.json'),JSON.stringify({viewport:{width,height},canvas:metrics},null,2));
    await testInfo.attach('canvas-metrics',{path:testInfo.outputPath('metrics.json'),contentType:'application/json'});
    await page.screenshot({path:testInfo.outputPath('workspace.png'),fullPage:true});
    await page.locator('.plan-check-trigger').click();
    if(width!>=768&&height!>=768){
      await expect(page.locator('.plan-check-panel')).toBeVisible();
      expect((await viewport.boundingBox())!.height).toBeLessThan(collapsed.height);
      const panel=(await page.locator('.plan-check-panel').boundingBox())!, board=(await page.locator('.plan-board').boundingBox())!;
      expect(panel.height).toBeLessThanOrEqual(board.height/3);
    } else await expect(page.getByRole('dialog',{name:'计划完整性检查'})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('checks-open.png'),fullPage:true});
    await page.getByRole('button',{name:'关闭计划完整性检查',exact:true}).click();
    await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(collapsed.height);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(height!>=768){const footer=(await page.locator('.plan-board-footer').boundingBox())!;expect(footer.y+footer.height).toBeLessThanOrEqual(height!);}
  });
}

test('mobile filters, baseline and export remain accessible; list choice survives navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/projects/phase-one/plan');
  await expect(page.locator('.plan-mobile-list')).toBeVisible();
  await page.getByRole('button',{name:'筛选',exact:true}).click();
  await page.getByLabel('筛选工作分组').selectOption('system-bottom');
  await page.getByLabel('对比基线',{exact:true}).selectOption('');
  await expect(page.getByRole('dialog',{name:'筛选计划'})).toBeVisible();
  await page.getByRole('button',{name:'完成筛选',exact:true}).click();
  await expect(page.getByRole('button',{name:'筛选 1',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'更多',exact:true}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出计划',exact:true}).click();expect((await download).suggestedFilename()).toContain('DEMO.csv');
  await page.getByRole('button',{name:'甘特时间轴',exact:true}).click();
  await page.getByRole('tab',{name:'里程碑',exact:true}).click();
  await page.getByRole('tab',{name:'甘特图',exact:true}).click();
  await expect(page.locator('.gantt-viewport')).toBeVisible();
  await expect(page.getByRole('button',{name:'筛选 1',exact:true})).toBeVisible();
});

test('browser resizing and shell banner resize the canvas without collapsing rows',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await page.goto('/projects/phase-one/plan');
  await page.getByRole('button',{name:'展开全部',exact:true}).click();
  const viewport=page.locator('.gantt-viewport'),initial=(await viewport.boundingBox())!.height;
  await page.setViewportSize({width:1440,height:1080});
  await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(initial+180);
  await page.evaluate(()=>{const p=document.querySelector('.plan-page')!, banner=document.createElement('div');banner.className='collaboration-banner';banner.style.height='48px';banner.textContent='协作更新提示';p.before(banner);});
  await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(initial+132);
  await page.evaluate(()=>document.querySelector('.collaboration-banner')?.remove());
  await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(initial+180);
});


test('sidebar, full screen and internal scrolling preserve the workspace geometry',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await page.goto('/projects/phase-one/plan');
  await page.getByRole('button',{name:'展开全部',exact:true}).click();
  const viewport=page.locator('.gantt-viewport');const initial=(await viewport.boundingBox())!;
  await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
  await expect.poll(async()=>(await viewport.boundingBox())!.width).toBeCloseTo(initial.width+132,0);
  expect((await viewport.boundingBox())!.height).toBe(initial.height);
  await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
  await expect.poll(async()=>(await viewport.boundingBox())!.width).toBeCloseTo(initial.width,0);
  await page.getByRole('button',{name:'全屏查看计划',exact:true}).click();
  await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(initial.height+66);
  await page.getByRole('button',{name:'退出全屏计划',exact:true}).click();
  await expect.poll(async()=>(await viewport.boundingBox())!.height).toBe(initial.height);
  const before=(await page.locator('.gantt-axis').boundingBox())!;
  await viewport.evaluate(el=>{el.scrollTop=800;el.dispatchEvent(new Event('scroll'));});
  await expect.poll(async()=>(await page.locator('.gantt-axis').boundingBox())!.y).toBe(before.y);
  expect((await page.locator('.plan-board-footer').boundingBox())!.y).toBeGreaterThan(initial.y+initial.height-1);
});
