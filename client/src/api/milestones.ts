import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import { PlanningError } from './planning';
import type { MilestoneWorkspace, MilestoneDraft, MilestoneDelivery, MilestoneMutation, MilestoneWriteResult } from '../../../shared/src/milestones';
async function request<T>(projectId: string, path = '', method = 'GET', workspace?: MilestoneWorkspace, actorId?: string, body?: unknown, key?: string): Promise<T> {
 const response = await sessionFetch(`${projectApi(projectId)}/milestones${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Preview-Token': workspace!.writeToken, 'X-Demo-Actor': actorId!, 'Idempotency-Key': key || crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
 const result = await response.json().catch(() => ({}));
 if (!response.ok) throw new PlanningError(result.error?.message || '里程碑暂时无法读取或保存，请重试。', response.status, result.error?.code);
 return result.data;
}
export const fetchMilestones = (projectId: string) => request<MilestoneWorkspace>(projectId);
export const saveMilestone = (w: MilestoneWorkspace, actor: string, draft: MilestoneDraft, key: string, id?: string, version?: number, reason?: string) => request<MilestoneWriteResult>(w.project.id, id ? `/${encodeURIComponent(id)}` : '', id ? 'PATCH' : 'POST', w, actor, { ...draft, expectedPlanVersion: w.planVersion, ...(id ? { expectedVersion: version, reason } : {}) }, key);
export const saveMilestoneDelivery = (w: MilestoneWorkspace, actor: string, id: string, delivery: MilestoneDelivery, version: number, key: string) => request<MilestoneWriteResult>(w.project.id, `/${encodeURIComponent(id)}/draft`, 'POST', w, actor, { ...delivery, expectedVersion: version, expectedPlanVersion: w.planVersion }, key);
export const transitionMilestone = (w: MilestoneWorkspace, actor: string, id: string, mutation: MilestoneMutation, key: string) => request<MilestoneWriteResult>(w.project.id, `/${encodeURIComponent(id)}/transition`, 'POST', w, actor, mutation, key);
