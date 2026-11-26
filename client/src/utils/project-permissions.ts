import { canWriteProject } from '../../../shared/src/permissions';
import { fetchProject } from '../api/projects';
import { useAuthStore } from '../stores/auth';
/** CSV is generated locally, so always revalidate membership before downloading. */
export async function verifyProjectExportAccess(projectId: string, module?: 'analytics'): Promise<void> {
  const auth = useAuthStore();
  if (auth.session?.legacyDemo) return;
  const userId = auth.user?.id;
  if (module) {
    await auth.refreshForRecovery();
    if (!auth.capabilities(projectId)[module]) throw new Error('当前角色无权导出统计分析。');
  }
  const access = await fetchProject(projectId);
  if (!userId || auth.user?.id !== userId || auth.reauthRequired) throw new Error('登录状态已变化，请重新核对后导出。');
  const project = auth.session?.projects.find(p => p.id === projectId);
  if (project) Object.assign(project, { role: access.role, capabilities: project.role === access.role ? project.capabilities : undefined });
  if (!canWriteProject(access.role)) throw new Error('当前角色仅可浏览项目，不能导出数据。');
}
