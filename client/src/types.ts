import type { ActivitySummary } from '../../shared/src/activities';
export type DetailKind = 'tasks' | 'risks' | 'milestones' | 'workstream' | 'plan' | 'goals' | 'activity' | 'search' | 'project' | 'attention';
export interface DetailRequest { kind: DetailKind; title: string; filter?: string; activity?: ActivitySummary }
