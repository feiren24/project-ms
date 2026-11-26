/** Test-owned real HTTP server. No debug route is added to production code. */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { FIXTURE_NOW } from './seed.js';
import { processDiagnostics } from './diagnostics.js';
const arg=(name:string)=>{const index=process.argv.indexOf(`--${name}`);return index<0?undefined:process.argv[index+1];};
const dbPath=arg('db');if(!dbPath||!existsSync(resolve(dirname(dbPath),'fixture.json')))throw new Error('Requires an isolated fixture DB with fixture.json');
const sourceRoot=resolve(arg('source-root')??'.');const dist=resolve(arg('dist')??process.env.PERF_DIST??'client/dist');
if(!existsSync(resolve(dist,'index.html')))throw new Error(`Production build missing: ${dist}`);
let diagnostic:Awaited<ReturnType<typeof processDiagnostics>>|undefined,app:any,observer:Database.Database|undefined,histogram:ReturnType<typeof monitorEventLoopDelay>|undefined,timer:ReturnType<typeof setInterval>|undefined,finalMetrics:(()=>unknown)|undefined;
let stopPromise:Promise<void>|undefined;
const stop=()=>stopPromise??=(async()=>{
  if(timer)clearInterval(timer);const cleanupErrors:string[]=[];
  try{await app?.close();}catch(error){cleanupErrors.push(`App close: ${String(error)}`);}
  try{if(finalMetrics&&process.connected)process.send?.({type:'metrics',sample:finalMetrics()});}catch(error){cleanupErrors.push(`Final metrics: ${String(error)}`);}
  histogram?.disable();try{observer?.close();}catch(error){cleanupErrors.push(`Observer close: ${String(error)}`);}
  let diagnosticResult;try{diagnosticResult=await diagnostic?.stop();if(diagnosticResult?.error)cleanupErrors.push(diagnosticResult.error);}catch(error){cleanupErrors.push(`Diagnostic stop: ${String(error)}`);}
  if(arg('diagnostic-file'))try{await writeFile(resolve(dirname(arg('diagnostic-file')!),'server-diagnostic-lifecycle.json'),JSON.stringify({diagnosticResult,cleanupErrors,observationComplete:diagnosticResult?.complete===true&&cleanupErrors.length===0},null,2));}catch(error){cleanupErrors.push(`Lifecycle report: ${String(error)}`);}
  if(cleanupErrors.length){console.error(JSON.stringify({cleanupErrors}));process.exitCode=1;}
  if(process.connected)process.disconnect?.();
})();
try{
diagnostic=arg('diagnostic-file')?await processDiagnostics(resolve(arg('diagnostic-file')!),'server'):undefined;
const {buildApp}=await import(pathToFileURL(resolve(sourceRoot,'server/src/app.ts')).href);
const wallStart=Date.now();const port=Number(arg('port')??0);
app=buildApp({dbPath,clock:()=>new Date(Date.parse(FIXTURE_NOW)+Date.now()-wallStart),secureCookies:false,...(port?{allowedOrigins:[`http://127.0.0.1:${port}`]}:{}),backupDirectory:resolve(dirname(dbPath),'backups')});
observer=new Database(dbPath,{readonly:true});observer.pragma('busy_timeout=50');
histogram=monitorEventLoopDelay({resolution:20});histogram.enable();
if(diagnostic){app.addHook('onRequest',async(request:any)=>{request.perfDiagnostic={start:performance.now(),id:request.headers['x-perf-diagnostic-id']??null};});app.addHook('onResponse',async(request:any,reply:any)=>{const entry=request.perfDiagnostic;if(entry){const end=performance.now();diagnostic!.record({type:'request',requestId:entry.id,method:request.method,path:request.url,status:reply.statusCode,startedAt:new Date(performance.timeOrigin+entry.start).toISOString(),endedAt:new Date(performance.timeOrigin+end).toISOString(),durationMs:end-entry.start});}});}
let requests=0,busyResponses=0,serverErrors=0,observerBusy=0;
app.addHook('onResponse',async (_req:any,reply:any)=>{requests++;if(reply.statusCode===503)busyResponses++;if(reply.statusCode>=500)serverErrors++;});
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
app.get('/*',async(request:any,reply:any)=>{
  if(request.url.startsWith('/api/'))return reply.code(404).send({error:{code:'NOT_FOUND'}});
  let file=resolve(dist,`.${decodeURIComponent(request.url.split('?')[0])}`);
  if(file!==dist&&!file.startsWith(dist+sep))return reply.code(403).send();
  if(!existsSync(file)||!statSync(file).isFile()){if(extname(file))return reply.code(404).send({error:{code:'NOT_FOUND'}});file=resolve(dist,'index.html');}
  return reply.type(mime[extname(file)]??'application/octet-stream').send(readFileSync(file));
});
let cpu=process.cpuUsage(),last=performance.now(),elu=performance.eventLoopUtilization();
function metrics(){const now=performance.now();const nextCpu=process.cpuUsage();const nextElu=performance.eventLoopUtilization();let jobs:unknown[]=[];try{jobs=observer!.prepare("SELECT kind,status,count(*) AS count,MAX(attempts) AS maxAttempts,SUM(CASE WHEN json_extract(payload_json,'$.scheduledAt') IS NOT NULL THEN 1 ELSE 0 END) AS periodicCount,MAX(CASE WHEN status IN('pending','running') THEN MAX(0,(julianday(?) - julianday(due_at))*86400) ELSE 0 END) AS oldestDueAgeSeconds FROM background_jobs GROUP BY kind,status").all(new Date(Date.parse(FIXTURE_NOW)+Date.now()-wallStart).toISOString());}catch{observerBusy++;}
  const metricsElapsedMs=performance.now()-now;if(diagnostic)diagnostic.record({type:'metrics_collection',startedAt:new Date(performance.timeOrigin+now).toISOString(),durationMs:metricsElapsedMs,observerBusy});
  const sample={...(diagnostic?{metricsElapsedMs,resourceUsage:process.resourceUsage(),memory:process.memoryUsage()}:{}),at:new Date().toISOString(),elapsedMs:now-last,cpuPercent:((nextCpu.user-cpu.user+nextCpu.system-cpu.system)/1000)/(now-last)*100,rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,loopP95Ms:histogram!.percentile(95)/1e6,loopMaxMs:histogram!.max/1e6,eventLoopUtilization:performance.eventLoopUtilization(nextElu,elu).utilization,requests,busyResponses,serverErrors,observerBusy,jobs};cpu=nextCpu;last=now;elu=nextElu;histogram!.reset();return sample;}
finalMetrics=metrics;
const address=await app.listen({host:'127.0.0.1',port});
process.send?.({type:'ready',address,pid:process.pid,sourceRoot,dist,metrics:metrics()});
timer=setInterval(()=>process.send?.({type:'metrics',sample:metrics()}),1000);timer.unref();
process.on('message',(message:any)=>{if(message.type==='stop')void stop();if(message.type==='sample')process.send?.({type:'metrics',sample:metrics()});});
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());

}catch(error){await stop();throw error;}
