import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processDiagnostics } from './diagnostics.js';

test('bounded observer drops pending output without waiting and stops idempotently',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gw-diag-test-'));const file=join(directory,'events.ndjson');
  const original=WriteStream.prototype._write;
  WriteStream.prototype._write=function(chunk,encoding,callback){if(this.path===file)setTimeout(()=>original.call(this,chunk,encoding,callback),40);else original.call(this,chunk,encoding,callback);};
  try{
    const observer=await processDiagnostics(file,'test');
    for(let i=0;i<1000;i++)observer.record({type:'synthetic',value:'x'.repeat(2048)});
    const first=observer.stop();assert.equal(observer.stop(),first);const result=await first;
    assert(result.dropped.pending>0);assert.equal(result.error,undefined);assert.equal(result.complete,false);assert(result.acceptedBytes<=256*1024);
    const records=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(records.at(-1).type,'diagnostic_summary');assert.equal(records.at(-1).dropped.pending,result.dropped.pending);
  }finally{WriteStream.prototype._write=original;await rm(directory,{recursive:true,force:true});}
});
test('write failure is returned by stop without leaking or suppressing evidence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gw-diag-failure-'));const file=join(directory,'events.ndjson');
  const original=WriteStream.prototype.write;
  WriteStream.prototype.write=function(...args:any[]){if(this.path===file){this.destroy(new Error('synthetic disk failure'));return false;}return (original as any).apply(this,args);};
  try{const observer=await processDiagnostics(file,'test');await new Promise(resolve=>setImmediate(resolve));const result=await observer.stop();assert.match(result.error??'',/synthetic disk failure/);assert.equal(result.complete,false);}finally{WriteStream.prototype.write=original;await rm(directory,{recursive:true,force:true});}
});
