import { sessionFetch } from './session-transport';
import { PlanningError } from './planning';
import { projectApi } from '../stores/project-scope';
import type { ProjectInfo, ProjectDirectory, ProjectCreate, ProjectUpdate, MembershipWorkspace, MembershipCreate } from '../../../shared/src/projects';
async function request<T>(url: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const response = await sessionFetch(url, { method, headers: body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key || crypto.randomUUID() } : {}, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(error => { if (error instanceof Error && error.name === 'AbortError') throw error; return {}; });
  if (!response.ok) throw new PlanningError(result.error?.message || '项目操作未完成，请重试。', response.status, result.error?.code);
  return result.data;
}
export const fetchProjects = () => request<ProjectDirectory>('/api/v1/projects');
export const createProject = (body: ProjectCreate, key: string) => request<ProjectInfo>('/api/v1/projects', 'POST', body, key);
export const fetchProject = (id: string) => request<ProjectInfo>(projectApi(id));
export const updateProject = (id: string, body: ProjectUpdate, key: string) => request<ProjectInfo>(projectApi(id), 'PATCH', body, key);
export const fetchMemberships = (id: string) => request<MembershipWorkspace>(projectApi(id) + '/memberships');
export const addMembership = (id: string, body: MembershipCreate, key: string) => request<MembershipWorkspace>(projectApi(id) + '/memberships', 'POST', body, key);

export const previewMembershipRemoval = (id: string, memberId: string) => request<import('../../../shared/src/projects').MembershipRemovalPreview>(projectApi(id) + `/memberships/${encodeURIComponent(memberId)}/removal-preview`);
export const removeMembership = (id: string, memberId: string, body: import('../../../shared/src/projects').MembershipRemove, key: string) => request<MembershipWorkspace>(projectApi(id) + `/memberships/${encodeURIComponent(memberId)}/remove`, 'POST', body, key);
