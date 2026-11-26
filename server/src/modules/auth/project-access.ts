import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readActors } from '../settings/store.js';

export function managementCapabilities(allowed: boolean) {
  return { analytics: allowed, risks: allowed, settings: allowed };
}

// Authenticated requests are populated by authorizeBusiness, before any handler.
// Legacy fixture access must be explicitly populated by the fixture setup.
const access = new WeakMap<FastifyRequest, boolean>();
export function setRequestManagementAccess(request: FastifyRequest, allowed: boolean) { access.set(request, allowed); }
export function requestCanViewManagement(request: FastifyRequest): boolean { return access.get(request) ?? false; }

/** Uses current account status and global-admin elevation, including linked admins. */
export function memberCanViewManagement(db: Database.Database, projectId: string, memberId: unknown): boolean {
  return readActors(db, projectId).some(actor => actor.id === memberId && isProjectManager(actor.role));
}

/** Shared plan history is a collaboration feed, not a settings audit endpoint. */
export const collaborationPlanActions = ['schedule', 'baseline', 'order', '应用计划调整', '发布计划基线', '调整任务顺序', '调整任务工作分组'] as const;
export function publicPlanHistory(item: { action?: string }): boolean {
  return collaborationPlanActions.some(action => action === item.action) || Boolean(item.action?.startsWith('里程碑：'));
}
