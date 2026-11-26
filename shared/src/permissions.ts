/** Project roles are independent of global account administration. */
export type ProjectRole = 'manager' | 'project_admin' | 'member' | 'viewer';
export const projectRoleLabels: Record<ProjectRole, string> = { manager: '项目负责人', project_admin: '项目管理员', member: '项目成员', viewer: '只读成员' };
export const projectRoleDescriptions: Record<ProjectRole, string> = {
  manager: '承担项目责任，拥有全部项目操作权限。',
  project_admin: '管理任务、计划、风险、成员与设置，拥有全部项目操作权限。',
  member: '可创建并分派任务、执行自己的任务，以及验收指定成果。',
  viewer: '仅可浏览、搜索和筛选项目，不可修改、导出或标记通知已读。',
};
export const isProjectManager = (role?: string): boolean => role === 'manager' || role === 'project_admin';
export const canWriteProject = (role?: string): boolean => isProjectManager(role) || role === 'member';
export function canReviewTask(role: string | undefined, actorId: string, ownerId: string, submitterId: string, reviewerId: string | null): boolean {
  return isProjectManager(role) || (role === 'member' && actorId === reviewerId && actorId !== ownerId && actorId !== submitterId);
}

/** Server-computed visibility of project management modules. */
export interface ModuleCapabilities { analytics: boolean; risks: boolean; settings: boolean }
