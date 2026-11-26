import type { ManagedTask, PersonName, TaskActor, TaskDraft } from './tasks';
import type { ProjectPlan } from './planning';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RiskState = 'identified' | 'assessed' | 'mitigating' | 'monitoring' | 'pending_close' | 'closed';
export type RiskRuleKey = 'overdue' | 'dependency_blocked' | 'blocked_2_days' | 'milestone_forecast_late' | 'capacity_overload' | 'commitment_incomplete';
export interface RiskEvent { id: string; action: string; actor: string; text: string; createdAt: string }
export type RiskResponsibilityIssue = 'owner' | 'closeReviewer';
export interface RiskResponsibilityRequest { expectedVersion: number; ownerId: string; closeReviewerId: string; reason: string }
export interface ManagedRisk {
  /** Computed from current membership; never persisted into the historical snapshot. */
  needsHandover?: boolean; responsibilityIssues?: RiskResponsibilityIssue[];
  id: string; title: string; description: string; workstreamId: string; ownerId: string; owner: string;
  probability: number | null; impact: number | null; score: number | null; level: RiskLevel | null;
  /** Imported DEMO level is kept until human reassessment; never invent its component scores. */
  legacyLevel: RiskLevel | null;
  status: RiskState; occurred: boolean; due: string; reviewDate: string | null;
  response: string; acceptanceReason: string; taskIds: string[]; actionTaskIds: string[];
  sourceAlertId: string | null; closeReviewerId: string | null;
  closure: { reason: string; residualReasons: Record<string, string>; taskVersions: Record<string, number>; submittedBy: string; reviewedById?: string; reviewedAt?: string; selfReview?: boolean } | null;
  version: number; createdAt: string; updatedAt: string; events: RiskEvent[];
}
export interface RiskAlert {
  sourceDeleted?: boolean;
  id: string; rule: RiskRuleKey; ruleVersion: string; objectId: string; title: string; evidence: string;
  workstreamId: string; taskIds: string[]; status: 'open' | 'snoozed' | 'resolved';
  firstTriggeredAt: string; lastTriggeredAt: string; snoozedUntil: string | null; snoozeReason: string;
  linkedRiskId: string | null; version: number; events: RiskEvent[];
}
export interface RuleEvaluation { key: RiskRuleKey; name: string; status: 'evaluated' | 'partial' | 'unknown'; message: string; triggered: number }
export interface AlertCandidate { rule: RiskRuleKey; objectId: string; title: string; evidence: string; workstreamId: string; taskIds: string[] }
export interface RiskEvaluation {
  candidates: AlertCandidate[]; rules: RuleEvaluation[];
  /** A rule or object with unknown inputs must not silently resolve an earlier alert. */
  unknown: Array<{ rule: RiskRuleKey; objectId: string | null }>;
}
export interface RiskRuleInput {
  tasks: ManagedTask[]; plan: ProjectPlan; today: string;
  /** Only confirmed personal capacity may drive automatic overload alerts. No calendar trial. */
  capacity?: Array<{ ownerId: string; owner: string; week: string; plannedHours: number; availableHours: number | null; taskIds: string[] }>;
}
export interface RiskWorkspace {
  mode: 'demo' | 'standard'; project: { isDemo: boolean; id: string; name: string; asOf: string; start: string; end: string };
  today: string; version: number; planVersion: number; writeToken: string; actors: TaskActor[];
  people?: PersonName[];
  /** Active real project managers/admins eligible for assignment, excluding global elevation. */
  responsibilityCandidates: TaskActor[];
  workstreams: Array<{ id: string; name: string; color: string; active?: boolean }>;
  tasks: ManagedTask[]; risks: ManagedRisk[]; alerts: RiskAlert[]; rules: RuleEvaluation[];
  lastEvaluatedAt: string | null; warnings: string[];
}
export interface RiskDraft {
  title: string; description: string; workstreamId: string; ownerId: string;
  probability: number | null; impact: number | null; due: string; reviewDate: string | null;
  response: string; taskIds: string[]; closeReviewerId: string | null;
}
export type RiskAction = 'assess' | 'mitigate' | 'monitor' | 'accept' | 'occur' | 'submit_close' | 'approve_close' | 'reject_close' | 'reopen';
export interface RiskMutation { expectedVersion: number; action: RiskAction; reason?: string; reviewDate?: string; residualReasons?: Record<string, string> }
export interface RiskWriteResult { risk?: ManagedRisk; alert?: RiskAlert; task?: ManagedTask; version: number; planVersion: number }
export interface RiskActionTaskRequest { expectedVersion: number; expectedPlanVersion: number; draft: TaskDraft }
