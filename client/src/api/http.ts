import { useAuthStore } from '../stores/auth';
import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import type { PublicProjectOverview as ProjectOverview } from '../../../shared/src/contracts';
export async function fetchOverview(signal?: AbortSignal): Promise<ProjectOverview> {
  const response = await sessionFetch(projectApi() + '/overview', { signal });
  if (!response.ok) throw new Error('暂时无法读取项目数据，请稍后重试。');
  const data: ProjectOverview = (await response.json()).data;
  const auth = useAuthStore();
  if (data.capabilities) auth.updateCapabilities(data.project.id, data.capabilities);
  if (!auth.capabilities(data.project.id).risks) {
    delete data.risks; delete data.summary.highRisks; delete data.summary.riskReviewOverdue;
  }
  return data;
}
