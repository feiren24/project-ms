/** Sequential runs: overlapping benchmarks would invalidate the CPU/latency comparison. */
import { spawn } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const arg=(name:string)=>{const i=process.argv.indexOf(`--${name}`);return i<0?undefined:process.argv[i+1];};
const profile=arg('profile')??'full';if(!['full','matrix','smoke'].includes(profile))throw new Error('profile: full, matrix, smoke');
const out=resolve(arg('out')??`tests/performance/results/suite-${new Date().toISOString().replace(/[:.]/g,'-')}`);await mkdir(out,{recursive:true});
const rows=profile==='smoke'?[1,5,10,20].map(users=>({name:`smoke-2000-${users}`,tasks:2000,users,duration:8,dense:false})):[
  ...[1000,2000].flatMap(tasks=>[10,20].map(users=>({name:`matrix-${tasks}-${users}`,tasks,users,duration:300,dense:false}))),
  ...(profile==='full'?[{name:'repeat-2000-20-2',tasks:2000,users:20,duration:300,dense:false},{name:'repeat-2000-20-3',tasks:2000,users:20,duration:300,dense:false},{name:'soak-2000-20',tasks:2000,users:20,duration:1800,dense:false},{name:'boundary-5000-20',tasks:5000,users:20,duration:300,dense:false},{name:'dense-2000-20',tasks:2000,users:20,duration:300,dense:true},{name:'isolation-5-projects',tasks:2000,users:20,duration:300,dense:false}]:[]),
];
const results:any[]=[];
if(process.argv.includes('--resume'))throw new Error('--resume is disabled: every suite run requires fresh source/build measurements');
for(const row of rows){const runOut=resolve(out,row.name);
  const args=['--import','tsx',fileURLToPath(new URL(row.name==='isolation-5-projects'?'./isolation.ts':'./run.ts',import.meta.url)),'--tasks',String(row.tasks),'--users',String(row.users),'--duration-seconds',String(row.duration),'--warmup-seconds',profile==='smoke'?'1':'60','--out',runOut];if(profile==='smoke')args.push('--quick');if(row.dense)args.push('--dense');for(const name of ['source-root','dist'])if(arg(name))args.push(`--${name}`,arg(name)!);
  console.info(`Starting ${row.name}`);const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});child.once('exit',resolve);child.once('error',reject);});let verdict='NO_REPORT';try{verdict=JSON.parse(await readFile(resolve(runOut,'report.json'),'utf8')).verdict;}catch{}results.push({name:row.name,code,verdict,out:runOut});await writeFile(resolve(out,'suite.json'),JSON.stringify({profile,results},null,2));
}
await writeFile(resolve(out,'suite.md'),`# Performance suite\n\nProfile: ${profile}. Executed sequentially. Full profile contains the 4-run normal matrix, 3 total repeated 2000/20 runs, a 30-minute soak, 5000-task boundary, and dense dependency case.\n\n| Run | Verdict | Exit |\n|---|---|---|\n${results.map(r=>`| ${r.name} | ${r.verdict} | ${r.code??'resumed'} |`).join('\n')}\n`);
if(results.some(r=>!r.skipped&&(r.code!==0||r.verdict!==(profile==='smoke'?'SMOKE_ONLY':'PASS'))))process.exitCode=1;
