import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { buildApp } from '../../server/src/app.js';

it('starts the actual entrypoint with an env file, serves one HTTP port and exits gracefully',async()=>{
  const root=mkdtempSync(join(tmpdir(),'goodwork-runtime-'));
  let child:ChildProcess|undefined;
  try {
    for(const path of ['server','shared'])cpSync(resolve(path),join(root,path),{recursive:true});
    cpSync(resolve('package.json'),join(root,'package.json'));
    symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
    mkdirSync(join(root,'client/dist/assets'),{recursive:true});
    writeFileSync(join(root,'client/dist/index.html'),'<div id="app"></div><script src="/assets/app.js"></script>');
    writeFileSync(join(root,'client/dist/assets/app.js'),'window.runtimeProbe=true;');
    const dbPath=join(root,'existing.sqlite');const seed=buildApp({dbPath,jobIntervalMs:0});await seed.ready();await seed.close();
    const probe=createServer();await new Promise<void>(done=>probe.listen(0,'127.0.0.1',done));
    const port=(probe.address() as {port:number}).port;await new Promise<void>(done=>probe.close(()=>done()));
    const origin=`http://127.0.0.1:${port}`,envPath=join(root,'.env.test');
    writeFileSync(envPath,`HOST=127.0.0.1\nPORT=${port}\nDATABASE_PATH="${dbPath}"\nDATABASE_MODE=existing-only\nPUBLIC_BASE_URL=${origin}\nSERVE_WEB=true\nNODE_ENV=production\n`);
    const env={...process.env};for(const key of ['HOST','PORT','DATABASE_PATH','DATABASE_MODE','PUBLIC_BASE_URL','SERVE_WEB','NODE_ENV','FEISHU_MASTER_KEY'])delete env[key];
    for(let attempt=0;attempt<2;attempt++) {
      child=spawn(process.execPath,[`--env-file=${envPath}`,'--import','tsx',join(root,'server/src/main.ts')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
      const finished=once(child,'exit');let output='';child.stdout?.on('data',value=>output+=value);child.stderr?.on('data',value=>output+=value);
      let ready=false;for(let i=0;i<100;i++) {try{ready=(await fetch(origin+'/health/ready')).ok;}catch{}if(ready||child.exitCode!==null)break;await new Promise(done=>setTimeout(done,100));}
      expect(ready,output).toBe(true);
      expect(await (await fetch(origin+'/projects/phase-one/tasks/task-011')).text()).toContain('<div id="app">');
      expect(await (await fetch(origin+'/assets/app.js')).text()).toBe('window.runtimeProbe=true;');
      expect((await fetch(origin+'/api/v1/projects')).status).toBe(401);
      child.kill('SIGTERM');expect((await finished)[0],output).toBe(0);child=undefined;
    }
  } finally {if(child){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}rmSync(root,{recursive:true,force:true});}
},30000);
