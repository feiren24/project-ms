import type { AuthSession } from '../../../shared/src/auth';
import { isProjectManager } from '../../../shared/src/permissions';

import type { ModuleCapabilities } from '../../../shared/src/permissions';
export type { ModuleCapabilities } from '../../../shared/src/permissions';
export type PrivateModule = keyof ModuleCapabilities;
export const privateModule = (name: unknown): PrivateModule | undefined => {
  if (name === 'risk' || name === 'risk-detail' || name === 'risks') return 'risks';
  if (name === 'analytics' || name === 'settings') return name;
};
export function projectCapabilities(session: AuthSession | null, projectId: string): ModuleCapabilities {
  const project = session?.projects.find(p => p.id === projectId);
  const supplied = project?.capabilities;
  const management = Boolean(session?.legacyDemo || project && (session?.user?.systemRole === 'admin' || isProjectManager(project.role)));
  return supplied ? { analytics: supplied.analytics === true, risks: supplied.risks === true, settings: supplied.settings === true } : { analytics: management, risks: management, settings: management };
}
export function visibleActivity(category: string, capabilities: ModuleCapabilities): boolean {
  if (category === 'all') return true;
  if (category === 'risk') return capabilities.risks;
  if (category === 'project' || category === 'member') return capabilities.settings;
  return ['task', 'plan', 'workgroup'].includes(category);
}
export function visibleTarget(kind: string | undefined, capabilities: ModuleCapabilities): boolean {
  if (!kind) return true;
  if (['member','calendar','project','settings'].includes(kind)) return capabilities.settings;
  const module = privateModule(kind);
  return !module || capabilities[module];
}

export function visibleEvent(kind: string, target: string | undefined, capabilities: ModuleCapabilities): boolean {
  if (!visibleTarget(target, capabilities)) return false;
  const domains = kind.split(/[._]/);
  if (!capabilities.risks && domains.some(part => ['risk','risks','alert','alerts'].includes(part))) return false;
  if (!capabilities.settings && domains.some(part => ['settings','member','members','capacity','calendar'].includes(part))) return false;
  return true;
}
