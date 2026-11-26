import { reactive, ref } from 'vue';
import { useAuthStore } from './auth';
/** One active project per browser tab. Never persist it across tabs. */
export const projectScope = ref('phase-one');
export const currentProjectId = () => projectScope.value;
export const projectApi = (id = currentProjectId()) => `/api/v1/projects/${encodeURIComponent(id)}`;
export function setProjectScope(id: string) { projectScope.value = id; }
const views = new Map<string, { projectId: string; value: object }>();
export function clearProjectViews(projectIds?: readonly string[]) {
  if (!projectIds) { views.clear(); return; }
  for (const [key, entry] of views) if (projectIds.includes(entry.projectId)) views.delete(key);
}
export function useProjectView<T extends object>(module: string, factory: () => T): T {
  const auth = useAuthStore();
  const key = `${auth.user?.id || 'legacy'}:${currentProjectId()}:${module}`;
  if (!views.has(key)) views.set(key, { projectId: currentProjectId(), value: reactive(factory()) });
  return views.get(key)!.value as T;
}
