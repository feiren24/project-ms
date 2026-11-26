import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import type { RiskWorkspace, RiskDraft, RiskMutation, RiskWriteResult, RiskActionTaskRequest, RiskResponsibilityRequest } from '../../../shared/src/risks';
import { PlanningError } from './planning';
async function request<T>(path: string, method = 'GET', workspace?: RiskWorkspace, actor?: string, body?: unknown, key?: string, projectId?: string): Promise<T> {
  const response = await sessionFetch(projectApi(workspace?.project.id || projectId) + '/risks' + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Preview-Token': workspace!.writeToken, 'X-Demo-Actor': actor!, 'Idempotency-Key': key || crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || '风险数据暂时无法读取或保存，请重试。', response.status, result.error?.code);
  return result.data;
}
export const fetchRisks = (projectId?: string) => request<RiskWorkspace>('', 'GET', undefined, undefined, undefined, undefined, projectId);
export const createRisk = (w: RiskWorkspace, actor: string, draft: RiskDraft, key: string, sourceAlertId?: string) => request<RiskWriteResult>('', 'POST', w, actor, { ...draft, ...(sourceAlertId ? { sourceAlertId } : {}) }, key);
export const updateRisk = (w: RiskWorkspace, actor: string, id: string, draft: RiskDraft, expectedVersion: number, reason: string | undefined, key: string) => request<RiskWriteResult>(`/${encodeURIComponent(id)}`, 'PATCH', w, actor, { ...draft, expectedVersion, reason }, key);
export const transitionRisk = (w: RiskWorkspace, actor: string, id: string, body: RiskMutation, key: string) => request<RiskWriteResult>(`/${encodeURIComponent(id)}/transition`, 'POST', w, actor, body, key);
export const linkRiskTask = (w: RiskWorkspace, actor: string, id: string, body: { expectedVersion: number; taskId: string; reason?: string; remove?: boolean }, key: string) => request<RiskWriteResult>(`/${encodeURIComponent(id)}/actions`, 'POST', w, actor, body, key);
export const createRiskTask = (w: RiskWorkspace, actor: string, id: string, body: RiskActionTaskRequest, key: string) => request<RiskWriteResult>(`/${encodeURIComponent(id)}/actions/create`, 'POST', w, actor, body, key);
export const evaluateRisks = (w: RiskWorkspace, actor: string, key: string) => request<RiskWorkspace>('/evaluate', 'POST', w, actor, {}, key);
export const snoozeRiskAlert = (w: RiskWorkspace, actor: string, id: string, body: { expectedVersion: number; reason: string; until: string }, key: string) => request<RiskWriteResult>(`/alerts/${encodeURIComponent(id)}/snooze`, 'POST', w, actor, body, key);

export const handoverRiskResponsibilities = (w: RiskWorkspace, actor: string, id: string, body: RiskResponsibilityRequest, key: string) => request<RiskWriteResult>(`/${encodeURIComponent(id)}/responsibilities`, 'POST', w, actor, body, key);
