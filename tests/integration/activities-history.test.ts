import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildLegacyApp } from '../helpers/legacy-app';
import { buildApp } from '../../server/src/app';
it('opens the exact older history record outside the recent 100 without cross-project fallback',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'goodwork-activity-history-')),dbPath=join(directory,'test.sqlite');
 const app=buildLegacyApp({dbPath,jobIntervalMs:0});
 try{
  await app.ready();const db=new Database(dbPath);
  try{db.transaction(()=>{for(let i=0;i<105;i++){const item={id:`activity-history-${i}`,createdAt:new Date(Date.parse('2026-09-08T00:00:00Z')+i*1000).toISOString(),action:'schedule_apply',actor:'虚构操作者',reason:'测试排期调整',affectedCount:1};db.prepare('INSERT INTO plan_history VALUES(?,?,?,?)').run(item.id,'phase-one',JSON.stringify(item),item.createdAt);}})();}finally{db.close();}
  const plan=(await app.inject('/api/v1/projects/phase-one/gantt')).json().data;
  expect(plan.history.some((h:{id:string})=>h.id==='activity-history-0')).toBe(false);
  const found=await app.inject('/api/v1/projects/phase-one/plan/history/activity-history-0');expect(found.statusCode).toBe(200);expect(found.json().data.id).toBe('activity-history-0');
  expect((await app.inject('/api/v1/projects/other/plan/history/activity-history-0')).statusCode).toBe(404);
  expect((await app.inject('/api/v1/projects/phase-one/plan/history/missing')).statusCode).toBe(404);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
 const authenticated=buildApp({dbPath:':memory:',jobIntervalMs:0});try{expect((await authenticated.inject('/api/v1/projects/phase-one/plan/history/activity-history-0')).statusCode).toBe(401);}finally{await authenticated.close();}
});
