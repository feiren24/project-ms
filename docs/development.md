# 开发指南

## 从干净检出启动

使用仓库指定的 Node 24.13.1。在当前目录从零开始体验时，运行：

```sh
npm ci
npm run auth:bootstrap
npm run dev
```

使用交互终端创建本机管理员，随后打开 [http://127.0.0.1:5174/login](http://127.0.0.1:5174/login)。前端端口是 5174，API 端口是 3100。命令在默认开发数据库 `data/homepage-demo.sqlite` 下运行。已有开发账户时可以直接启动并使用该账户登录。Docker 环境见[部署指南](deployment.md)。

需要独立验证完整部署时，先执行 `npm run build`，再用 `npm run auth:bootstrap -- --self-hosted 新数据库路径` 创建临时 SQLite。启动时将 `DATABASE_PATH` 指向新库，设置 `DATABASE_MODE=existing-only`、`SERVE_WEB=true` 和与实际地址一致的 `PUBLIC_BASE_URL`，然后执行 `npm start`。执行浏览器和集成测试时优先使用测试夹具提供的临时数据库。

## 从界面找到对应代码

以「完整计划」为例：

1. [客户端路由](../client/src/router.ts) 将 `/projects/:projectId/plan` 指向[计划页面](../client/src/features/gantt/PlanPage.vue)。
2. [计划 API 客户端](../client/src/api/planning.ts) 调用项目作用域下的甘特接口，数据类型由[共享计划契约](../shared/src/planning.ts)定义。
3. [服务端计划路由](../server/src/modules/planning/routes.ts) 处理读取、变更预览和提交。调整排期规则时，先在对应模块定位规则及其单元测试，再验证请求链路。

改动一个业务流程时，对照[系统架构](architecture.md)检查界面、共享契约、权限与保存结果是否一致。新增测试数据用虚构项目或现有夹具。

## 运行验证

| 目的 | 命令 |
| --- | --- |
| 类型检查与生产构建 | `npm run build` |
| 单元、集成与快速性能回归 | `npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000` |
| 浏览器验证 | 启动 `npm run dev`，在另一个终端运行 `npm run test:e2e -- --workers=3`，需要 Google Chrome |
| 单文件浏览器验证 | `npm run test:e2e -- tests/e2e/planning.spec.ts --workers=1` |
| 性能测试场景 | 按[性能测试说明](../tests/performance/README.md)选择相应命令 |

集成测试使用测试库和 Fastify 注入请求，部分部署测试会启动独立进程。GitHub 的 CI 验证 Node 构建和 Vitest，并通过 Docker Compose 检查空卷初始化、登录、持久化和重复初始化保护。

准备提交时见[贡献指南](../CONTRIBUTING.md)。需要在运行实例验证接口时见[核心 API](api.md)。
