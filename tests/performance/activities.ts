/** Real HTTP + browser evidence for activity read/write load. Only creates temporary synthetic databases. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { createFixture, taskId, FIXTURE_NOW } from './seed.js';
import { startServer } from './controller.js';
import { fingerprint } from './fingerprint.js';
import { recordActivity } from '../../server/src/modules/activities/repository.js';
const out=resolve(process.env.ACTIVITY_PERF_OUT||'/tmp/gw-activities-performance');
const duration=Number(process.env.ACTIVITY_PERF_SECONDS||60);
const profile=process.env.ACTIVITY_PERF_PROFILE||'active';
assert(['active','stress'].includes(profile));
const sourceAtStart=fingerprint(resolve('.'),['server/src','shared/src','client/src','package.json']);
assert(duration>=10,'At least 10 seconds required');await mkdir(out,{recursive:true});
const fixture=await createFixture({tasks:2000});
let server:Awaited<ReturnType<typeof startServer>>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const samples:Array<{operation:string;status:number;ms:number;bytes:number}>=[],writes:Array<{id:string;taskId:string;eventId:string;action:string}>=[];
const browserSamples:Array<{width:number;openMs:number;filterMs:number;overflow:boolean}>=[];
const environment={node:process.version,platform:platform(),release:release(),cpu:cpus()[0]?.model,cpuCount:cpus().length,totalMemoryBytes:totalmem()};
let report:Record<string,unknown>={verdict:'FAILED',phase:'setup',profile,sourceAtStart,environment};
const percentile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)]??0;
try{
 const db=new Database(fixture.dbPath);
 const liveIds=new Set(Array.from({length:20},(_,i)=>taskId(1900+i)));
 db.transaction(()=>{
  const plan= db.prepare('SELECT nodes_json,dependencies_json FROM plan_projects WHERE project_id=?').get(fixture.projectId) as {nodes_json:string;dependencies_json:string};
  const nodes=JSON.parse(plan.nodes_json);const deps=JSON.parse(plan.dependencies_json).filter((e:{predecessorId:string;successorId:string})=>!liveIds.has(e.predecessorId)&&!liveIds.has(e.successorId));
  for(const row of db.prepare('SELECT task_id,meta_json FROM task_meta WHERE project_id=?').all(fixture.projectId) as {task_id:string;meta_json:string}[]){
   const meta=JSON.parse(row.meta_json);
   if(meta.taskKind==='summary')continue;
   meta.events.push({id:`activity-historical-${row.task_id}`,taskId:row.task_id,actor:'虚构历史成员',action:'complete',text:'测试历史完成记录',createdAt:'2026-09-07T02:00:00.000Z'});
   if(liveIds.has(row.task_id)){
    Object.assign(meta,{parentId:null,requiresReview:false,reviewerId:null,status:'in_progress',progress:40,reviewStatus:'none',blocked:false,actualEnd:null});
    db.prepare("UPDATE homepage_tasks SET status='in_progress',progress=40,blocked=0 WHERE id=? AND project_id=?").run(row.task_id,fixture.projectId);
    const node=nodes.find((n:{id:string})=>n.id===row.task_id);Object.assign(node,{parentId:`group-${meta.workstreamId}`,status:'in_progress',progress:40,blocked:false});
   }
   db.prepare('UPDATE task_meta SET meta_json=? WHERE task_id=? AND project_id=?').run(JSON.stringify(meta),row.task_id,fixture.projectId);
  }
  db.prepare('UPDATE plan_projects SET nodes_json=?,dependencies_json=? WHERE project_id=?').run(JSON.stringify(nodes),JSON.stringify(deps),fixture.projectId);
  // Worst-case 20k independent groups rather than just one large aggregate.
  for(let i=0;i<20000;i++)recordActivity(db,{projectId:fixture.projectId,sourceKey:`synthetic-activity-${i}`,type:'task.complete',category:'task',actor:{id:`actor-${i%20}`,name:`虚构成员 ${i%20}`},occurredAt:new Date(Date.parse(FIXTURE_NOW)-86400000+i*1000).toISOString(),target:{kind:'task',id:taskId(i%2000),name:`虚构成果 ${i}`},summary:'完成任务',groupable:false});
  db.exec("DELETE FROM activity_backfill_projects");
  db.prepare("UPDATE activity_backfill SET status='pending',cursor=0,processed_tasks=0,error=NULL,attempts=0,retry_at=NULL,cutoff=?,lower_bound=? WHERE id=1").run(FIXTURE_NOW,new Date(Date.parse(FIXTURE_NOW)-7*86400000).toISOString());
 })();db.close();
 server=await startServer({dbPath:fixture.dbPath,sourceRoot:resolve('.'),dist:resolve('client/dist')});
 const prefix=`/api/v1/projects/${fixture.projectId}`;
 type Session={cookie:string;csrf:string;index:number};
 async function request(session:Session,path:string,operation:string,body?:unknown,key?:string){
  const start=performance.now();const response=await fetch(server!.address+path,{method:body?'POST':'GET',headers:{cookie:session.cookie,'x-csrf-token':session.csrf,...(body?{'content-type':'application/json','idempotency-key':key||randomUUID()}: {})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const raw=await response.text();samples.push({operation,status:response.status,ms:performance.now()-start,bytes:Buffer.byteLength(raw)});const result=JSON.parse(raw);assert.equal(response.status,200,JSON.stringify({operation,result}));return result.data;
 }
 const sessions:Session[]=[];
 for(const [index,a] of fixture.accounts.entries()){
  const res=await fetch(server.address+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:a.username,password:a.password})});assert.equal(res.status,200);const result=await res.json() as any;sessions.push({index,cookie:res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),csrf:result.data.csrfToken});
 }
 const until=performance.now()+duration*1000;
 await Promise.all(sessions.map(async(session)=>{
  let step=0;
  while(performance.now()<until){
   if(step%5===4){
    const id=taskId(1900+session.index),view=await request(session,`${prefix}/tasks/${id}`,'write_context');
    const task=view.tasks.find((t:{id:string})=>t.id===id),action=task.status==='done'?'reopen':'complete',key=randomUUID();
    const result=await request(session,`${prefix}/tasks/${id}/transition`,action,{action,expectedVersion:task.version,expectedPlanVersion:view.planVersion,expectedStructureVersion:view.structureVersion,...(action==='reopen'?{progress:40,reason:'虚构压测重新执行'}:{})},key);
    const event=result.task.events.at(-1);writes.push({id:key,taskId:id,eventId:event.id,action});
   }else{
    const page=await request(session,`${prefix}/activities?range=all&category=${step%3===0?'task':'all'}&limit=20`,'activity_list');assert.equal(page.items.length,20);
    if(step%4===1){const group=page.items[0];const detail=await request(session,`${prefix}/activities/${group.id}/items?cursor=${encodeURIComponent(group.itemsCursor)}&limit=20`,'activity_details');assert.equal(detail.items.length,Math.min(group.count,20));}
    if(step%4===2&&page.nextCursor){const next=await request(session,`${prefix}/activities?range=all&category=${step%3===0?'task':'all'}&limit=20&cursor=${encodeURIComponent(page.nextCursor)}`,'activity_next');assert(!next.items.some((item:{id:string})=>page.items.some((first:{id:string})=>first.id===item.id)));}
   }
   step++;
   // Match the existing formal 20-user workload (3–8s think time). The
   // separately reported stress profile intentionally issues actions every300ms.
   await new Promise(r=>setTimeout(r,profile==='stress'?300:3000+((session.index*997+step*541)%5001)));
  }
 }));
 const status=await request(sessions[0]!,`${prefix}/activities?limit=5&range=all`,'final_status');
 report={verdict:'FAILED',phase:'integrity',profile,durationSeconds:duration,users:20,tasks:2000,backfill:status.backfill,successfulWrites:writes.length,sourceAtStart};
 assert.equal(status.backfill.status,'complete','Backfill must drain during load');
 const observer=new Database(fixture.dbPath,{readonly:true});
 const historical=(observer.prepare("SELECT count(*) AS n FROM activity_items WHERE source_key LIKE 'task-event:activity-historical-%'").get() as {n:number}).n;
 assert.equal(historical,2000);
 for(const write of writes){const count=(observer.prepare('SELECT count(*) AS n FROM activity_items WHERE project_id=? AND source_key=?').get(fixture.projectId,`task-event:${write.eventId}`) as {n:number}).n;assert.equal(count,1,`Lost/duplicate ${write.action}`);}
 const itemCount=(observer.prepare('SELECT count(*) AS n FROM activity_items').get() as {n:number}).n;
 const integrity=observer.pragma('integrity_check',{simple:true});assert.equal(integrity,'ok');observer.close();
 // Browser phase is separate so test-driver CPU does not contaminate API latency.
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:width===1440?900:844}});
  const a=fixture.accounts[0]!;await context.request.post(server.address+'/api/v1/auth/login',{data:{username:a.username,password:a.password}});
  const page=await context.newPage();await page.goto(`${server.address}/projects/${fixture.projectId}/overview`);
  const panel=page.getByRole('region',{name:'项目动态'});await panel.locator('.pa-row').first().waitFor();
  const begin=performance.now();await panel.getByRole('button',{name:'查看全部'}).click();const drawer=page.getByRole('dialog',{name:'项目动态',exact:true});await drawer.locator('.pa-row').nth(19).waitFor();const openMs=performance.now()-begin;
  const filterStart=performance.now();await drawer.getByLabel('动态分类').selectOption('risk');await drawer.getByText('当前条件下暂无动态。',{exact:false}).waitFor();const filterMs=performance.now()-filterStart;
  const overflow=await drawer.evaluate(el=>el.scrollWidth>el.clientWidth||document.documentElement.scrollWidth>innerWidth);
  browserSamples.push({width,openMs,filterMs,overflow});await page.screenshot({path:join(out,`activities-${width}.png`)});await context.close();
 }
 const operations=Object.fromEntries([...new Set(samples.map(s=>s.operation))].map(operation=>{const rows=samples.filter(s=>s.operation===operation);return [operation,{count:rows.length,p95Ms:percentile(rows.map(s=>s.ms),.95),p99Ms:percentile(rows.map(s=>s.ms),.99),maxMs:Math.max(...rows.map(s=>s.ms)),maxBytes:Math.max(...rows.map(s=>s.bytes))}];}));
 const readPass=['activity_list','activity_details','activity_next'].every(k=>operations[k]&&operations[k].p95Ms<=1000);
 const browserPass=browserSamples.every(s=>s.openMs<=3000&&s.filterMs<=1000&&!s.overflow);
 report={verdict:readPass&&browserPass?'PASS':'FAILED',scope:'Activity module only; does not supersede existing full-system capacity failures',profile,thinkTimeMs:profile==='stress'?[300,300]:[3000,8000],durationSeconds:duration,users:20,tasks:2000,itemCount,historicalBackfilled:historical,successfulWrites:writes.length,integrity,operations,browserSamples,sourceAtStart,sourceAtEnd:fingerprint(resolve('.'),['server/src','shared/src','client/src','package.json']),samples,serverSamples:server.samples};
 if(report.verdict!=='PASS')process.exitCode=1;
}catch(error){report={...report,error:String(error),samples,browserSamples};process.exitCode=1;}
finally{
 await browser?.close();await server?.stop();await fixture.cleanup();
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.info(JSON.stringify({...report,samples:undefined,serverSamples:undefined},null,2));
}
