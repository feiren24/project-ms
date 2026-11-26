import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import type { SettingsWorkspace, SettingsMutation, SettingsOperation } from '../../../shared/src/settings';
import { PlanningError } from './planning';
async function request(path = '', workspace?: SettingsWorkspace, actorId?: string, body?: SettingsMutation, key?: string, projectId?: string): Promise<SettingsWorkspace> {
  const response = await sessionFetch(projectApi(workspace?.project.id || projectId) + '/settings' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-Preview-Token': workspace!.writeToken, 'X-Demo-Actor': actorId!, 'Idempotency-Key': key! } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || '设置暂时无法读取或保存，请重试。', response.status, result.error?.code);
  return result.data;
}
export const fetchSettings = (projectId?: string) => request('', undefined, undefined, undefined, undefined, projectId);
export const saveSettings = (workspace: SettingsWorkspace, actorId: string, operation: SettingsOperation, body: SettingsMutation, key: string) => request(`/${operation}`, workspace, actorId, body, key);
