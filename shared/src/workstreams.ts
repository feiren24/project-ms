import type { TaskActor } from './tasks';

export type WorkstreamColor = 'blue' | 'cyan' | 'purple' | 'orange' | 'green' | 'slate';

export interface ManagedWorkstream {
  id: string;
  name: string;
  description: string;
  ownerId: string | null;
  owner: string | null;
  color: WorkstreamColor;
  position: number;
  active: boolean;
  version: number;
  taskCount: number;
  unfinishedCount: number;
}

export interface WorkstreamEvent {
  id: string;
  workstreamId: string;
  action: string;
  actor: string;
  reason: string;
  createdAt: string;
}

export interface WorkstreamWorkspace {
  mode: 'demo' | 'standard';
  project: { id: string; name: string; isDemo: boolean };
  projectId: string;
  version: number;
  planVersion: number;
  writeToken: string;
  canManage: boolean;
  actors: TaskActor[];
  workstreams: ManagedWorkstream[];
  history: WorkstreamEvent[];
}

export interface WorkstreamDraft {
  name: string;
  description: string;
  ownerId: string | null;
  color: WorkstreamColor;
}

export interface WorkstreamWrite {
  expectedVersion: number;
  expectedPlanVersion: number;
  reason?: string;
}
