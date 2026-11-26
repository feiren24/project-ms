import type { ManagedTask } from './tasks';
export interface RecycleEvent { id: string; action: 'delete'|'restore'; actorId: string; actor: string; reason: string; createdAt: string }
export interface RecycledTask { task: ManagedTask; deletedAt: string; deletedBy: string; deletedByName: string; reason: string; history: RecycleEvent[]; canRestore: boolean }
export interface RecycleBlocker { kind: 'child'|'dependency'|'milestone'|'risk'|'parent'|'member'|'workstream'|'calendar'; id: string; title: string; message: string }
export interface RecyclePreview { task: ManagedTask; operation: 'delete'|'restore'; previewToken: string; blockers: RecycleBlocker[]; workstreamChange?: { fromId: string; toId: string; fromName: string; toName: string } }
export interface RecyclePage { items: RecycledTask[]; total: number; page: number; pageSize: number; canRestore: boolean; deletors: Array<{id:string;name:string}> }
