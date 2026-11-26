import type Database from 'better-sqlite3';
import { listRisks } from '../risks/repository.js';
import { shanghaiDate } from '../analytics/dates.js';
import type { ProjectOverview } from '../../../../shared/src/contracts.js';
import type { DemoSnapshot } from '../../db/demo-data.js';
import { readProjectSnapshot } from '../projects/context.js';

type TaskRow = Omit<ProjectOverview['tasks'][number], 'blocked'> & { blocked: number };

export function readProjectOverview(database: Database.Database, projectId: string, now = new Date()): ProjectOverview | null {
  const snapshot = readProjectSnapshot(database, projectId, now) as Omit<DemoSnapshot, 'tasks'> | null;
  if (!snapshot) return null;
  const rows = database.prepare(`SELECT id, title, workstream_id AS workstreamId, owner, initials,
    status, priority, due, progress, blocked FROM homepage_tasks WHERE project_id = ? ORDER BY position, id`).all(projectId) as TaskRow[];
  const hasTaskMeta = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_meta'").get();
  const excluded = new Set<string>();
  if (hasTaskMeta) for (const meta of database.prepare('SELECT task_id, meta_json FROM task_meta WHERE project_id = ?').all(projectId) as { task_id: string; meta_json: string }[]) {
    const data = JSON.parse(meta.meta_json);
    if (data.cancelled || data.taskKind === 'summary') excluded.add(meta.task_id);
    if (data.parentId) excluded.add(data.parentId);
  }
  const tasks = rows.filter(task => !excluded.has(task.id)).map((task) => ({ ...task, blocked: Boolean(task.blocked) }));
  const completedTasks = tasks.filter((task) => task.status === 'done').length;
  const endOfWindow = new Date(`${snapshot.project.asOf}T00:00:00Z`);
  endOfWindow.setUTCDate(endOfWindow.getUTCDate() + 14);
  const until = endOfWindow.toISOString().slice(0, 10);
  const hasRisks = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='risk_records'").get();
  const risks: ProjectOverview['risks'] = hasRisks ? listRisks(database, projectId).map(risk => ({ id: risk.id, title: risk.title, level: risk.level, owner: risk.owner, due: risk.due, description: risk.description, taskIds: risk.taskIds, status: risk.status, reviewDate: risk.reviewDate, reviewOverdue: risk.status !== 'closed' && Boolean(risk.reviewDate && risk.reviewDate < shanghaiDate(now)) })) : snapshot.risks;
  const riskReviewOverdue = risks.filter(risk => risk.reviewOverdue).length;
  return {
    ...snapshot,
    activities: [],
    risks,
    tasks,
    summary: {
      totalTasks: tasks.length,
      completedTasks,
      inProgressTasks: tasks.filter((task) => task.status === 'in_progress').length,
      overdueTasks: tasks.filter((task) => task.status !== 'done' && task.due && task.due < snapshot.project.asOf).length,
      completionRate: tasks.length ? completedTasks / tasks.length * 100 : null,
      upcomingMilestones: snapshot.milestones.filter((milestone) => milestone.status !== 'done' && milestone.milestoneState !== 'cancelled' && milestone.date >= snapshot.project.asOf && milestone.date <= until).length,
      highRisks: risks.filter((risk) => risk.status !== 'closed' && (risk.level === 'high' || risk.level === 'critical')).length,
      ...(riskReviewOverdue ? { riskReviewOverdue } : {}),
    },
  };
}
