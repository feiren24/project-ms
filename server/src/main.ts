import { buildApp } from './app.js';
import { runtimeConfig } from './config.js';

let app: ReturnType<typeof buildApp> | undefined;
try {
  const config = runtimeConfig();
  app = buildApp(config);
  const close = async () => { await app?.close(); process.exitCode = 0; };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  const address = await app.listen({ host: config.host, port: config.port });
  console.info(`GoodWork 项目管理服务: ${address}`);
  console.info(`数据库: ${config.dbPath} (${config.databaseMode})`);
} catch (error) {
  console.error('GoodWork 启动失败。', error instanceof Error ? error.message : '未知错误');
  await app?.close();
  process.exitCode = 1;
}
