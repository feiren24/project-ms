# 贡献指南

使用 Node 24.13.1，在仓库根目录执行 `npm ci`。按 [快速开始](README.md#快速开始)初始化本机开发库，或使用测试自带的临时数据库。

先读[开发指南](docs/development.md)定位页面、路由和测试，再用[系统架构](docs/architecture.md)核对模块边界。接口调试见[核心 API](docs/api.md)。

- `client/` 包含 Vue 界面和 API 客户端。
- `server/` 包含 Fastify 路由、业务模块和 SQLite 初始化。
- `shared/` 包含前后端共同使用的契约和权限规则。
- `tests/` 包含单元、集成、浏览器和性能测试。

提交前运行：

```sh
npm run build
npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000
```

浏览器回归需要 Google Chrome。先启动 `npm run dev`，再在另一个终端运行 `npm run test:e2e -- --workers=3`。部署说明的变更请同时核对 [Docker 使用流程](docs/deployment.md)。

提 Issue 时附上版本、操作系统、复现步骤、预期与实际结果。示例请使用脱敏日志和虚构数据。提交 PR 时说明改动及验证命令。漏洞请走 [私密报告](SECURITY.md)。
