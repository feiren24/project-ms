import { useAuthStore } from '../stores/auth';
import { visibleActivity, visibleTarget, visibleEvent } from '../utils/module-privacy';
import type { ActivityPage, ActivityItemsPage, ActivityCategory, ActivityRange } from '../../../shared/src/activities';
import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import { PlanningError } from './planning';
export interface ActivityQuery { category?: ActivityCategory | 'all'; range?: ActivityRange; limit?: number; cursor?: string }
async function read<T>(projectId: string, path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await sessionFetch(`${projectApi(projectId)}/activities${path}?${new URLSearchParams(query)}`, { signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || '项目动态暂时无法读取，请重试。', response.status, result.error?.code);
  const capabilities = useAuthStore().capabilities(projectId);
  if (Array.isArray(result.data?.items)) result.data.items = result.data.items.filter((item: { category?: string; type?: string; target?: { kind: string } }) =>
    (!item.category || visibleActivity(item.category, capabilities)) && visibleTarget(item.target?.kind, capabilities) && visibleEvent(item.type || '', item.target?.kind, capabilities));
  return result.data;
}
export function fetchActivities(projectId: string, query: ActivityQuery = {}, signal?: AbortSignal) {
  return read<ActivityPage>(projectId, '', Object.fromEntries(Object.entries(query).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)])), signal);
}
export function fetchActivityItems(projectId: string, id: string, cursor?: string, signal?: AbortSignal) {
  return read<ActivityItemsPage>(projectId, `/${encodeURIComponent(id)}/items`, { limit: '20', ...(cursor ? { cursor } : {}) }, signal);
}
