import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.js';
import { initializeSelfHostedDatabase } from '../../server/src/scripts/self-hosted-setup.js';

const admin = { username: 'setup-admin', name: '测试管理员', password: 'test-only-password-2026' };

describe('self-hosted SQLite setup', () => {
  test('creates a usable database and rejects a second bootstrap without changing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-ms-setup-'));
    const database = join(directory, 'project.sqlite');
    try {
      await initializeSelfHostedDatabase(database, admin);
      const app = buildApp({ dbPath: database, databaseMode: 'existing-only', jobIntervalMs: 0 });
      try {
        expect((await app.inject('/health/ready')).statusCode).toBe(200);
        const login = await app.inject({
          method: 'POST', url: '/api/v1/auth/login',
          payload: { username: admin.username, password: admin.password },
        });
        expect(login.statusCode).toBe(200);
      } finally {
        await app.close();
      }
      const before = await readFile(database);
      await expect(initializeSelfHostedDatabase(database, admin)).rejects.toThrow(/已存在/);
      expect((await readFile(database)).equals(before)).toBe(true);
      expect(await readdir(directory)).toEqual(['project.sqlite']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('cleans up the staged database if admin creation fails and allows retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-ms-setup-'));
    const database = join(directory, 'project.sqlite');
    try {
      await expect(initializeSelfHostedDatabase(database, { ...admin, username: '?' })).rejects.toThrow(/账号须为/);
      await expect(access(database)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(directory)).toEqual([]);
      await expect(initializeSelfHostedDatabase(database, admin)).resolves.toMatchObject({ username: admin.username });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
