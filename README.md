# Project MS · GooodWork 项目管理

Project MS 是一个可自托管的项目管理系统，面向需要共同排期、跟踪交付和管理风险的团队。系统提供项目总览、任务列表和看板、甘特图、里程碑、成员权限、统计和可选的飞书群机器人通知。前端使用 Vue 3，后端使用 Fastify，数据保存在 SQLite。

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

## 文档

- [使用指南](docs/user-guide.md)介绍创建项目、任务、计划和添加成员。
- [部署指南](docs/deployment.md)涵盖 HTTPS、已有库、备份、恢复和常见故障。
- [贡献指南](CONTRIBUTING.md)说明本地开发、测试和提交变更。
- [安全报告](SECURITY.md)提供私密报告入口。

本仓库采用 [MIT 许可证](LICENSE)。
