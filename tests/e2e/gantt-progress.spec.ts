import { test as base, expect } from '@playwright/test';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { FastifyInstance } from 'fastify';
import type { ProjectPlan } from '../../shared/src/planning';
const prefix = '/api/v1/projects/phase-one';
// Each browser flow talks to its own in-memory SQLite database. The review demo stays unchanged.
const test = base.extend<{ demo: FastifyInstance }>({
  demo: async ({}, use) => { const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: ':memory:' }); await use(app); await app.close(); },
  page: async ({ page, demo }, use) => {
    await page.route('**/api/v1/**', async route => {
      const req = route.request();
      const response = await demo.inject({ method: req.method() as 'GET'|'POST', url: new URL(req.url()).pathname + new URL(req.url()).search, headers: req.headers(), payload: req.postData() || undefined });
      let body = response.body;
      if (new URL(req.url()).pathname === `${prefix}/gantt` && response.statusCode === 200) {
        const envelope = response.json(); const plan = envelope.data as ProjectPlan;
        // Rendering-only matrix: no writes to the fixture DB or the user's project.
        const colors = ['blue', 'cyan', 'purple', 'green', 'orange', 'slate'];
        const values = [0, 35, 60, 100, 35, 60];
        let group = 0, task = 0;
        for (const node of plan.nodes) {
          if (node.kind === 'group') { node.color = colors[group]!; node.progress = values[group++]!; node.status = node.progress === 0 ? 'todo' : node.progress === 100 ? 'done' : 'in_progress'; }
          if (node.kind === 'task') {
            node.color = colors[task % 6]!; node.progress = values[task % 6]!;
            node.status = node.progress === 0 ? 'todo' : node.progress === 100 ? 'done' : 'in_progress';
            if (task === 3) { node.status = 'review'; node.title = '完成进度100但仍等待独立验收的任务'; }
            if (task === 1) { node.title = '用于验证名称截断和跨深浅背景文字对比的超长任务标题'; node.end = node.start; }
            task++;
          }
        }
        body = JSON.stringify(envelope);
      }
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body });
    });
    await use(page);
  },
});

for (const width of [1440,390,320]) test(`progress colors, boundaries and captions fit ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:width===1440?900:844});
  await page.goto('/projects/phase-one/plan');
  await expect(page.locator('.plan-version')).toHaveText('执行计划 V1');
  if(width<768) await page.getByRole('button',{name:'甘特时间轴',exact:true}).click();
  await expect(page.locator('.gantt-viewport')).toBeVisible();
  const groups=page.locator('.gantt-row.is-group');
  await expect(groups).toHaveCount(6);
  await page.getByRole('button',{name:'图例',exact:true}).click();
  await expect(page.locator('.gantt-legend')).toContainText('已完成进度');
  await expect(page.locator('.gantt-legend')).toContainText('剩余进度');
  await page.getByRole('button',{name:'返回计划',exact:true}).click();
  const colors:string[]=[];
  for(let i=0;i<6;i++){
    const row=groups.nth(i),bar=row.locator('.gantt-bar');
    const percent=[0,35,60,100,35,60][i]!;
    await expect(row.locator('.gantt-progress-label')).toHaveText(`${percent}%`);
    await expect(bar.locator('.gantt-progress-divider')).toHaveCount(percent>0&&percent<100?1:0);
    const result=await bar.evaluate(element=>{
      const el=element as HTMLElement,fill=el.querySelector<HTMLElement>('.gantt-progress')!;
      const base=getComputedStyle(el),filled=getComputedStyle(fill);
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d')!;
      const rgba=(color:string)=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const luminance=(v:number[])=>v.slice(0,3).map(c=>{const x=c/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i]!,0);
      const rgb=rgba(filled.backgroundColor),a=luminance(rgb),b=luminance(rgba(base.backgroundColor));
      return {percent:fill.getBoundingClientRect().width/el.clientWidth*100,color:filled.backgroundColor,alpha:rgb[3],contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),whiteContrast:1.05/(a+.05),pattern:base.backgroundImage};
    });
    expect(result.percent).toBeCloseTo(percent,0);expect(result.alpha).toBe(255);
    expect(result.contrast).toBeGreaterThanOrEqual(3);expect(result.whiteContrast).toBeGreaterThanOrEqual(4.5);
    expect(result.pattern).toContain('repeating-linear-gradient');colors.push(result.color);
  }
  expect(new Set(colors).size).toBe(6);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`summary-${width}.png`),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'展开全部',exact:true}).click();
  const reviewRow=page.locator('.gantt-row').filter({hasText:'完成进度100但仍等待独立验收的任务'});
  await expect(reviewRow.locator('.gantt-progress-label')).toHaveText('100%');
  await expect(reviewRow.locator('.gantt-status')).toHaveText('待验收');
  await expect(reviewRow.locator('.gantt-bar')).not.toHaveClass(/is-done/);
  await expect(reviewRow.locator('.gantt-progress-divider')).toHaveCount(0);
  const task=page.locator('.gantt-row').filter({hasText:'用于验证名称截断和跨深浅背景文字对比的超长任务标题'});
  await expect(task.locator('.gantt-progress-label')).toHaveText('35%');
  await expect(task.locator('.gantt-name-button')).toHaveAttribute('title',/超长任务标题/);
  await expect(task.locator('.gantt-bar-caption-completed')).toHaveCSS('clip-path','inset(0px 65% 0px 0px)');
  if(width<768) await page.getByRole('button',{name:'缩放',exact:true}).click();
  for(const name of ['日','周','月']) await page.getByRole('button',{name,exact:true}).click();
  await page.getByRole('button',{name:'全项目',exact:true}).click();
  if(width<768) await page.getByRole('button',{name:'返回计划',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`tasks-${width}.png`),fullPage:true,animations:'disabled'});
});
