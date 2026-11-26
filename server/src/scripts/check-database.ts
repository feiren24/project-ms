import { resolve } from 'node:path';
import { checkExistingDatabase } from '../db/existing.js';
import { defaultDatabasePath } from '../db/connection.js';
try {
  const path = resolve(process.argv[2] || process.env.DATABASE_PATH || defaultDatabasePath);
  checkExistingDatabase(path);
  console.info(`已有 SQLite 校验通过：${path}（只读检查，未初始化）`);
} catch (error) { console.error(error instanceof Error ? error.message : '数据库检查失败'); process.exitCode = 1; }
