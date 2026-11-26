import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export interface ServerOptions { dbPath:string; dist?:string; sourceRoot?:string; port?:number; startupTimeoutMs?:number; cpuProfileDir?:string; diagnosticFile?:string }
export async function startServer(options:ServerOptions){
  const args=[...(options.cpuProfileDir?['--cpu-prof',`--cpu-prof-dir=${options.cpuProfileDir}`]:[]),'--import','tsx',fileURLToPath(new URL('./server.ts',import.meta.url)),'--db',options.dbPath];
  if(options.diagnosticFile)args.push('--diagnostic-file',options.diagnosticFile);
  if(options.dist)args.push('--dist',options.dist);if(options.sourceRoot)args.push('--source-root',options.sourceRoot);if(options.port)args.push('--port',String(options.port));
  const child=spawn(process.execPath,args,{env:{...process.env,NODE_ENV:'production'},stdio:['ignore','pipe','pipe','ipc']});
  const samples:any[]=[];let output='',exited=false;let stopPromise:Promise<void>|undefined;
  child.stdout?.on('data',chunk=>{output+=chunk;});child.stderr?.on('data',chunk=>{output+=chunk;});
  child.on('message',(message:any)=>{if(message.type==='metrics')samples.push(message.sample);});
  const completion=new Promise<void>(resolve=>{child.once('exit',()=>{exited=true;resolve();});child.once('error',()=>{if(!child.pid){exited=true;resolve();}});});
  const stop=()=>stopPromise??=(async()=>{
    if(exited||child.exitCode!==null||child.signalCode!==null){await completion;return;}
    if(child.connected){try{child.send({type:'stop'},error=>{if(error&&!exited)child.kill('SIGTERM');});}catch{child.kill('SIGTERM');}}
    else child.kill('SIGTERM');
    const killTimer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},15000);
    try{await completion;}finally{clearTimeout(killTimer);}
  })();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const onReady:{listener?:(message:any)=>void}={};
  try{
    const ready=await new Promise<any>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Server startup timed out: ${output}`)),options.startupTimeoutMs??120000);
      onReady.listener=(message:any)=>{if(message.type==='ready')resolve(message);};child.on('message',onReady.listener);
      void completion.then(()=>reject(new Error(`Server exited before readiness (${child.exitCode??child.signalCode}): ${output}`)));
      child.once('error',reject);
    });
    return {...ready,samples,child,logs:()=>output,stop};
  }catch(error){await stop();throw error;}
  finally{if(timer)clearTimeout(timer);if(onReady.listener)child.off('message',onReady.listener);}
}
