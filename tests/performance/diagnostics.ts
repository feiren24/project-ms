/** Opt-in, bounded test-owned observations. Never wait for disk in a request hook. */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { PerformanceObserver, performance } from 'node:perf_hooks';

export async function processDiagnostics(file:string,role:string){
  await mkdir(dirname(file),{recursive:true});const stream=createWriteStream(file);await once(stream,'open');
  const limits={fileBytes:32*1024*1024,pendingBytes:256*1024,lineBytes:16*1024,flushTimeoutMs:5000};
  let error:string|undefined,acceptedBytes=0,acceptedRecords=0,stopped=false;
  const dropped={pending:0,budget:0,oversize:0,serialization:0,stream:0,afterStop:0};
  stream.on('error',value=>{error=String(value);});
  const record=(value:Record<string,unknown>)=>{
    if(stopped){dropped.afterStop++;return;}if(error){dropped.stream++;return;}
    let line:string;try{line=JSON.stringify({role,pid:process.pid,at:new Date().toISOString(),...value})+'\n';}catch{dropped.serialization++;return;}
    const bytes=Buffer.byteLength(line);if(bytes>limits.lineBytes){dropped.oversize++;return;}
    // Reserve one small terminal record outside these budgets. No unbounded userland queue.
    if(acceptedBytes+bytes>limits.fileBytes-limits.lineBytes){dropped.budget++;return;}
    if(stream.writableLength+bytes>limits.pendingBytes-limits.lineBytes){dropped.pending++;return;}
    acceptedBytes+=bytes;acceptedRecords++;stream.write(line);
  };
  const gcEntries=(entries:ReturnType<PerformanceObserver['takeRecords']>)=>{for(const entry of entries){const detail=(entry as any).detail;record({type:'gc',startedAt:new Date(performance.timeOrigin+entry.startTime).toISOString(),durationMs:entry.duration,kind:detail?.kind,flags:detail?.flags});}};
  const observer=new PerformanceObserver(list=>gcEntries(list.getEntries()));observer.observe({entryTypes:['gc']});
  const sample=()=>record({type:'process',monotonicMs:performance.now(),memory:process.memoryUsage(),resourceUsage:process.resourceUsage()});
  record({type:'metadata',platform:process.platform,node:process.version,limits,note:'resourceUsage fields are raw cumulative Node values (CPU microseconds, maxRSS KiB). Platform support varies; zero page-fault/I/O/switch counters do not prove absence. GC kind/flags use perf_hooks detail. Observer overhead is included; diagnostic only. Output drops on pending/file budget; terminal summary and lifecycle report expose loss.'});sample();
  const timer=setInterval(sample,1000);timer.unref();
  let stopPromise:Promise<{file:string;acceptedBytes:number;acceptedRecords:number;dropped:typeof dropped;error:string|undefined;complete:boolean}>|undefined;
  const stop=()=>stopPromise??=(async()=>{
    clearInterval(timer);gcEntries(observer.takeRecords());observer.disconnect();sample();stopped=true;
    const terminal=JSON.stringify({type:'diagnostic_summary',role,pid:process.pid,at:new Date().toISOString(),acceptedBytes,acceptedRecords,dropped,limits,error:error??null})+'\n';
    await new Promise<void>(resolve=>{
      let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);stream.off('finish',finish);stream.off('close',finish);resolve();};
      const timeout=setTimeout(()=>{error??='Diagnostic flush timed out; output may be incomplete';stream.destroy();finish();},limits.flushTimeoutMs);
      stream.once('finish',finish);stream.once('close',finish);
      if(stream.closed||stream.writableFinished){finish();return;}if(!stream.destroyed)stream.end(error?undefined:terminal);
    });
    return {file,acceptedBytes,acceptedRecords,dropped:{...dropped},error,complete:!error&&Object.values(dropped).every(n=>n===0)};
  })();
  return {record,stop};
}
