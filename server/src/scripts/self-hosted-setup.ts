import Database from 'better-sqlite3';
import { chmod, link, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildApp } from '../app.js';
import { checkExistingDatabase } from '../db/existing.js';
import { createInitialAdmin } from '../modules/auth/index.js';

export async function initializeSelfHostedDatabase(
  databasePath: string,
  admin: Parameters<typeof createInitialAdmin>[1],
) {
  const target = resolve(databasePath);
  const alreadyExists = () => new Error(`数据库已存在，未覆盖：${target}`);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing) throw alreadyExists();

  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.project-ms-setup-'));
  const databasePathInStaging = join(staging, 'project.sqlite');
  try {
    const app = buildApp({ dbPath: databasePathInStaging, jobIntervalMs: 0 });
    try {
      await app.ready();
    } finally {
      await app.close();
    }

    const db = new Database(databasePathInStaging, { fileMustExist: true });
    const user = await createInitialAdmin(db, admin).finally(() => db.close());
    checkExistingDatabase(databasePathInStaging);
    await chmod(databasePathInStaging, 0o600);
    // Both paths are on the same volume. Linking publishes the complete file without replacing existing data.
    await link(databasePathInStaging, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw alreadyExists();
      throw error;
    });
    return user;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
