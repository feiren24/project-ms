import type { TaskActor, ManagedTask } from './tasks';
import type { PlanBaseline, PlanDependency, PlanningCalendar } from './planning';

export type MilestoneState = 'draft' | 'submitted' | 'accepted' | 'rejected' | 'needs_review' | 'cancelled' | 'legacy_achieved';
export interface MilestoneCriterion { id: string; title: string; kind: 'task' | 'evidence'; taskId: string | null }
export interface MilestoneEvidence { criterionId: string; description: string; links: string[]; declared: boolean }
export interface MilestoneDraft { title: string; description: string; workstreamId: string; ownerId: string; reviewerId: string; date: string | null; criteria: MilestoneCriterion[] }
export interface MilestoneDelivery { summary: string; links: string[]; evidence: MilestoneEvidence[] }
export interface MilestoneEvent { id: string; action: string; actorId: string; actor: string; text: string; createdAt: string }
export interface MilestoneSubmission {
 id: string; submitterId: string; createdAt: string; snapshot: MilestoneDraft & MilestoneDelivery;
 taskVersions: Record<string, string>; invalidatedAt: string | null;
 reviews: Array<{ id: string; actorId: string; actor: string; decision: 'accept' | 'reject'; comment: string; failedCriterionIds: string[]; checkedCriterionIds: string[]; selfReview: boolean; createdAt: string }>;
}
export interface Milestone extends MilestoneDraft {
 id: string; wbs: string; version: number; state: MilestoneState; delivery: MilestoneDelivery;
 acceptedAt: string | null; legacyStatus: string | null; createdAt: string; updatedAt: string;
 submissions: MilestoneSubmission[]; events: MilestoneEvent[];
 readiness: Array<{ criterionId: string; ready: boolean; reason: string }>;
 canSubmit: boolean; missing: string[]; owner: string; reviewer: string;
 forecast: { date: string | null; explanation: string; taskIds: string[] };
}
export interface MilestoneWorkspace {
 project: { id: string; name: string; isDemo: boolean; asOf: string; start: string; end: string };
 planVersion: number; writeToken: string; actors: TaskActor[]; milestones: Milestone[];
 workstreams: Array<{ id: string; name: string; color: string; active?: boolean }>;
 tasks: ManagedTask[]; dependencies: PlanDependency[]; baselines: PlanBaseline[]; calendar: PlanningCalendar;
}
export type MilestoneAction = 'submit' | 'withdraw' | 'accept' | 'reject' | 'cancel' | 'restore' | 'reopen';
export interface MilestoneMutation {
 expectedVersion: number; expectedPlanVersion: number; action: MilestoneAction; reason?: string;
 submissionId?: string; checkedCriterionIds?: string[]; failedCriterionIds?: string[];
}
export interface MilestoneWriteResult { milestone: Milestone; planVersion: number }
export const milestoneStateLabels: Record<MilestoneState, string> = {
 draft: '待提交', submitted: '待验收', accepted: '已验收', rejected: '已退回', needs_review: '需复核', cancelled: '已取消', legacy_achieved: '历史达成，待补验收',
};
