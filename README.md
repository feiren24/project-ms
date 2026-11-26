# Project MS · 面向交付团队的开源项目管理系统

联调推迟了三天，原定的上线日期还能守住吗？在 Project MS 的甘特图上调整任务日期，保存前就能看到哪些后续任务需要顺延，以及有多少个里程碑会受影响。发布计划基线后，团队还能对照原定日期，查清排期偏差。

到了交付环节，负责人在任务看板提交成果，指定验收人按约定标准通过或退回。项目经理可以在风险台账跟进应对措施，用风险矩阵判断哪件事要先处理。

Project MS（GooodWork）支持 Docker Compose 私有化部署，项目数据保存在本地 SQLite，也可按项目配置飞书群通知。

*Self-hosted project management for delivery teams. Preview how schedule changes affect milestones, track deliverable sign-off, and prioritize project risks.*

[快速开始](#快速开始) · [查看界面](#界面一览) · [部署指南](docs/deployment.md) · [参与贡献](#参与贡献)

![示例项目总览，集中展示进度、待处理事项与近期计划](docs/screenshots/01-overview.webp)

*项目总览 · 在一屏查看项目进展、待处理事项与近期计划。*

## 快速开始

```sh
git clone https://github.com/feiren24/project-ms.git
cd project-ms
```

### 用 Docker 启动

安装 Docker Engine 或 Docker Desktop，以及 Docker Compose v2。然后运行：

```sh
docker compose run --build --rm app npm run auth:bootstrap -- --self-hosted /app/data/homepage-demo.sqlite
docker compose up -d
docker compose ps
```

第一条命令会提示输入登录账号、姓名和密码。打开 [http://127.0.0.1:3100/login](http://127.0.0.1:3100/login)，用刚创建的管理员登录。SQLite、备份和系统生成的集成密钥保存在 Compose 数据卷中。以后启动直接执行 `docker compose up -d`。

### 用 Node 本地运行

安装 Node **24.13.1**（见 `.node-version`），在交互终端运行：

```sh
npm ci
npm run auth:bootstrap
npm run dev
```

打开 [http://127.0.0.1:5174/login](http://127.0.0.1:5174/login)。前端使用 5174 端口，API 使用 3100 端口。开发数据库位于 `data/homepage-demo.sqlite`。首次启动提供一个标注为 DEMO 的示例项目，也可以创建属于自己的空白项目。

## 界面一览

截图使用系统内置的 DEMO 数据，风险矩阵包含一项演示评分。

### 甘特计划

![完整计划的甘特图，左侧是分组任务，右侧是任务时间条和依赖关系](docs/screenshots/02-plan.webp)

改期前看影响。在甘特图中选中任务并调整日期，预览会列出需要改期的后续任务，以及受影响的里程碑数量。

### 任务看板

![按任务状态分列的看板，卡片显示任务名称、负责人和进度](docs/screenshots/03-task-board.webp)

交付时有验收记录。从看板打开关键交付物，可查看验收标准、提交的成果，以及验收人通过或退回的记录。

### 风险矩阵

![风险中心的五乘五矩阵，横纵轴分别表示可能性和影响程度](docs/screenshots/04-risk-matrix.webp)

从高风险项找到负责人。点击矩阵中概率和影响都高的格子，即可查看对应的风险、评分和负责人。

## 技术文档

- [系统架构](docs/architecture.md)解释 Vue、Fastify、SQLite 和后台作业如何协作。
- [开发指南](docs/development.md)包含本地开发、代码导航和测试命令。
- [核心 API](docs/api.md)提供登录、创建项目、读取任务和甘特计划的可执行示例。
- [使用指南](docs/user-guide.md)介绍创建项目、任务、计划和添加成员。
- [部署指南](docs/deployment.md)涵盖 HTTPS、已有库、备份和恢复。

## 参与贡献

从[贡献指南](CONTRIBUTING.md)搭建开发环境。遇到问题或有功能建议，可以在 [GitHub Issues](https://github.com/feiren24/project-ms/issues) 提交可复现的例子，也欢迎通过 Pull Request 改进代码和文档。漏洞请使用[私密报告](SECURITY.md)。

本仓库采用 [MIT 许可证](LICENSE)。
