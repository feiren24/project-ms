import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { registerAnalyticsRoutes } from '../../server/src/modules/analytics/routes.js';

test('snapshot sweep enumeration errors are logged and never reject readiness or escape periodic callbacks', async () => {
  const app = Fastify(); const errorLog = vi.spyOn(app.log,'error');
  const database = { exec: vi.fn(), prepare: vi.fn(() => { throw new Error('simulated unavailable database'); }) } as unknown as Database.Database;
  registerAnalyticsRoutes(app,database,() => new Date('2026-09-07T00:00:00Z'),20);
  try {
    await app.ready();
    await new Promise(resolve => setTimeout(resolve,55));
    expect(errorLog.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(errorLog.mock.calls[0]![1]).toBe('Analytics snapshot sweep failed; successful writes are retained');
  } finally { await app.close(); }
  const count = errorLog.mock.calls.length; await new Promise(resolve => setTimeout(resolve,40)); expect(errorLog.mock.calls).toHaveLength(count);
});
