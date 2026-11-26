import type Database from 'better-sqlite3';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import type { ManagedRisk, RiskResponsibilityIssue } from '../../../../shared/src/risks.js';
import type { TaskActor } from '../../../../shared/src/tasks.js';
import { readActors, readMembers } from '../settings/store.js';
import { requireValue } from '../planning/errors.js';

/** Operation authority can be elevated globally; assignment uses actual staffing roles. */
export function readRiskResponsibilityCandidates(db: Database.Database, projectId: string): TaskActor[] {
  const assignable = new Set(readActors(db, projectId).filter(actor => actor.assignable !== false).map(actor => actor.id));
  return readMembers(db, projectId)
    .filter(member => member.active && !member.removedAt && member.accountActive !== false && isProjectManager(member.role) && assignable.has(member.id))
    .map(({ id, name, role }) => ({ id, name, role }));
}
export function riskResponsibilityIssues(risk: Pick<ManagedRisk, 'ownerId' | 'closeReviewerId'>, candidates: TaskActor[]): RiskResponsibilityIssue[] {
  const issues: RiskResponsibilityIssue[] = [];
  if (!candidates.some(member => member.id === risk.ownerId)) issues.push('owner');
  // Null retains the existing default management-review policy, without writing an assignment on read.
  if (risk.closeReviewerId === null ? !candidates.length : !candidates.some(member => member.id === risk.closeReviewerId)) issues.push('closeReviewer');
  return issues;
}
export function projectRiskResponsibilities(risk: ManagedRisk, candidates: TaskActor[]): ManagedRisk {
  const responsibilityIssues = riskResponsibilityIssues(risk, candidates);
  return { ...risk, responsibilityIssues, needsHandover: risk.status !== 'closed' && responsibilityIssues.length > 0 };
}
export function requireRiskResponsibilities(risk: ManagedRisk, candidates: TaskActor[]) {
  requireValue(!riskResponsibilityIssues(risk, candidates).length, 'INACTIVE_RISK_RESPONSIBILITY', '风险责任人或关闭复核人已不符合管理职责要求，请先移交给已启用的项目负责人或项目管理员。');
}
