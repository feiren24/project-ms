export type ActivityCategory = 'task' | 'plan' | 'risk' | 'project' | 'member' | 'workgroup';
export type ActivityRange = '7d' | '30d' | 'all';
export interface ActivityActor { id: string | null; name: string }
export interface ActivityTarget { kind: string; id: string; name: string; available?: boolean }
export interface ActivityChange { field: string; before: string | number | boolean | null; after: string | number | boolean | null }
export interface ActivityItem { id: string; target: ActivityTarget | null; summary: string; occurredAt: string; historical: boolean; changes: ActivityChange[] }
export interface ActivitySummary { snapshotVersion: number; itemsCursor: string; id: string; type: string; category: ActivityCategory; actor: ActivityActor; occurredAt: string; lastOccurredAt: string; count: number; preview: string[]; historical: boolean; target: ActivityTarget | null; summary: string }
export interface ActivityBackfill { status: 'pending' | 'running' | 'complete' | 'failed'; processedTasks: number; error: string | null }
export interface ActivityPage { items: ActivitySummary[]; nextCursor: string | null; activityVersion: number; backfill: ActivityBackfill }
export interface ActivityItemsPage { items: ActivityItem[]; nextCursor: string | null; activityVersion: number; backfill: ActivityBackfill }
