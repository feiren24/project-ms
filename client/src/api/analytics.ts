import { projectApi } from '../stores/project-scope';
import { sessionFetch } from './session-transport';
import type { AnalyticsFilters, AnalyticsReport } from '../../../shared/src/analytics';

export async function fetchAnalytics(filters: Partial<AnalyticsFilters> = {}, signal?: AbortSignal, detail: 'summary'|'full' = 'full'): Promise<AnalyticsReport> {
  const query = new URLSearchParams({detail});
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const response = await sessionFetch(`${projectApi()}/analytics?${query}`, { signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.message || '统计数据暂时无法读取，请重试。');
  return result.data as AnalyticsReport;
}
