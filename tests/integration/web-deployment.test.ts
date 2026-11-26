import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../server/src/app.js';
import { runtimeConfig } from '../../server/src/config.js';

it('serves compiled SPA pages and assets without exposing private files or masking APIs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'goodwork-web-'));mkdirSync(join(dir,'public/assets'),{recursive:true});
  writeFileSync(join(dir,'private.sqlite'),'private');writeFileSync(join(dir,'public/index.html'),'<div id="app">SPA</div>');writeFileSync(join(dir,'public/assets/app.js'),'window.loaded=true');
  const app=buildApp({dbPath:':memory:',jobIntervalMs:0,webRoot:join(dir,'public')});
  try {
    for(const path of ['/','/login','/projects/phase-one/tasks/task-011','/admin/settings']){const res=await app.inject(path);expect(res.statusCode).toBe(200);expect(res.body).toContain('SPA');expect(res.headers['cache-control']).toBe('no-store');}
    expect((await app.inject('/assets/app.js')).body).toBe('window.loaded=true');
    for(const path of ['/assets/missing.js','/data/homepage-demo.sqlite','/.env.linux','/server/src/main.ts','/../private.sqlite','/%2e%2e/private.sqlite']){const res=await app.inject(path);expect([403,404]).toContain(res.statusCode);expect(res.body).not.toContain('SPA');expect(res.body).not.toBe('private');}
    const api=await app.inject('/api/v1/not-present');expect(api.statusCode).not.toBe(200);expect(api.headers['content-type']).toContain('application/json');
  } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
it('requires an existing database for public deployment and preserves development defaults',()=>{
  const dev=runtimeConfig({});expect(dev.host).toBe('127.0.0.1');expect(dev.port).toBe(3100);expect(dev.databaseMode).toBe('initialize');
  const env={SERVE_WEB:'true',DATABASE_MODE:'existing-only',PUBLIC_BASE_URL:'http://203.0.113.10:3100',NODE_ENV:'production',HOST:'0.0.0.0'};
  expect(runtimeConfig(env)).toMatchObject({host:'0.0.0.0',secureCookies:false,allowedOrigins:['http://203.0.113.10:3100']});
  expect(()=>runtimeConfig({...env,DATABASE_MODE:'initialize'})).toThrow(/禁止初始化/);
  expect(()=>runtimeConfig({...env,PORT:'NaN'})).toThrow(/PORT/);
  expect(()=>runtimeConfig({...env,PUBLIC_BASE_URL:'http://0.0.0.0:3100'})).toThrow(/PUBLIC_BASE_URL/);
});
