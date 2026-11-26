import { useAuthStore } from '../stores/auth';
import { visibleEvent } from '../utils/module-privacy';
import { currentProjectId } from '../stores/project-scope';
import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import type { NotificationWorkspace, ProjectRevision } from '../../../shared/src/notifications';
import { PlanningError } from './planning';
async function request<T>(path: string, options: { signal?: AbortSignal; workspace?: NotificationWorkspace; body?: unknown; key?: string } = {}): Promise<T> {
  const write = options.body !== undefined;
  const response = await sessionFetch(projectApi(options.workspace?.project.id) + path, {
    method: write ? 'POST' : 'GET', signal: options.signal,
    headers: write ? { 'Content-Type': 'application/json', 'X-Preview-Token': options.workspace!.writeToken, 'X-Demo-Actor': options.workspace!.actorId, 'Idempotency-Key': options.key! } : {},
    body: write ? JSON.stringify(options.body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || '站内通知暂时无法读取或保存，请重试。', response.status, result.error?.code);
  const capabilities = useAuthStore().capabilities(options.workspace?.project.id || currentProjectId());
  if (Array.isArray(result.data?.notifications)) {
    result.data.notifications = result.data.notifications.filter((item: { kind: string; target: { kind: string } }) => visibleEvent(item.kind, item.target.kind, capabilities));
    result.data.unread = result.data.notifications.filter((item: { readAt: string | null }) => !item.readAt).length;
    if (!capabilities.settings) { result.data.jobs = []; result.data.canManageJobs = false; }
  }
  return result.data;
}
export const fetchNotifications = (actorId: string, signal?: AbortSignal) => request<NotificationWorkspace>(`/notifications?actorId=${encodeURIComponent(actorId)}`, { signal });
export const fetchProjectRevision = (actorId: string, signal?: AbortSignal) => request<ProjectRevision>(`/revision?actorId=${encodeURIComponent(actorId)}`, { signal });
export const markNotificationsRead = (workspace: NotificationWorkspace, body: { ids: string[] } | { all: true }, key: string) => request<NotificationWorkspace>('/notifications/read', { workspace, body, key });
export const retryNotificationJob = (workspace: NotificationWorkspace, jobId: string, key: string) => request<NotificationWorkspace>(`/notifications/jobs/${encodeURIComponent(jobId)}/retry`, { workspace, body: {}, key });
