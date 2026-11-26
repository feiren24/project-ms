import type { ManagedTask } from './tasks';

/** All progress/rate/ratio values are fractions 0..1 (not percentages); null means unknown. */
export interface AnalyticsFilters { from: string; to: string; workstreamId: string; ownerId: string; baselineId: string; capacityMode: 'unknown' | 'calendar' | 'configured' }
export interface AnalyticsMetric { value: number | null; numerator: number; denominator: number; missing: number; taskIds: string[]; description: string }
export interface PersonnelMetric extends AnalyticsMetric {
  numeratorTaskIds: string[]; denominatorTaskIds: string[]; missingTaskIds: string[];
}
export type PersonnelMetricKey = 'completion' | 'overdue' | 'late' | 'onTime';
export type PersonnelTaskState = 'on_time' | 'late' | 'unknown_completed' | 'overdue' | 'not_overdue' | 'unknown_unfinished';
export interface PersonnelTaskTiming {
  taskId: string; referenceEnd: string | null;
  referenceSource: 'baseline' | 'completion_plan' | 'current_plan';
  state: PersonnelTaskState;
}
export interface PersonnelSummary {
  taskIds: string[];
  metrics: Record<PersonnelMetricKey, PersonnelMetric>;
  counts: Record<'total' | 'done' | 'todo' | 'inProgress' | 'blocked' | 'review' | 'unplanned' | 'missingActual' | 'missingReference', number>;
  groups: Record<'done' | 'todo' | 'inProgress' | 'blocked' | 'review' | 'unplanned' | 'missingActual' | 'missingReference', string[]>;
}
export interface PersonnelMember extends PersonnelSummary {
  id: string | null; name: string;
  availability: 'active' | 'inactive' | 'removed' | 'historical' | 'unassigned';
}
export interface PersonnelAnalysis {
  summary: PersonnelSummary; members: PersonnelMember[]; tasks: PersonnelTaskTiming[];
}
export type AnalyticsTask = Pick<ManagedTask, 'id'|'wbs'|'title'|'workstreamId'|'ownerId'|'owner'|'status'|'progress'|'start'|'end'|'effortHours'|'blocked'|'requiresReview'|'reviewStatus'|'actualEnd'|'parentId'> & { completionPlanEnd: string | null };
export interface AnalyticsDeviation {
  canOpen: boolean;
  taskId: string; title: string; owner: string; workstreamId: string;
  baselineEnd: string | null; currentEnd: string | null; actualEnd: string | null;
  deltaDays: number | null; state: 'unchanged'|'delayed'|'early'|'new'|'cancelled'|'missing'|'unplanned'|'deleted';
}
export interface AnalyticsCapacityCell { week: string; plannedHours: number; availableHours: number | null; ratio: number | null; status: 'unknown'|'empty'|'normal'|'overload'|'conflict'; tasks: Array<{taskId:string;title:string;hours:number}> }
export interface AnalyticsReport {
  detailLevel?: 'summary' | 'full';
  personnel: PersonnelAnalysis;
  mode: 'demo' | 'standard'; metricVersion: string; generatedAt: string; dataAsOf: string; planVersion: number;
  project: {isDemo:boolean;id:string;name:string;start:string;end:string}; filters: AnalyticsFilters;
  options: { workstreams: Array<{id:string;name:string;color:string}>; owners: Array<{id:string;name:string}>; baselines: Array<{id:string;name:string;createdAt:string}> };
  metrics: { completion: AnalyticsMetric; weightedProgress: AnalyticsMetric; estimationCoverage: AnalyticsMetric; onTime: AnalyticsMetric; milestoneAchievement: AnalyticsMetric };
  counts: { total:number;done:number;inProgress:number;todo:number;blocked:number;overdue:number;unplanned:number;review:number;unknownActual:number };
  tasks: AnalyticsTask[];
  workstreams: Array<{id:string;name:string;color:string;total:number;done:number;inProgress:number;todo:number;completion:number|null;weightedProgress:number|null;taskIds:string[]}>;
  milestones: Array<{id:string;title:string;workstreamId:string;owner:string;date:string|null;status:string;achieved:boolean;acceptedAt?:string|null}>;
  trend: { points: Array<{date:string;planned:number|null;actual:number|null;capturedAt:string|null}>; message:string; firstCapturedAt:string|null };
  deviations: AnalyticsDeviation[];
  capacity: { mode:AnalyticsFilters['capacityMode']; label:string; weeks:Array<{start:string;label:string}>; members:Array<{id:string;name:string;cells:AnalyticsCapacityCell[]}>; unallocated:Array<{taskId:string;title:string;reason:string}> };
  warnings: string[];
}
