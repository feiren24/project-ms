import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/store.js';

// No dev server, real data, external API or DNS is used: all requests are served
// from the compiled frontend and an isolated existing-only Fastify database.
for (const width of [1440,390,320]) test(`compiled HTTP login and authenticated write at ${width}px`, async ({page}) => {
  const dir=mkdtempSync(join(tmpdir(),'goodwork-http-')),dbPath=join(dir,'existing.sqlite');
  const seed=buildApp({dbPath,jobIntervalMs:0});await seed.ready();await seed.close();
  const db=new Database(dbPath);await createInitialAdmin(db,{username:'linux-admin',name:'安装测试管理员',password:'Linux-http-test-2026'});db.close();
  const origin='http://goodwork-http.test:3100';
  const app=buildApp({dbPath,databaseMode:'existing-only',jobIntervalMs:0,webRoot:resolve('client/dist'),secureCookies:false,allowedOrigins:[origin]});
  try {
    await app.ready();await page.setViewportSize({width,height:844});
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{ (window as unknown as {nativeUUID:string}).nativeUUID=typeof crypto.randomUUID; });
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      const res=await app.inject({method:req.method() as 'GET'|'POST'|'PATCH',url:url.pathname+url.search,headers:await req.allHeaders(),payload:req.postData()||undefined});
      const headers=Object.fromEntries(Object.entries(res.headers).filter(([name])=>!['content-length','transfer-encoding','connection'].includes(name)).map(([name,value])=>[name,Array.isArray(value)?value.join('\n'):String(value)]));
      await route.fulfill({status:res.statusCode,headers,body:res.rawPayload});
    });
    await page.goto(origin+'/login');
    await expect(page.getByRole('heading',{name:'欢迎回来',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>({secure:isSecureContext,native:(window as unknown as {nativeUUID:string}).nativeUUID,uuid:crypto.randomUUID()}))).toMatchObject({secure:false,native:'undefined',uuid:expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)});
    await page.getByLabel('登录账号',{exact:true}).fill('linux-admin');await page.getByLabel('密码',{exact:true}).fill('Linux-http-test-2026');await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.locator('.auth-page:visible')).toHaveCount(0);
    const created=await page.evaluate(async()=>{
      const session=await (await fetch('/api/v1/auth/session')).json();
      const response=await fetch('/api/v1/projects',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.data.csrfToken,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:'HTTP 验收项目',goal:'验证已有库正常业务写入',start:'2026-10-01',end:'2026-12-31'})});
      return {status:response.status,body:await response.json()};
    });
    expect(created.status,JSON.stringify(created.body)).toBe(200);
    await page.goto(origin+`/projects/${created.body.data.id}/tasks`);
    await expect(page.getByRole('heading',{name:'任务管理',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await page.unrouteAll({behavior:'wait'});await page.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
