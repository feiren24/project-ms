import { sessionFetch } from './session-transport';
import { AuthError } from './auth';
import type { SystemSettingsStatus, SaveFeishuKeyInput, SystemSettingsAudit, SystemKeyBackup } from '../../../shared/src/system-settings';
export type SystemKeyStatus=SystemSettingsStatus;
export type SystemKeyInput=SaveFeishuKeyInput;
export type { SystemSettingsAudit };
interface BackupSystemKeyInput { expectedVersion:number;confirmed:true }
async function request<T>(path:string, body?:unknown, key?:string):Promise<T> {
  let response:Response;
  try { response=await sessionFetch(`/api/v1/admin/settings${path}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined}); }
  catch { throw new AuthError('连接中断，提交结果尚未确认。请重试原操作，或刷新状态核对。'); }
  const result=await response.json().catch(()=>null);
  if(!response.ok) throw new AuthError(result?.error?.message||'操作未完成，请重试。',response.status,result?.error?.code||'');
  if(!result?.data) throw new AuthError('未收到完整结果，请重试原操作或刷新状态核对。');
  return result.data;
}
export const fetchSystemSettings=()=>request<SystemKeyStatus>('');
export const saveSystemKey=(body:SystemKeyInput,key:string)=>request<SystemKeyStatus>('/feishu-key',body,key);
export const backupSystemKey=(body:BackupSystemKeyInput)=>request<SystemKeyBackup>('/feishu-key/backup',body);
export const fetchSystemAudit=(page=1)=>request<SystemSettingsAudit>(`/audit?page=${page}`);
