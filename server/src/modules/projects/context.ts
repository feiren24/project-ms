import { readMilestoneRecords } from '../milestones/store.js';
import type Database from 'better-sqlite3';
import type { ProjectOverview } from '../../../../shared/src/contracts.js';
import { shanghaiDate } from '../analytics/dates.js';

type ProjectSnapshot = Omit<ProjectOverview, 'summary' | 'tasks'>;

/** Only explicit booleans override the legacy phase-one seed identity. */
export function projectIsDemo(project: { isDemo?: unknown }, projectId: string): boolean {
  return typeof project.isDemo === 'boolean' ? project.isDemo : projectId === 'phase-one';
}
export function projectSourceLabel(isDemo: boolean): string {
  return isDemo ? 'DEMO · 示例项目，包含虚构任务、成员与进度' : '项目数据保存在运行本系统的设备';
}
/** Normalize response metadata only; stored history and baseline provenance stay immutable. */
export function readProjectSnapshot(db: Database.Database, projectId: string, now = new Date()): ProjectSnapshot | null {
  const row = db.prepare('SELECT snapshot_json FROM homepage_projects WHERE id=?').get(projectId) as { snapshot_json: string } | undefined;
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot_json) as ProjectSnapshot;
  snapshot.activities = [];
  snapshot.project.isDemo = projectIsDemo(snapshot.project, projectId);
  snapshot.mode = snapshot.project.isDemo ? 'demo' : 'standard';
  snapshot.project.sourceLabel = projectSourceLabel(snapshot.project.isDemo);
  if (!snapshot.project.isDemo) snapshot.project.asOf = shanghaiDate(now);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='milestone_records'").get()) {
    snapshot.milestones = readMilestoneRecords(db, projectId).map(record => ({
      id: record.id, title: record.title, description: record.description, workstreamId: record.workstreamId,
      date: record.date ?? '', milestoneState: record.state, acceptedAt: record.acceptedAt,
      ownerId: record.ownerId, reviewerId: record.reviewerId,
      status: record.state === 'accepted' && record.acceptedAt ? 'done' : ['submitted','needs_review','legacy_achieved','rejected'].includes(record.state) ? 'review' : 'upcoming',
    }));
  }
  return snapshot;
}
