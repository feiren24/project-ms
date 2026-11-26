import type { TaskActor } from './tasks';
import type { PlanningCalendar } from './planning';
export interface ProjectMember extends TaskActor {
  active: boolean;
  removedAt?: string | null;
  userId?: string;
  username?: string;
  accountActive?: boolean;
}
export interface PersonalCapacity { memberId: string; hoursPerDay: number | null; exceptions: Record<string, number> }
export interface SettingsEvent { id: string; actor: string; action: string; reason: string; createdAt: string; summary: string }
export interface SettingsWorkspace {
  mode: 'demo' | 'standard'; project: { isDemo: boolean; id: string; name: string; start: string; end: string };
  version: number; planVersion: number; writeToken: string;
  actors: TaskActor[]; members: ProjectMember[]; calendar: PlanningCalendar;
  capacities: PersonalCapacity[]; events: SettingsEvent[];
}
export type SettingsOperation = 'member_create' | 'member_update' | 'calendar' | 'capacity';
export interface SettingsMutation {
  expectedVersion: number; expectedPlanVersion: number; reason?: string;
  member?: { id?: string; name: string; role: TaskActor['role']; active: boolean };
  calendar?: PlanningCalendar;
  capacity?: PersonalCapacity;
}
