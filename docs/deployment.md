# 部署指南

## 用 Docker Compose 部署新实例

从 [README 的 Docker 快速开始](../README.md#用-docker-启动)完成初始化。使用 Docker Compose v2，在宿主机运行以下命令检查容器状态和应用就绪状态：

```sh
docker compose ps
curl -fsS http://127.0.0.1:3100/health/ready
docker compose logs --tail=100 app
```

前端和 API 由同一进程提供。Compose 把宿主机端口绑定到 `127.0.0.1`，把 SQLite、备份和系统生成的密钥保存在 `project_ms_data` 数据卷内。关闭服务用 `docker compose stop`，恢复用 `docker compose up -d`。请避免使用会删除数据卷的 `down -v`。

### 端口与域名

复制 `.env.example` 为 `.env`。本机改用 13100 端口时，将 `PROJECT_MS_PORT` 改为 `13100`，并将 `PUBLIC_BASE_URL` 改为 `http://127.0.0.1:13100`。执行 `docker compose up -d` 应用配置。

要通过 HTTPS 对外提供服务，在反向代理配置域名与证书，将该域名的所有路径代理至 `http://127.0.0.1:3100`，并在 `.env` 设置 `PUBLIC_BASE_URL=https://pm.example.com`。使用实际域名替换示例，保持浏览器地址与配置中的协议、主机和端口一致。代理应保留请求的 `Host` 和 `Origin`，并传递 HTTPS 协议，例如：

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

浏览器从配置的 HTTPS 地址访问时，会话 Cookie 使用 Secure 属性。飞书通知中的应用链接也使用该地址。

## 备份、恢复和复用已有库

应用使用 SQLite 在线备份。部署迁移时，建议额外备份整个数据卷，确保数据库和飞书主密钥配套。停止应用和其他 SQLite 写入进程后执行：

```sh
docker compose stop
docker compose run --rm -T app tar -C /app/data -czf - . > project-ms-backup.tar.gz
docker compose up -d
```

保护备份和系统设置中的密钥备份。环境变量提供的 `FEISHU_MASTER_KEY` 需要通过原密钥管理渠道保留。

要验证恢复，从可信备份解包到另一个 Compose 项目的空卷，并使用不同的本机端口：

```sh
docker compose -p project-ms-restored run --build --rm -T app tar -C /app/data -xzf - < project-ms-backup.tar.gz
PROJECT_MS_PORT=13100 PUBLIC_BASE_URL=http://127.0.0.1:13100 docker compose -p project-ms-restored up -d
curl -fsS http://127.0.0.1:13100/health/ready
```

随后在新实例用原账号登录，核对项目和任务。应用会检查已有数据库的结构和完整性，复用已有库时直接启动即可。如果版本不兼容，先确认源版本和备份，再按对应版本升级。对于需要任务回收站专项升级的旧库，先停止写入并备份，然后在 Node 环境用 `npm run db:upgrade-task-recycle -- /路径/数据库.sqlite` 检查。检查通过后，在同一命令末尾加 `--apply` 执行升级。

已有 Linux 安装可继续使用 `bash scripts/linux.sh help` 或 `bash scripts/centos7-docker.sh help` 查看各自的数据库、地址及运维参数。

## 常见故障

| 现象 | 排查方法 |
| --- | --- |
| 端口被占用 | 修改 `PROJECT_MS_PORT`，同步修改 `PUBLIC_BASE_URL`，再运行 `docker compose up -d` |
| 启动提示没有 SQLite 文件 | 新实例先执行 README 的初始化命令。复用已有库时确认数据卷和文件名 |
| 登录提示来源无权提交 | 检查地址栏和 `PUBLIC_BASE_URL` 是否完全一致，以及反向代理是否保留 Origin |
| 初始化提示数据库已存在 | 使用已有管理员登录。需要全新实例时为 Compose 指定另一项目名以使用空卷 |
| 本地 Node 无法加载 SQLite 模块 | 切换到 Node 24.13.1，重新运行 `npm ci` |
