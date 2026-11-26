/** Real-socket wire/body equivalence probe; isolated fixture, no mocked HTTP. */
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createFixture } from './seed.js';
import { startServer } from './controller.js';
const out=resolve(process.argv[2]??'/tmp/gw-performance/compression-probe');await mkdir(out,{recursive:true});
const fixture=await createFixture({tasks:2000});let server:Awaited<ReturnType<typeof startServer>>|undefined;let result:any,fatal:string|undefined;
function rawGet(url:string,cookie:string,acceptEncoding:string){return new Promise<{status:number;headers:Record<string,unknown>;body:Buffer}>((resolve,reject)=>{const request=get(url,{headers:{cookie,'accept-encoding':acceptEncoding}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('error',reject);response.once('end',()=>resolve({status:response.statusCode??0,headers:response.headers,body:Buffer.concat(chunks)}));});request.setTimeout(30000,()=>request.destroy(new Error('Wire probe timeout')));request.once('error',reject);});}
try{
  server=await startServer({dbPath:fixture.dbPath});const account=fixture.accounts[0]!;
  const login=await fetch(`${server.address}/api/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:account.username,password:account.password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);assert((await login.json()as any).data.csrfToken);
  const url=`${server.address}/api/v1/projects/${fixture.projectId}/risks`;const identity=await rawGet(url,cookie,'identity');const gzip=await rawGet(url,cookie,'gzip');
  assert.equal(identity.status,200);assert.equal(gzip.status,200);assert.equal(identity.headers['content-encoding'],undefined);assert.equal(gzip.headers['content-encoding'],'gzip');assert.match(String(gzip.headers.vary),/accept-encoding/i);
  assert.equal(Number(identity.headers['content-length']),identity.body.length);assert.equal(Number(gzip.headers['content-length']),gzip.body.length);
  const decoded=gunzipSync(gzip.body);assert.deepStrictEqual(JSON.parse(decoded.toString()),JSON.parse(identity.body.toString()));assert.equal(JSON.parse(decoded.toString()).data.project.id,fixture.projectId);assert(gzip.body.length<identity.body.length);
  const hash=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('hex');
  result={identity:{wireBytes:identity.body.length,decodedBytes:identity.body.length,contentLength:identity.headers['content-length'],sha256:hash(identity.body)},gzip:{wireBytes:gzip.body.length,decodedBytes:decoded.length,contentLength:gzip.headers['content-length'],contentEncoding:gzip.headers['content-encoding'],decodedSha256:hash(decoded)},jsonEquivalent:true,byteEquivalent:decoded.equals(identity.body),compressedFraction:gzip.body.length/identity.body.length,savingPercent:100*(1-gzip.body.length/identity.body.length)};
  await writeFile(resolve(out,'identity.json'),identity.body);await writeFile(resolve(out,'gzip-response.bin'),gzip.body);
}catch(error){fatal=error instanceof Error?error.stack:String(error);}
finally{await server?.stop();await fixture.cleanup();}
const report={at:new Date().toISOString(),tasks:2000,verdict:fatal?'FAIL':'PASS',note:'Raw node:http sockets preserve compressed wire bodies; decoded JSON equality and declared Content-Length checked. Fixture accounts/data only. This two-request correctness/compression probe is not latency capacity evidence.',result,fatal};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.info(JSON.stringify(report,null,2));if(fatal)process.exitCode=1;
