import type { ProjectRole } from './permissions';
import type { PlanDependency } from './planning';
export type TaskState = 'todo' | 'in_progress' | 'done' | 'cancelled';
export interface TaskActor { id: string; name: string; role: ProjectRole; assignable?: boolean }
/** Display-only identity directory; never use this for permissions or assignments. */
export interface PersonName { id: string; name: string }
export interface TaskEvent { id: string; taskId: string; actor: string; action: string; text: string; createdAt: string }
export interface TaskSubmission { snapshot?: { title: string; description: string; acceptanceCriteria: string; ownerId: string }; id: string; taskId: string; version: number; submitterId: string; reviewerId: string; evidence: string; status: 'submitted' | 'accepted' | 'rejected' | 'invalidated'; comment: string; createdAt: string; reviewedAt: string | null; reviewedById?: string; selfReview?: boolean }
export interface ManagedTask {
  creatorId?: string | null;
  creatorName?: string | null;
  canDelete?: boolean;
  parentTitle?: string;
  taskKind?: 'execution' | 'summary';
  originalWork?: boolean;
  parentEligibility?: { mode: 'summary' | 'convert' | 'blocked'; reason: string };
  isContainer?: boolean;
  id: string; wbs: string; workstreamId: string; parentId: string | null; title: string; description: string;
  ownerId: string; owner: string; priority: 'P0' | 'P1' | 'P2'; status: TaskState; progress: number;
  start: string | null; end: string | null; effortHours: number | null; blocked: boolean; blockReason: string;
  requiresReview: boolean; reviewerId: string | null; acceptanceCriteria: string; evidence: string;
  reviewStatus: 'none' | 'submitted' | 'accepted' | 'rejected' | 'needs_review';
  completionPlanEnd?: string | null;
  actualStart: string | null; actualEnd: string | null; version: number; createdAt: string; updatedAt: string;
  events: TaskEvent[]; submissions: TaskSubmission[];
}
export interface TaskWorkspace {
  /** Actual active project manager/admin membership; excludes global elevation. */
  canChangeWorkstream?: boolean;
  mode: 'demo' | 'standard'; project: { isDemo: boolean; id: string; name: string; asOf: string; start: string; end: string };
  structureVersion?: number;
  planVersion: number; writeToken: string; actors: TaskActor[];
  people?: PersonName[];
  workstreams: Array<{ id: string; name: string; color: string; active?: boolean }>;
  tasks: ManagedTask[]; dependencies: PlanDependency[];
}
export interface TaskPage extends TaskWorkspace {
  total: number; page: number; pageSize: number;
  scopeCounts: { all: number; mine: number; review: number };
  summary: { active: number; late: number; submitted: number; blocked: number };
  boardCounts: Record<string, number>;
}
export interface TaskDraft {
  title: string; description: string; workstreamId: string; parentId: string | null; ownerId: string;
  priority: 'P0' | 'P1' | 'P2'; effortHours: number | null;
  requiresReview: boolean; reviewerId: string | null; acceptanceCriteria: string; evidence: string;
  /** Dates only at creation; existing dates use the Gantt preview/apply transaction. */
  start?: string | null; end?: string | null;
}
export type TaskAction = 'start' | 'complete' | 'cancel' | 'reopen' | 'block' | 'unblock' | 'progress' | 'submit' | 'accept' | 'reject';
export interface TaskMutation { expectedStructureVersion?: number; expectedVersion: number; expectedPlanVersion: number; reason?: string; action: TaskAction; progress?: number; evidence?: string; submissionId?: string }
export interface ParentPreview {
  mode: 'summary' | 'convert'; parent: ManagedTask;
  expectedPlanVersion: number; expectedParentVersion: number;
  executionCountDelta: number; retained: string[];
}
export interface ParentConfirmation { confirmParentConversion: true; expectedParentVersion: number }
export interface WorkstreamChangePreview {
  workstreamId: string;
  previewToken: string;
  sourceWorkstreamId: string;
  tasks: Array<Pick<ManagedTask, 'id' | 'title' | 'status' | 'reviewStatus' | 'taskKind'>>;
}
export interface TaskWriteResult { task: ManagedTask; planVersion: number; parentTask?: ManagedTask; reparentedTaskId?: string }
