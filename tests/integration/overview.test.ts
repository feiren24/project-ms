import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLegacyApp as buildApp } from '../helpers/legacy-app.js';
import type { ProjectOverview } from '../../shared/src/contracts.js';

describe('read-only homepage overview', () => {
  let directory: string;
  let dbPath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'goodwork-homepage-'));
    dbPath = join(directory, 'overview.sqlite');
    app = buildApp({ dbPath });
  });

  afterEach(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function overview() {
    const response = await app.inject('/api/v1/projects/phase-one/overview');
    expect(response.statusCode).toBe(200);
    return response.json<{ data: ProjectOverview }>().data;
  }

  test('returns a clearly labeled fictional snapshot with internally consistent task metrics', async () => {
    const data = await overview();
    expect(data.mode).toBe('demo');
    expect(data.project).toMatchObject({ start: '2026-09-07', end: '2026-12-31', asOf: '2026-09-21' });
    expect(data.project.sourceLabel).toMatch(/DEMO.*虚构/);
    expect(data.summary).toEqual({
      totalTasks: 48, completedTasks: 18, inProgressTasks: 16, overdueTasks: 4,
      completionRate: 37.5, upcomingMilestones: 4, highRisks: 3,
    });
    expect(data.summary.totalTasks).toBe(data.tasks.length);
    expect(data.summary.completedTasks).toBe(data.tasks.filter((task) => task.status === 'done').length);
    expect(data.summary.inProgressTasks).toBe(data.tasks.filter((task) => task.status === 'in_progress').length);
    expect(data.tasks.filter((task) => task.status === 'todo')).toHaveLength(14);
    expect(data.summary.overdueTasks).toBe(data.tasks.filter((task) => task.status !== 'done' && task.due < data.project.asOf).length);
    expect(data.summary.highRisks).toBe(data.risks.filter((risk) => risk.level === 'high').length);
    expect(data.summary.upcomingMilestones).toBe(data.milestones.filter((milestone) => milestone.status !== 'done' && milestone.date >= '2026-09-21' && milestone.date <= '2026-10-05').length);
    expect(data.workstreams.map((stream) => stream.name)).toEqual(['系统底座', '用工方业务', '求职者业务', '收费模式', '运营后台', '运营筹备']);
    const fictionalPeople = new Set(['周亦安', '陈知远', '林若宁', '许景行']);
    for (const task of data.tasks) {
      expect(fictionalPeople.has(task.owner)).toBe(true);
      expect(data.workstreams.some((stream) => stream.id === task.workstreamId)).toBe(true);
      expect(task.due >= data.project.start && task.due <= data.project.end).toBe(true);
      expect(task.progress).toBe(task.status === 'done' ? 100 : task.status === 'todo' ? 0 : task.progress);
      if (task.status === 'in_progress') expect(task.progress).toBeLessThan(100);
    }
    for (const risk of data.risks) {
      expect(risk.taskIds.every((id) => data.tasks.some((task) => task.id === id))).toBe(true);
    }
  });

  test('reopens persisted data without reseeding it and recalculates metrics from stored tasks', async () => {
    await overview();
    await app.close();
    const database = new Database(dbPath);
    try {
      database.prepare("UPDATE homepage_tasks SET status = 'done', progress = 100 WHERE id = (SELECT id FROM homepage_tasks WHERE status != 'done' AND due < '2026-09-21' LIMIT 1)").run();
    } finally {
      database.close();
    }
    app = buildApp({ dbPath });
    const data = await overview();
    expect(data.tasks).toHaveLength(48);
    expect(data.summary.completedTasks).toBe(19);
    expect(data.summary.overdueTasks).toBe(3);
    expect(data.summary.completionRate).toBeCloseTo(19 / 48 * 100, 1);
  });

  test('reports no calculable completion rate when persisted tasks are empty', async () => {
    await app.close();
    const database = new Database(dbPath);
    try { database.exec('DELETE FROM homepage_tasks'); } finally { database.close(); }
    app = buildApp({ dbPath });
    const data = await overview();
    expect(data.tasks).toEqual([]);
    expect(data.summary.completionRate).toBeNull();
    expect(data.summary.totalTasks).toBe(0);
  });

  test('unknown projects use the error envelope', async () => {
    const response = await app.inject('/api/v1/projects/unknown/overview');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' }, requestId: expect.any(String) });
  });

  test('exposes live and database readiness without local paths', async () => {
    for (const path of ['/health/live', '/health/ready']) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { status: 'ok', mode: 'demo' } });
      expect(response.body).not.toContain(directory);
    }
  });

  test('overview stays read-only and task creation requires a valid session', async () => {
    const before = await overview();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/v1/projects/phase-one/overview' });
      expect(response.statusCode).toBe(404);
    }
    const create = await app.inject({ method: 'POST', url: '/api/v1/projects/phase-one/tasks', payload: { title: '不应创建' } });
    expect(create.statusCode).toBe(403);
    expect(await overview()).toEqual(before);
  });
});
