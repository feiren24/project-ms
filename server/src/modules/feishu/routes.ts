import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { feishuTemplates, type FeishuDeliveryFilter } from '../../../../shared/src/feishu.js';
import { PlanError, requireValue } from '../planning/errors.js';
import type { FeishuRuntimeOptions } from './engine.js';
import { requireFeishuManager, readFeishuWorkspace, writeFeishuConfig, previewFeishuConfig, readFeishuDeliveryList, readFeishuDelivery, writeFeishuDelivery } from './repository.js';
export function registerFeishuRoutes(app:FastifyInstance,db:Database.Database,clock:()=>Date,protection:{token:string;protectWrite:(r:FastifyRequest)=>Promise<void>},options:FeishuRuntimeOptions){
 const prefix='/api/v1/projects/:projectId/integrations/feishu';
 type Params={projectId:string;id:string;action:string};
 const actor=(r:FastifyRequest)=>r.headers['x-demo-actor'];
 app.get<{Params:Params}>(prefix,(r,reply)=>{reply.header('Cache-Control','no-store');return{data:readFeishuWorkspace(db,r.params.projectId,actor(r),protection.token,options,clock())};});
 app.get<{Params:Params}>(`${prefix}/templates`,r=>{requireFeishuManager(db,r.params.projectId,actor(r));return{data:feishuTemplates};});
 app.get<{Params:Params;Querystring:Record<string,string>}>(`${prefix}/deliveries`,(r,reply)=>{
  reply.header('Cache-Control','no-store');const q=r.query;requireValue(Object.keys(q).every(k=>['status','botId','ruleId','days','page','pageSize'].includes(k)),'INVALID_FILTER','发送记录筛选不支持此字段。');
  const filter:FeishuDeliveryFilter={};for(const k of ['status','botId','ruleId'] as const)if(q[k]){requireValue(q[k]!.length<=200,'INVALID_FILTER','筛选内容过长。');filter[k]=q[k];}
  if(filter.status)requireValue(['pending','sending','accepted','failed','unknown','cancelled','skipped','missed'].includes(filter.status),'INVALID_STATUS','请选择有效发送状态。');
  for(const [k,max,def] of [['days',3650,7],['page',100000,1],['pageSize',100,20]] as const){const n=q[k]===undefined?def:Number(q[k]);requireValue(Number.isInteger(n)&&n>0&&n<=max,'INVALID_FILTER','分页或时间范围不正确。');filter[k]=n;}
  return{data:readFeishuDeliveryList(db,r.params.projectId,actor(r),filter,clock())};
 });
 app.get<{Params:Params}>(`${prefix}/deliveries/:id`,(r,reply)=>{reply.header('Cache-Control','no-store');return{data:readFeishuDelivery(db,r.params.projectId,actor(r),r.params.id,clock())};});
 const writes={preHandler:protection.protectWrite,bodyLimit:32*1024};
 app.post<{Params:Params;Body:unknown}>(`${prefix}/rules/preview`,writes,r=>({data:previewFeishuConfig(db,r.params.projectId,actor(r),r.body,options,clock())}));
 for(const group of ['bots','rules'] as const){
  for(const suffix of ['', '/:id'])app.post<{Params:Params;Body:unknown}>(`${prefix}/${group}${suffix}`,writes,r=>({data:writeFeishuConfig(db,r.params.projectId,group==='bots'?'bot_save':'rule_save',r.params.id,r.body,actor(r),r.headers['idempotency-key'],protection.token,options,clock())}));
  app.post<{Params:Params;Body:unknown}>(`${prefix}/${group}/:id/:action`,writes,r=>{
   const allowed=group==='bots'?['test','confirm','enable','pause']:['enable','pause','copy','archive'];
   if(!allowed.includes(r.params.action))throw new PlanError(404,'ACTION_NOT_FOUND','不支持的通知操作。');
   return{data:writeFeishuConfig(db,r.params.projectId,`${group==='bots'?'bot':'rule'}_${r.params.action}`,r.params.id,r.body,actor(r),r.headers['idempotency-key'],protection.token,options,clock())};
  });
 }
 app.post<{Params:Params;Body:unknown}>(`${prefix}/preferences`,writes,r=>({data:writeFeishuConfig(db,r.params.projectId,'preferences',undefined,r.body,actor(r),r.headers['idempotency-key'],protection.token,options,clock())}));
 app.post<{Params:Params;Body:unknown}>(`${prefix}/deliveries/:id/:action`,writes,r=>{const action=r.params.action;if(action!=='retry'&&action!=='received')throw new PlanError(404,'ACTION_NOT_FOUND','不支持的记录操作。');return{data:writeFeishuDelivery(db,r.params.projectId,actor(r),r.params.id,action,r.body,r.headers['idempotency-key'],clock())};});
}
