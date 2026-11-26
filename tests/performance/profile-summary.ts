/** Summarize sampled CPU stacks; percentages include profiler-observed idle/GC time. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
type Frame = { functionName:string; url:string; lineNumber:number; columnNumber:number };
type Node = { id:number; callFrame:Frame; children?:number[] };
const input=process.argv[2];
if(!input)throw new Error('Usage: tsx tests/performance/profile-summary.ts PROFILE.cpuprofile [OUT.json]');
const profile=JSON.parse(await readFile(input,'utf8')) as {nodes:Node[];samples:number[];timeDeltas:number[];startTime:number;endTime:number};
const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
const parent=new Map<number,number>();for(const node of profile.nodes)for(const child of node.children??[])parent.set(child,node.id);
const self=new Map<string,number>(),inclusive=new Map<string,number>(),categories=new Map<string,number>();
const label=(frame:Frame)=>`${frame.functionName||'(anonymous)'} @ ${frame.url||'(V8)'}:${frame.lineNumber+1}:${frame.columnNumber+1}`;
function category(stack:Frame[]){
  if(stack.some(frame=>frame.functionName==='(idle)'))return 'idle';
  if(stack.some(frame=>frame.functionName==='(garbage collector)'))return 'garbage collection';
  if(stack.some(frame=>frame.functionName==='deliverNotification'))return 'notification delivery (inclusive)';
  if(stack.some(frame=>frame.functionName==='evaluateProjectRisks'))return 'risk evaluation (inclusive, startup and jobs)';
  if(stack.some(frame=>frame.functionName==='captureSnapshot'))return 'snapshot capture (inclusive, startup and jobs)';
  if(stack.some(frame=>frame.url.includes('/server/src/jobs/')))return 'other job machinery (claim, schedule, finish)';
  if(stack.some(frame=>frame.url.includes('/server/src/')))return 'other application work (requests and initialization)';
  return 'runtime, serialization and dependencies';
}
let totalUs=0;
for(let index=0;index<profile.samples.length;index++){
  const elapsed=profile.timeDeltas[index]??0;totalUs+=elapsed;let node=nodes.get(profile.samples[index]!);if(!node)continue;
  const leaf=label(node.callFrame);self.set(leaf,(self.get(leaf)??0)+elapsed);
  const stack:Frame[]=[];const seen=new Set<string>();
  while(node){stack.push(node.callFrame);seen.add(label(node.callFrame));node=nodes.get(parent.get(node.id)!);}
  for(const key of seen)inclusive.set(key,(inclusive.get(key)??0)+elapsed);
  const key=category(stack);categories.set(key,(categories.get(key)??0)+elapsed);
}
const ranked=(values:Map<string,number>)=>[...values].sort((a,b)=>b[1]-a[1]).map(([frame,us])=>({frame,sampledMs:us/1000,percent:100*us/totalUs}));
const summary={profile:resolve(input),note:'V8 sampling estimates, not exact function wall times or per-job latency. Entire server lifetime includes startup, warmup, probes, mixed workload and shutdown. Inclusive rows overlap; category rows are exclusive. Profiler overhead is included; this is not capacity evidence.',sampleCount:profile.samples.length,sampledMs:totalUs/1000,categories:ranked(categories),self:ranked(self).slice(0,80),inclusive:ranked(inclusive).slice(0,100)};
const output=resolve(process.argv[3]??`${input}.summary.json`);await writeFile(output,JSON.stringify(summary,null,2));
console.info(JSON.stringify({output,categories:summary.categories,topSelf:summary.self.slice(0,20),topInclusive:summary.inclusive.filter(row=>row.frame.includes('/server/src/')).slice(0,20)},null,2));
