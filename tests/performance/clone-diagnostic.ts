/** Bounded clone microbenchmark on real fixture DTOs; not an HTTP capacity test. */
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createFixture,FIXTURE_NOW } from './seed.js';
import { readPlan } from '../../server/src/modules/planning/repository.js';
import { readAnalytics } from '../../server/src/modules/analytics/repository.js';
const out=resolve(process.argv[2]??'/tmp/gw-performance/clone-diagnostic');await mkdir(out,{recursive:true});
const fixture=await createFixture({tasks:2000});const db=new Database(fixture.dbPath);const results:any[]=[];
function inspect(value:unknown,path='$',seen=new WeakSet<object>(),issues:string[]=[]):string[]{
  if(value===undefined)issues.push(`${path}: undefined (JSON omits object property, converts array element to null)`);
  else if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))issues.push(`${path}: non-finite or negative-zero number`);
  else if(typeof value==='bigint'||typeof value==='function'||typeof value==='symbol')issues.push(`${path}: ${typeof value}`);
  else if(value!==null&&typeof value==='object'){
    if(seen.has(value)){issues.push(`${path}: repeated object identity`);return issues;}seen.add(value);
    if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)issues.push(`${path}: non-plain object`);
    if(Reflect.ownKeys(value).some(key=>typeof key==='symbol'))issues.push(`${path}: symbol key`);
    for(const [key,child]of Object.entries(value))inspect(child,`${path}.${key}`,seen,issues);
  }return issues;
}
try{
  const now=new Date(FIXTURE_NOW);const objects={plan:readPlan(db,fixture.projectId,'diagnostic-only',now),analyticsFull:readAnalytics(db,fixture.projectId,{},now)};
  for(const [name,value]of Object.entries(objects)){
    const json=JSON.stringify(value);const semanticIssues=inspect(value);const raw:Record<string,number[]>={structuredClone:[],jsonRoundTrip:[],preSerializedParse:[]};
    const methods={structuredClone:()=>structuredClone(value),jsonRoundTrip:()=>JSON.parse(JSON.stringify(value)),preSerializedParse:()=>JSON.parse(json)};
    // Rotate method order; validation is outside each timed interval.
    const names=Object.keys(methods)as Array<keyof typeof methods>;
    for(let iteration=0;iteration<10;iteration++)for(let offset=0;offset<names.length;offset++){
      const method=names[(iteration+offset)%names.length]!;const start=performance.now();const cloned=methods[method]();raw[method]!.push(performance.now()-start);assert.equal(JSON.stringify(cloned),json);
    }
    let strictEquivalent=true,strictDifference:string|undefined;try{assert.deepStrictEqual(JSON.parse(json),structuredClone(value));}catch(error){strictEquivalent=false;strictDifference=String(error).slice(0,1200);}
    const stats=Object.fromEntries(Object.entries(raw).map(([method,times])=>{const sorted=[...times].sort((a,b)=>a-b);return[method,{iterations:10,p50Ms:sorted[4],p95Ms:sorted[9],meanMs:times.reduce((a,b)=>a+b,0)/10}];}));
    results.push({name,jsonBytes:Buffer.byteLength(json),jsonEquivalentAll30:true,strictEquivalent,strictDifference,semanticIssues,raw,stats});
  }
}finally{db.close();await fixture.cleanup();}
const report={at:new Date().toISOString(),node:process.version,tasks:2000,note:'Clone-only diagnostic, 10 iterations per method with rotating order. Pre-serialized JSON creation is excluded from parse-only cost. JSON transport equivalence is checked after every clone, outside timing. A fixture cannot prove all production DTOs lack special values or that internal consumers tolerate omitted undefined keys.',results};
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.info(JSON.stringify(report,null,2));
