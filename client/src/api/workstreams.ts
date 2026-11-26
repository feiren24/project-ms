import { sessionFetch } from './session-transport';
import { projectApi } from '../stores/project-scope';
import { PlanningError } from './planning';
import type { WorkstreamDraft, WorkstreamWorkspace } from '../../../shared/src/workstreams';

export type WorkstreamOperation = 'create' | 'edit' | 'status' | 'up' | 'down';
export async function fetchWorkstreams(projectId: string, actorId: string, signal?: AbortSignal): Promise<WorkstreamWorkspace> {
  const response = await sessionFetch(projectApi(projectId) + '/workstreams', { signal, headers: { 'X-Demo-Actor': actorId } });
  return read(response);
}
async function read(response: Response): Promise<WorkstreamWorkspace> {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || '工作分组暂时无法读取或保存，请重试。', response.status, result.error?.code);
  return result.data;
}
export async function saveWorkstream(workspace: WorkstreamWorkspace, actorId: string, operation: WorkstreamOperation, id: string | undefined, reason: string | undefined, key: string, draft?: WorkstreamDraft, active?: boolean): Promise<WorkstreamWorkspace> {
  const path = operation === 'create' ? '' : `/${encodeURIComponent(id!)}` + (operation === 'edit' ? '' : operation === 'status' ? '/status' : '/move');
  const body = { expectedVersion: workspace.version, expectedPlanVersion: workspace.planVersion, reason,
    ...(operation === 'create' || operation === 'edit' ? { workstream: draft } : operation === 'status' ? { active } : { direction: operation }) };
  return read(await sessionFetch(projectApi(workspace.projectId) + '/workstreams' + path, {
    method: operation === 'edit' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': workspace.writeToken, 'X-Demo-Actor': actorId, 'Idempotency-Key': key }, body: JSON.stringify(body),
  }));
}
