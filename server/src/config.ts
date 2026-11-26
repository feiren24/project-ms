import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDatabasePath } from './db/connection.js';
import type { DatabaseMode } from './db/lifecycle.js';

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024–65535 的整数。');
  const host = env.HOST || '127.0.0.1';
  const databaseMode = env.DATABASE_MODE || 'initialize';
  if (!['initialize','existing-only'].includes(databaseMode)) throw new Error('DATABASE_MODE 无效。');
  const serveWeb = env.SERVE_WEB === 'true';
  if (env.SERVE_WEB && !['true','false'].includes(env.SERVE_WEB)) throw new Error('SERVE_WEB 必须为 true 或 false。');
  let publicUrl: URL | undefined;
  if (env.PUBLIC_BASE_URL) {
    publicUrl = new URL(env.PUBLIC_BASE_URL);
    if (!['http:','https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/' || publicUrl.hostname === '0.0.0.0') throw new Error('PUBLIC_BASE_URL 必须为完整的访问源地址，例如 http://服务器IP:3100。');
  }
  if (serveWeb && !publicUrl) throw new Error('托管前端时必须配置 PUBLIC_BASE_URL。');
  if (serveWeb && databaseMode !== 'existing-only') throw new Error('部署前端必须使用 DATABASE_MODE=existing-only，禁止初始化数据库。');
  const secureCookies = publicUrl ? publicUrl.protocol === 'https:' : env.NODE_ENV === 'production';
  return {
    host, port, databaseMode: databaseMode as DatabaseMode,
    dbPath: resolve(env.DATABASE_PATH || defaultDatabasePath),
    allowedOrigins: publicUrl ? [publicUrl.origin] : undefined, secureCookies,
    webRoot: serveWeb ? fileURLToPath(new URL('../../client/dist/', import.meta.url)) : undefined,
  };
}
