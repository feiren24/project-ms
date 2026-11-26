import type { ProjectMember } from './settings.js';
import type { TaskActor } from './tasks.js';

export interface ProjectInfo {
  id: string;
  name: string;
  goal: string;
  start: string;
  end: string;
  version: number;
  memberId: string;
  role: TaskActor['role'];
  isDemo: boolean;
}

export interface ProjectDirectory {
  projects: ProjectInfo[];
  canCreate: boolean;
}

export interface ProjectCreate {
  name: string;
  goal: string;
  start: string;
  end: string;
}

export interface ProjectUpdate extends ProjectCreate {
  expectedVersion: number;
  expectedPlanVersion: number;
  reason?: string;
}

export interface MembershipWorkspace {
  projectId: string;
  version: number;
  planVersion: number;
  members: ProjectMember[];
  accounts: Array<{ id: string; username: string; name: string }>;
  canManage: boolean;
  canLinkLegacy: boolean;
}

export interface MembershipCreate {
  expectedVersion: number;
  expectedPlanVersion: number;
  userId: string;
  role: TaskActor['role'];
  legacyMemberId?: string;
  reason?: string;
}

export interface MembershipRemovalPreview {
  projectId: string; memberId: string; version: number; planVersion: number; canRemove: boolean;
  blockers: Array<{ kind: 'task' | 'milestone' | 'review' | 'risk' | 'workstream' | 'protection'; id: string; title: string; message: string }>;
}
export interface MembershipRemove { expectedVersion: number; expectedPlanVersion: number; reason: string }
