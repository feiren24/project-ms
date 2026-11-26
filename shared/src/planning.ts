import type { MilestoneCriterion, MilestoneState } from './milestones';
/** Local DEMO planning contract; not a production authorization boundary. */
export interface PlanningCalendar {
  weekdays: number[];
  hoursPerDay: number;
  confirmed: boolean;
  exceptions: Record<string, boolean>;
}
export interface PlanNode {
  id: string;
  parentId: string | null;
  workstreamId: string;
  wbs: string;
  kind: 'group' | 'task' | 'milestone' | 'gap';
  /** Present for actual tasks, including summary nodes rendered as groups. */
  taskKind?: 'execution' | 'summary';
  title: string;
  description: string;
  owner: string;
  color: string;
  status: 'todo' | 'in_progress' | 'done' | 'review';
  start: string | null;
  end: string | null;
  durationDays: number | null;
  effortHours: number | null;
  progress: number;
  blocked: boolean;
  milestoneState?: MilestoneState;
  acceptedAt?: string | null;
  ownerId?: string;
  reviewerId?: string;
}
export interface PlanDependency { predecessorId: string; successorId: string; type: 'FS'; lagDays: number }
export interface PlanIssue {
  id: string;
  code: string;
  objectId: string;
  title: string;
  description: string;
  severity: 'warning' | 'error';
}
export interface BaselineEntry { taskId: string; start: string | null; end: string | null; effortHours: number | null; owner: string; milestone?: { ownerId: string; reviewerId: string; description: string; criteria: MilestoneCriterion[]; state: MilestoneState; acceptedAt: string | null } }
export interface PlanBaseline {
  id: string; name: string; createdAt: string; actor: string; reason: string;
  entries: BaselineEntry[]; dependencies: PlanDependency[]; calendar: PlanningCalendar;
  excludedIds: string[]; demo: boolean;
}
export interface PlanHistory {
  orders?: Array<{ parentId: string; before: string[]; after: string[] }>;
  id: string; action: string; actor: string; reason: string; createdAt: string; affectedCount: number;
}
export interface PlanSiblingOrder { parentId: string; nodeIds: string[] }
export interface PlanOrderRequest { expectedOrderVersion: number; orders: PlanSiblingOrder[] }
export interface PlanOrderResult { orderVersion: number; affectedCount: number }
export interface ProjectPlan {
  /** Actual active project membership, independent of global administrator elevation. */
  canEditSchedule?: boolean;
  mode: 'demo' | 'standard';
  project: { isDemo: boolean; id: string; name: string; start: string; end: string; asOf: string };
  planVersion: number;
  orderVersion: number;
  siblingOrders: PlanSiblingOrder[];
  writeToken: string;
  calendar: PlanningCalendar;
  nodes: PlanNode[];
  dependencies: PlanDependency[];
  baselines: PlanBaseline[];
  issues: PlanIssue[];
  criticalIds: string[];
  criticalCoverage: { complete: boolean; message: string };
  history: PlanHistory[];
}
export interface PlanEditRequest {
  /** Defaults to schedule; relationships_only never changes persisted dates. */
  calculation?: 'schedule' | 'relationships_only';
  expectedPlanVersion: number;
  reason?: string;
  changes: Array<{ taskId: string; start: string; end: string }>;
  /** When present, replaces all incoming edges of exactly dependencyTargetId. */
  dependencyTargetId?: string;
  incomingDependencies?: Array<{ predecessorId: string; lagDays: number }>;
  mode: 'push_successors' | 'earliest_start';
}
export interface PlanChange {
  taskId: string; title: string; kind: 'task' | 'milestone';
  previousStart: string | null; previousEnd: string | null;
  start: string; end: string; shiftDays: number; direct: boolean;
}
export interface PlanPreview {
  calculation?: 'schedule' | 'relationships_only';
  id: string; basePlanVersion: number; expiresAt: string; reason: string;
  changes: PlanChange[];
  issues: PlanIssue[];
  dependencies: PlanDependency[];
  dependencyChanged: boolean;
  canApply: boolean;
  affectedMilestoneIds: string[];
}
export interface BaselinePublishRequest {
  expectedPlanVersion: number; name: string; reason: string;
  calendarConfirmed: boolean; excludedIds: string[]; exclusionReason: string;
}
