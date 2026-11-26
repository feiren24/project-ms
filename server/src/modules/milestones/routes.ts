import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PlanError } from '../planning/errors.js';
import { initializeMilestones } from './store.js';
import { readMilestones, writeMilestone } from './repository.js';

export function registerMilestoneRoutes(app:FastifyInstance,db:Database.Database,clock:()=>Date,protection:{token:string;protectWrite:(request:FastifyRequest)=>Promise<void>},actorName?:(request:FastifyRequest)=>string) {
 initializeMilestones(db,clock());
 const prefix='/api/v1/projects/:projectId/milestones';
 for(const suffix of ['', '/:milestoneId'])app.get<{Params:{projectId:string;milestoneId?:string}}>(prefix+suffix,(request,reply)=>{
  reply.header('Cache-Control','no-store');const data=readMilestones(db,request.params.projectId,protection.token,clock());
  if(request.params.milestoneId){data.milestones=data.milestones.filter(m=>m.id===request.params.milestoneId);if(!data.milestones.length)throw new PlanError(404,'MILESTONE_NOT_FOUND','里程碑不存在或不属于当前项目。');}
  return {data};
 });
 for(const route of [{method:'POST',suffix:'',operation:'create'},{method:'PATCH',suffix:'/:milestoneId',operation:'update'},{method:'POST',suffix:'/:milestoneId/draft',operation:'draft'},{method:'POST',suffix:'/:milestoneId/transition',operation:'transition'}] as const)
 app.route<{Params:{projectId:string;milestoneId?:string};Body:unknown}>({method:route.method,url:prefix+route.suffix,preHandler:protection.protectWrite,bodyLimit:256*1024,handler:request=>({data:writeMilestone(db,request.params.projectId,route.operation,request.params.milestoneId,request.body,request.headers['x-demo-actor'],request.headers['idempotency-key'],clock(),actorName?.(request))})});
}
