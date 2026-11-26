import type { MilestoneState } from './milestones';
/** Homepage preview contract. Project nature is explicit; only seed projects contain fictional data. */
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type Priority = 'P0' | 'P1' | 'P2';

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    description: string;
    status: string;
    start: string;
    end: string;
    asOf: string;
    sourceLabel: string;
    isDemo: boolean;
  };
  workstreams: Array<{
    id: string;
    name: string;
    description: string;
    color: string;
    start: string;
    end: string;
    owner: string;
    icon: string;
    active?: boolean;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    workstreamId: string;
    owner: string;
    initials: string;
    status: TaskStatus;
    priority: Priority;
    due: string;
    progress: number;
    blocked: boolean;
  }>;
  milestones: Array<{
    id: string;
    title: string;
    date: string;
    status: 'upcoming' | 'review' | 'done';
    milestoneState?: MilestoneState;
    acceptedAt?: string | null;
    ownerId?: string;
    reviewerId?: string;
    workstreamId: string;
    description: string;
  }>;
  risks: Array<{
    id: string;
    title: string;
    level: 'low' | 'medium' | 'high' | 'critical' | null;
    status?: string;
    reviewDate?: string | null;
    reviewOverdue?: boolean;
    owner: string;
    due: string;
    description: string;
    taskIds: string[];
  }>;
  activities: Array<{
    id: string;
    actor: string;
    initials: string;
    action: string;
    target: string;
    /** UTC ISO 8601 timestamp. Render in Asia/Shanghai. */
    time: string;
  }>;
  summary: {
    totalTasks: number;
    completedTasks: number;
    inProgressTasks: number;
    overdueTasks: number;
    /** Percentage (0–100); null when no tasks exist. */
    completionRate: number | null;
    /** Non-complete milestones from asOf through asOf + 14 days, inclusive. */
    upcomingMilestones: number;
    highRisks: number;
    riskReviewOverdue?: number;
  };
  mode: 'demo' | 'standard';
}

export interface ApiError {
  error: { code: string; message: string };
  requestId: string;
}

/** Public overview omits private management data for collaborative roles. */
export type PublicProjectOverview = Omit<ProjectOverview, 'risks' | 'summary'> & {
  capabilities: import('./permissions').ModuleCapabilities;
  risks?: ProjectOverview['risks'];
  summary: Omit<ProjectOverview['summary'], 'highRisks' | 'riskReviewOverdue'> & {
    highRisks?: number;
    riskReviewOverdue?: number;
  };
};
