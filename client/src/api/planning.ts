import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import type { PlanHistory, ProjectPlan, PlanEditRequest, PlanPreview, BaselinePublishRequest, PlanBaseline, PlanOrderRequest, PlanOrderResult } from '../../../shared/src/planning';

export class PlanningError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
async function request<T>(path: string, token?: string, body?: unknown, key?: string, projectId?: string, actorId?: string): Promise<T> {
  const response = await sessionFetch(projectApi(projectId) + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(actorId ? { 'X-Demo-Actor': actorId } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Preview-Token': token || '' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || result.message || '计划暂时无法保存，请稍后重试。', response.status, result.error?.code);
  return result.data as T;
}
export const fetchPlan = (projectId?: string, actorId?: string) => request<ProjectPlan>('/gantt', undefined, undefined, undefined, projectId, actorId);
export const previewPlan = (plan: ProjectPlan, body: PlanEditRequest, actorId?: string) => request<PlanPreview>('/schedule/preview', plan.writeToken, body, undefined, plan.project.id, actorId);
export const applyPlan = (plan: ProjectPlan, preview: PlanPreview, key: string, actorId?: string) => request<{ planVersion: number; affectedCount: number }>('/schedule/apply', plan.writeToken, { previewId: preview.id, expectedPlanVersion: preview.basePlanVersion }, key, plan.project.id, actorId);
export const publishBaseline = (plan: ProjectPlan, body: BaselinePublishRequest) => request<PlanBaseline>('/baselines', plan.writeToken, body, undefined, plan.project.id);

export const savePlanOrder = (plan: ProjectPlan, body: PlanOrderRequest, key: string, actorId: string) => request<PlanOrderResult>('/plan/order', plan.writeToken, body, key, plan.project.id, actorId);

export const fetchPlanHistory = (projectId: string, historyId: string) => request<PlanHistory>(`/plan/history/${encodeURIComponent(historyId)}`, undefined, undefined, undefined, projectId);
