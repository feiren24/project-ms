import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import { PlanningError } from './planning';
import type { FeishuWorkspace, FeishuDelivery, FeishuDeliveryFilter, FeishuMessage, FeishuRuleDraft } from '../../../shared/src/feishu';
async function request<T>(projectId:string,path:string,options?:{workspace:FeishuWorkspace;actorId:string;body:unknown;key:string},actorId?:string):Promise<T>{
 const response=await sessionFetch(`${projectApi(projectId)}/integrations/feishu${path}`,{method:options?'POST':'GET',headers:options?{'Content-Type':'application/json','X-Preview-Token':options.workspace.writeToken,'X-Demo-Actor':options.actorId,'Idempotency-Key':options.key}:actorId?{'X-Demo-Actor':actorId}:{},body:options?JSON.stringify(options.body):undefined});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new PlanningError(result.error?.message||'飞书通知暂时无法读取或保存，请重试。',response.status,result.error?.code);
 return result.data;
}
export const fetchFeishu=(projectId:string,actorId:string)=>request<FeishuWorkspace>(projectId,'',undefined,actorId);
export const saveFeishu=(workspace:FeishuWorkspace,actorId:string,path:string,body:unknown,key:string)=>request<FeishuWorkspace>(workspace.project.id,path,{workspace,actorId,body,key});
export const previewFeishu=(workspace:FeishuWorkspace,actorId:string,rule:FeishuRuleDraft)=>request<FeishuMessage>(workspace.project.id,'/rules/preview',{workspace,actorId,body:{rule},key:crypto.randomUUID()});
export const fetchFeishuDeliveries=(projectId:string,filter:FeishuDeliveryFilter,actorId:string)=>request<{items:FeishuDelivery[];total:number}>(projectId,`/deliveries?${new URLSearchParams(Object.entries(filter).filter(([,v])=>v!==''&&v!==undefined).map(([k,v])=>[k,String(v)]))}`,undefined,actorId);
export const fetchFeishuDelivery=(projectId:string,id:string,actorId:string)=>request<FeishuDelivery>(projectId,`/deliveries/${encodeURIComponent(id)}`,undefined,actorId);
export const recoverFeishuDelivery=(workspace:FeishuWorkspace,actorId:string,delivery:FeishuDelivery,action:'retry'|'received',key:string)=>request<FeishuDelivery>(workspace.project.id,`/deliveries/${encodeURIComponent(delivery.id)}/${action}`,{workspace,actorId,body:{expectedVersion:delivery.version,confirmed:true},key});
