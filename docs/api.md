# 核心 API

示例针对本地自托管实例，使用 Node 24、Bash、`curl` 和 `jq`。请先按[快速开始](../README.md#快速开始)初始化测试管理员并启动服务。写入示例会创建一个测试项目，请使用独立开发实例。

## 请求与会话

- 健康检查使用 `GET /health/ready`，项目接口位于 `/api/v1`。成功响应通常把结果放在 `data` 中。
- 登录响应设置 HttpOnly 会话 Cookie，并在 `data.csrfToken` 返回令牌。读取时携带同一会话 Cookie。项目写入另外发送 `X-CSRF-Token`，请求的 `Origin` 与实例配置的访问地址一致。
- 创建项目时发送 `Idempotency-Key`。重试同一次操作时使用相同键和请求体，发起另一项操作时生成新键。涉及任务或计划版本的写入应先读取最新版本。
- 错误响应提供 `error.code`、`error.message` 和 `requestId`。常见状态为 `401`（需登录）、`403`（来源、权限或 CSRF 被拒绝）、`404`（资源不可用）、`409`（版本或幂等冲突）、`422`（请求校验失败）和 `429`（登录过于频繁）。

## 从登录到项目与计划

在同一个 Bash 终端执行下面的示例。默认访问 Docker 或同源部署使用的 3100 端口。

```bash
(
  set -euo pipefail
  umask 077
  base=${PROJECT_MS_URL:-http://127.0.0.1:3100}
  session_dir=$(mktemp -d)
  trap 'rm -f "$session_dir/cookies"; rmdir "$session_dir"' EXIT

  curl -fsS "$base/health/ready" | jq -e '.data.status == "ok"'
  read -r -p '登录账号：' username
  read -r -s -p '登录密码：' password
  printf '\n' >&2
  session=$(printf '%s\n%s\n' "$username" "$password" |
    jq -Rs 'split("\n") | {username: .[0], password: .[1]}' |
    curl -fsS -H "Origin: $base" -H 'Content-Type: application/json' \
      --cookie-jar "$session_dir/cookies" --data-binary @- "$base/api/v1/auth/login")
  unset password
  csrf=$(printf '%s' "$session" | jq -er '.data.csrfToken | select(length > 0)')
  unset session

  curl -fsS --cookie "$session_dir/cookies" "$base/api/v1/projects" |
    jq '.data.projects | map({id, name})'

  request_key=$(node -p 'crypto.randomUUID()')
  project_id=$(curl -fsS --cookie "$session_dir/cookies" \
    -H "Origin: $base" -H "X-CSRF-Token: $csrf" \
    -H "Idempotency-Key: $request_key" -H 'Content-Type: application/json' \
    --data '{"name":"API 示例项目","goal":"验证项目与计划接口","start":"2026-10-01","end":"2026-12-31"}' \
    "$base/api/v1/projects" | jq -er '.data.id')

  curl -fsS --cookie "$session_dir/cookies" "$base/api/v1/projects/$project_id/tasks" |
    jq '.data.tasks | length'
  curl -fsS --cookie "$session_dir/cookies" "$base/api/v1/projects/$project_id/gantt" |
    jq '.data | {project: .project.name, plannedNodes: (.nodes | length)}'

  curl -fsS --cookie "$session_dir/cookies" -H "Origin: $base" \
    -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
    --data '{}' "$base/api/v1/auth/logout" | jq -e '.data.user == null'
)
```

新项目的任务数为 `0`，甘特接口会返回项目及其初始分组。端口或域名不同的实例可先设置 `PROJECT_MS_URL`，值与部署访问地址一致。

## 源码参考

| 接口 | 路由与契约 |
| --- | --- |
| 会话登录、查询与退出 | [认证路由](../server/src/modules/auth/index.ts)、[认证类型](../shared/src/auth.ts) |
| 项目列表、创建与详情 | [项目路由](../server/src/modules/projects/routes.ts)、[项目类型](../shared/src/projects.ts) |
| 任务读取、筛选和状态变更 | [任务路由](../server/src/modules/tasks/routes.ts)、[任务类型](../shared/src/tasks.ts) |
| 甘特计划、排期预览和提交 | [计划路由](../server/src/modules/planning/routes.ts)、[计划类型](../shared/src/planning.ts) |
