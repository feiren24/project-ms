#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ACTION="${1:-help}"; [[ $# -eq 0 ]] || shift
RUNTIME="$PROJECT_DIR/.runtime"
SETTINGS="$RUNTIME/docker-settings"
ENV_FILE="$PROJECT_DIR/.env.docker"
IMAGE_FILE="$RUNTIME/docker-image.id"
NODE_VERSION="$(tr -d '[:space:]' < "$PROJECT_DIR/.node-version")"
BASE_IMAGE="node:${NODE_VERSION}-bookworm-slim"
PROJECT_KEY="$(printf '%s' "$PROJECT_DIR" | cksum | awk '{print $1}')"
NAME="goodwork-$PROJECT_KEY"
PUBLIC_ORIGIN=''; PUBLIC_URL=''; ORIGIN_FLAG=''; HOST_PORT=''; DB_FILE=''; APT_MIRROR=''
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
# 访问来源必须是纯 origin，与 server/src/config.ts 的校验一致；端口另查，因为越界端口会在
# 容器启动时才由 new URL() 抛出，属于过晚的失败。
validate_public_url() {
  local value="$1" rest port
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *,* ]] || fail '访问地址不能包含换行或逗号。'
  [[ "$value" =~ ^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]] || fail '访问地址必须为完整来源地址，例如 https://pm.example.com 或 http://203.0.113.10:3100。'
  rest="${value#*://}"; rest="${rest%%/*}"
  [[ "${rest%%:*}" != 0.0.0.0 ]] || fail '访问地址不能使用 0.0.0.0。'
  if [[ "$rest" == *:* ]]; then
    port="${rest##*:}"
    (( 10#$port >= 1 && 10#$port <= 65535 )) || fail '访问地址的端口必须为 1–65535。'
  fi
}
usage() {
  cat <<'HELP'
GoodWork CentOS 7 容器部署（使用已有本机 Docker，保留已有 SQLite）
  bash scripts/centos7-docker.sh check
  bash scripts/centos7-docker.sh install (--public-ip 服务器IPv4 | --public-url https://域名) [--port 3100] [--db /已有.sqlite] [--apt-mirror default|ustc]
  bash scripts/centos7-docker.sh start | status | logs | stop | restart
首次 check/install 会按需下载 Node 镜像并执行隔离探测；不会安装或升级宿主 Docker。
默认数据库：项目目录/data/homepage-demo.sqlite；禁止初始化、迁移或重置账号。
install 只构建、校验和保存配置；start 才提供服务。不配置自动重启或开机自启。
HELP
}
case "$ACTION" in help|-h|--help) usage; exit 0;; check|install|start|status|logs|stop|restart) ;; *) fail "未知命令：$ACTION";; esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip|--public-url)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 缺少参数"
      [[ -z "$ORIGIN_FLAG" || "$ORIGIN_FLAG" == "$1" ]] || fail '--public-ip 与 --public-url 只能提供其中一个。'
      ORIGIN_FLAG="$1"; PUBLIC_ORIGIN="$2"
      shift 2;;
    --port|--db|--apt-mirror)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 缺少参数"
      case "$1" in --port) HOST_PORT="$2";; --db) DB_FILE="$2";; --apt-mirror) APT_MIRROR="$2";; esac
      shift 2;;
    *) fail "未知参数：$1";;
  esac
done
[[ "$ACTION" == install || -z "$PUBLIC_ORIGIN$HOST_PORT$DB_FILE$APT_MIRROR" ]] || fail '配置参数仅用于 install；修改配置前请先 stop。'
[[ "$(uname -s)" == Linux ]] || fail '部署控制脚本仅在 Linux 服务器执行。'
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '.node-version 格式无效'
for tool in docker curl flock readlink mktemp; do command -v "$tool" >/dev/null || fail "缺少 ${tool}，请先准备该工具；脚本不会改动宿主系统。"; done
# Bind mounts reference the daemon's filesystem. Reject remote endpoints/contexts.
[[ -z "${DOCKER_HOST:-}" || "${DOCKER_HOST}" == unix://* ]] || fail '必须连接本机 Unix socket Docker；远程 daemon 无法使用本机项目数据路径。'
[[ -z "${DOCKER_CONTEXT:-}" || "${DOCKER_CONTEXT}" == default ]] || fail '必须使用本机默认 Docker context。'
CONTEXT="$(docker context show 2>/dev/null || true)"
[[ -z "$CONTEXT" || "$CONTEXT" == default ]] || fail '当前 Docker context 不是 default，请确认本机 Docker 连接。'
docker info --format 'Docker 服务端 {{.ServerVersion}} / {{.OperatingSystem}} / 内核 {{.KernelVersion}}' || fail '无法连接 Docker 服务端。'
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || fail 'Docker 服务端必须运行 Linux 容器。'
cd -- "$PROJECT_DIR"

exists_container() { docker container inspect "$NAME" >/dev/null 2>&1; }
owned_container() {
  [[ "$(docker container inspect --format '{{index .Config.Labels "goodwork.project"}}' "$NAME")" == "$PROJECT_DIR" ]] || fail "同名容器 ${NAME} 不属于本项目，停止操作。"
}
is_running() { [[ "$(docker container inspect --format '{{.State.Running}}' "$NAME")" == true ]]; }
stop_app() {
  if ! exists_container; then info '本项目容器不存在。'; return; fi
  owned_container
  if is_running; then docker stop --time 30 "$NAME"; info '本项目容器已停止；数据库仍保留在宿主目录。'; else info '本项目容器已停止。'; fi
}
case "$ACTION" in
  status) if exists_container; then owned_container; docker container inspect --format '容器 {{.Name}} 状态 {{.State.Status}}' "$NAME"; else info '本项目尚未创建容器。'; fi; exit 0;;
  logs) exists_container || fail '本项目尚未创建容器。'; owned_container; exec docker logs --tail 100 --follow "$NAME";;
esac
umask 077
mkdir -p -- "$RUNTIME"
exec 9>"$RUNTIME/control.lock"
flock -n 9 || fail '另一个安装或启动操作正在执行，请稍后重试。'
[[ "$ACTION" != stop ]] || { stop_app; exit 0; }

if [[ -f "$SETTINGS" ]]; then
  [[ -n "$PUBLIC_ORIGIN" ]] || PUBLIC_ORIGIN="$(sed -n '1p' "$SETTINGS" | tr -d '\r')"
  [[ -n "$HOST_PORT" ]] || HOST_PORT="$(sed -n '2p' "$SETTINGS")"
  [[ -n "$DB_FILE" ]] || DB_FILE="$(sed -n '3p' "$SETTINGS")"
  [[ -n "$APT_MIRROR" ]] || APT_MIRROR="$(sed -n '4p' "$SETTINGS")"
fi
APT_MIRROR="${APT_MIRROR:-default}"
case "$APT_MIRROR" in default|ustc) ;; *) fail 'APT 镜像源只支持 default 或 ustc。';; esac
HOST_PORT="${HOST_PORT:-3100}"; DB_FILE="${DB_FILE:-$PROJECT_DIR/data/homepage-demo.sqlite}"
[[ "$HOST_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$HOST_PORT >= 1024 && 10#$HOST_PORT <= 65535 )) || fail '端口必须为 1024–65535 的整数。'
HOST_PORT="$((10#$HOST_PORT))"
# 裸 IPv4 是历史格式（也是 --public-ip 的入参形态）；八位组解析必须只走这一分支，
# 域名落到这里时 (( 10#$a )) 会抛裸 bash 错误而不是可读的提示。
if [[ "$PUBLIC_ORIGIN" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && "$PUBLIC_ORIGIN" != 0.0.0.0 ]]; then
  IFS=. read -r a b c d <<< "$PUBLIC_ORIGIN"
  for octet in "$a" "$b" "$c" "$d"; do (( 10#$octet <= 255 )) || fail '服务器 IPv4 无效。'; done
  PUBLIC_ORIGIN="$((10#$a)).$((10#$b)).$((10#$c)).$((10#$d))"
  PUBLIC_URL="http://${PUBLIC_ORIGIN}:${HOST_PORT}"
elif [[ -n "$PUBLIC_ORIGIN" ]]; then
  validate_public_url "$PUBLIC_ORIGIN"
  PUBLIC_URL="${PUBLIC_ORIGIN%/}"
else
  [[ "$ACTION" == check ]] || fail '首次 install 必须提供 --public-ip 服务器IPv4 或 --public-url 完整访问地址。'
fi
# 只有“对外地址就是本机这个明文 HTTP 端口”时才发布到公网；HTTPS 或外部端口不同都说明前面有反代，
# 容器只需回环可达。--port 与 --public-url 的端口不一致是合法配置（外部 8443 反代内部 3100）。
PUBLISH_PREFIX='127.0.0.1:'
if [[ "$PUBLIC_URL" == http://* ]]; then
  origin_host_port="${PUBLIC_URL#http://}"
  if [[ "$origin_host_port" == *:* ]] && (( 10#${origin_host_port##*:} == HOST_PORT )); then PUBLISH_PREFIX=''; fi
fi
[[ "$DB_FILE" == /* ]] || DB_FILE="$PROJECT_DIR/$DB_FILE"
[[ "$DB_FILE" != *$'\n'* && "$DB_FILE" != *$'\r'* && "$DB_FILE" != *,* && "$ENV_FILE" != *,* ]] || fail '路径不能包含换行或逗号。'
[[ -f "$DB_FILE" && -s "$DB_FILE" && ! -L "$DB_FILE" ]] || fail "已有数据库缺失、为空或为符号链接：${DB_FILE}。不会创建新库。"
DB_DIR="$(cd -- "$(dirname -- "$DB_FILE")" && pwd -P)"
DB_NAME="$(basename -- "$DB_FILE")"; DB_FILE="$DB_DIR/$DB_NAME"
[[ -r "$DB_FILE" && -w "$DB_FILE" && -w "$DB_DIR" ]] || fail '数据库及所在目录需要当前用户读写权限。'
CONTAINER_DB="/app/data/$DB_NAME"
COMMON=(--network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)")
probe_node() {
  docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || docker pull "$BASE_IMAGE"
  docker run --rm "${COMMON[@]}" "$BASE_IMAGE" node -e '
    const {Worker}=require("node:worker_threads");
    console.log({node:process.version,arch:process.arch,uuid:require("node:crypto").randomUUID()});
    new Worker("require(\"node:crypto\").randomUUID()",{eval:true}).on("error",()=>process.exit(1));
  ' || fail 'Node 容器探测失败；请保留错误输出。未挂载数据库，不会跳过内核或安全限制。'
}
read_image() {
  [[ -f "$IMAGE_FILE" ]] || fail '尚未安装应用镜像，请先 install。'
  IMAGE_ID="$(cat "$IMAGE_FILE")"
  [[ "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || fail '应用镜像记录无效，请重新 install。'
  docker image inspect "$IMAGE_ID" >/dev/null || fail '应用镜像不存在，请重新 install。'
}
SNAPSHOT_HELPER="$PROJECT_DIR/scripts/check-database-snapshot.mjs"
CHECK_DIR=''; CHECK_NAME=''; CHECK_TOKEN=''; CHECK_PID=''
validate_snapshot_helper() {
  [[ -f "$SNAPSHOT_HELPER" && -s "$SNAPSHOT_HELPER" && ! -L "$SNAPSHOT_HELPER" ]] || fail "快照校验脚本缺失、为空或为符号链接：${SNAPSHOT_HELPER}。请同步该文件后重试。"
}
# 校验只针对停写的原库。除本项目外还检查所有运行容器的真实挂载来源；不能可靠检查时拒绝继续。
ensure_snapshot_safe() {
  local LC_ALL=C containers container sources record length source canonical target
  if exists_container; then
    owned_container
    is_running && fail '本项目容器正在运行，请先 stop，再校验或 install；快照要求数据库停止写入。'
  fi
  containers="$(docker ps -q)" || fail '无法列出运行容器，不能确认数据库已停止写入。'
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    sources="$(docker container inspect --format '{{range .Mounts}}{{printf "%d:%s\n" (len .Source) .Source}}{{end}}' "$container")" || fail "无法检查运行容器 ${container} 的挂载，请稍后重试。"
    while IFS= read -r record; do
      [[ -n "$record" ]] || continue
      length="${record%%:*}"; source="${record#*:}"
      [[ "$length" =~ ^[0-9]+$ && "$length" == "${#source}" ]] || fail "无法安全解析运行容器 ${container} 的挂载路径。"
      [[ -n "$source" ]] || continue
      [[ "$source" == /* && "$source" != *$'\r'* ]] || fail "无法安全解析运行容器 ${container} 的挂载路径。"
      canonical="$(readlink -f -- "$source")" || fail "无法解析运行容器 ${container} 的真实挂载路径：${source}。"
      [[ -n "$canonical" ]] || fail "运行容器 ${container} 的挂载路径为空。"
      for target in "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm" "$DB_FILE-journal"; do
        if [[ "$canonical" == / || "$target" == "$canonical" || "$target" == "$canonical/"* || "$canonical" == "$target/"* ]]; then
          fail "运行容器 ${container} 的挂载 ${source} 与数据库重叠；请确认并自行停止写入后重试。脚本不会停止其他容器。"
        fi
      done
    done <<< "$sources"
  done <<< "$containers"
}
cleanup_snapshot() {
  local token matches
  if [[ -n "$CHECK_PID" ]]; then
    kill "$CHECK_PID" 2>/dev/null || true
    wait "$CHECK_PID" 2>/dev/null || true
    CHECK_PID=''
  fi
  if [[ -n "$CHECK_NAME" ]]; then
    if token="$(docker container inspect --format '{{index .Config.Labels "goodwork.validation"}}' "$CHECK_NAME" 2>/dev/null)"; then
      if [[ "$token" == "$CHECK_TOKEN" ]]; then
        # 只删除本次随机命名并带有匹配令牌的校验容器。
        docker rm -f "$CHECK_NAME" >/dev/null || {
          printf '错误：无法清理校验容器 %s；保留临时目录 %s。请恢复 Docker 后核对容器标签再清理。\n' "$CHECK_NAME" "$CHECK_DIR" >&2
          return 1
        }
      else
        printf '错误：校验容器 %s 所有权不匹配，保留临时目录供排查：%s\n' "$CHECK_NAME" "$CHECK_DIR" >&2
        return 1
      fi
    else
      # inspect 失败也可能是 daemon 不可用。只有成功列出且确认该精确名称不存在，才能删除快照。
      if ! matches="$(docker ps -aq --filter "name=^/${CHECK_NAME}$" 2>/dev/null)" || [[ -n "$matches" ]]; then
        printf '错误：无法确认校验容器 %s 已不存在；保留临时目录 %s。请恢复 Docker 后核对 goodwork.validation=%s，再清理容器与目录。\n' "$CHECK_NAME" "$CHECK_DIR" "$CHECK_TOKEN" >&2
        return 1
      fi
    fi
  fi
  if [[ -n "$CHECK_DIR" && "$CHECK_DIR" == "$RUNTIME"/db-check-* && -d "$CHECK_DIR" && ! -L "$CHECK_DIR" ]]; then
    rm -rf -- "$CHECK_DIR" || return 1
  fi
  CHECK_DIR=''; CHECK_NAME=''; CHECK_TOKEN=''
}
trap 'snapshot_exit=$?; cleanup_snapshot || { (( snapshot_exit != 0 )) || snapshot_exit=1; }; exit "$snapshot_exit"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check_database() {
  validate_snapshot_helper
  ensure_snapshot_safe
  CHECK_DIR="$(mktemp -d "$RUNTIME/db-check-XXXXXXXXXX")" || fail '无法创建磁盘快照临时目录。'
  chmod 700 "$CHECK_DIR"
  CHECK_TOKEN="${CHECK_DIR##*/}"
  CHECK_NAME="$NAME-check-${CHECK_TOKEN#db-check-}"
  info '正在校验停写数据库的临时快照；原目录只读挂载，WAL/回滚日志恢复只发生在临时目录。'
  docker run --rm --name "$CHECK_NAME" --label "goodwork.project=$PROJECT_DIR" --label "goodwork.validation=$CHECK_TOKEN" \
    "${COMMON[@]}" --mount "type=bind,src=$DB_DIR,dst=/source,readonly" \
    --mount "type=bind,src=$SNAPSHOT_HELPER,dst=/app/scripts/check-database-snapshot.mjs,readonly" \
    --mount "type=bind,src=$CHECK_DIR,dst=/check" "$IMAGE_ID" \
    node --import tsx /app/scripts/check-database-snapshot.mjs "/source/$DB_NAME" /check &
  CHECK_PID=$!
  if ! wait "$CHECK_PID"; then
    CHECK_PID=''
    fail '已有 SQLite 快照校验失败；请检查结构、挂载权限、磁盘空间及 WAL/回滚日志配套文件。原数据库不会被初始化或修复。'
  fi
  CHECK_PID=''
  cleanup_snapshot || fail '快照校验完成，但临时资源清理失败；请保留错误输出排查。'
}
# 容器用 --env-file 读该文件，但进程环境里的 -e 优先，会静默压过文件；这里只提示，不改写用户文件。
warn_env_origin() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -q '^PUBLIC_BASE_URL=' "$ENV_FILE" 2>/dev/null || return 0
  info "提示：.env.docker 中的 PUBLIC_BASE_URL 会被脚本参数覆盖；访问来源请用 install --public-url 设置。"
}
if [[ "$ACTION" == check ]]; then
  validate_snapshot_helper; ensure_snapshot_safe
  info "原数据库：$DB_FILE"; probe_node
  if [[ -f "$IMAGE_FILE" ]]; then read_image; check_database; else info '基础容器探测通过；尚未构建应用镜像，SQLite 结构校验将在 install 时执行。'; fi
  exit 0
fi
if [[ "$ACTION" == install ]]; then
  validate_snapshot_helper; ensure_snapshot_safe
  for input in Dockerfile .dockerignore; do
    [[ -f "$PROJECT_DIR/$input" && -s "$PROJECT_DIR/$input" ]] || fail "缺少或为空：${input}。请同步项目根目录的 Dockerfile 和 .dockerignore 后重试，不会开始构建。"
  done
  if exists_container; then owned_container; is_running && fail '本项目容器正在运行，请先 stop，再 install。'; fi
  free_kb="$(df -Pk "$PROJECT_DIR" | awk 'END{print $4}')"
  (( free_kb >= 2097152 )) || fail '项目所在磁盘可用空间不足 2 GiB；Docker 存储目录也需留出构建空间。'
  probe_node
  candidate="$RUNTIME/docker-image.candidate"
  rm -f -- "$candidate"
  info '开始构建：显示完整下载日志；网络失败时保留错误输出，不要反复清理构建缓存。'
  info "APT 镜像源：${APT_MIRROR}（仅影响镜像构建）"
  BUILDKIT_PROGRESS="${BUILDKIT_PROGRESS:-plain}" docker build --progress="${BUILDKIT_PROGRESS:-plain}" --build-arg "NODE_VERSION=$NODE_VERSION" --build-arg "APT_MIRROR=$APT_MIRROR" --iidfile "$candidate" -f "$PROJECT_DIR/Dockerfile" "$PROJECT_DIR"
  IMAGE_ID="$(cat "$candidate")"
  [[ "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || fail '构建未返回有效镜像 ID。'
  check_database
  if [[ ! -e "$ENV_FILE" ]]; then
    if [[ -f "$PROJECT_DIR/.env.linux" ]]; then cp -- "$PROJECT_DIR/.env.linux" "$ENV_FILE"; else printf '# 可保留 FEISHU_MASTER_KEY 等原配置；部署路径和访问地址由脚本设置。\n' > "$ENV_FILE"; fi
    chmod 600 "$ENV_FILE"
  fi
  warn_env_origin
  printf '%s\n%s\n%s\n%s\n' "$PUBLIC_ORIGIN" "$HOST_PORT" "$DB_FILE" "$APT_MIRROR" > "$SETTINGS.tmp"
  mv -- "$SETTINGS.tmp" "$SETTINGS"; mv -- "$candidate" "$IMAGE_FILE"
  info "安装及原库校验完成，尚未启动。执行 bash scripts/centos7-docker.sh start；访问来源：$PUBLIC_URL/login"
  [[ -z "$PUBLISH_PREFIX" ]] || info "容器端口仅绑定 127.0.0.1:${HOST_PORT}；反向代理请指向该地址，无需对公网放行。"
  exit 0
fi
read_image
[[ -f "$ENV_FILE" ]] || fail '缺少 .env.docker，请重新 install。'
if [[ "$ACTION" == restart ]]; then stop_app; fi
if exists_container; then
  owned_container
  if is_running; then info "已运行：$PUBLIC_URL/login"; exit 0; fi
fi
warn_env_origin
check_database
# Remove only a stopped container owned by this checkout; never remove volumes or data.
if exists_container; then docker rm "$NAME"; fi
docker run -d --name "$NAME" --label "goodwork.project=$PROJECT_DIR" --restart=no \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --log-opt max-size=10m --log-opt max-file=3 \
  -p "${PUBLISH_PREFIX}${HOST_PORT}:3100" --mount "type=bind,src=$DB_DIR,dst=/app/data" \
  --mount "type=bind,src=$ENV_FILE,dst=/app/deploy.env,readonly" \
  -e HOST=0.0.0.0 -e PORT=3100 -e "PUBLIC_BASE_URL=$PUBLIC_URL" -e "DATABASE_PATH=$CONTAINER_DB" \
  -e DATABASE_MODE=existing-only -e SERVE_WEB=true -e NODE_ENV=production \
  "$IMAGE_ID" node --env-file=/app/deploy.env --import tsx server/src/main.ts
ready=0
for ((i=0;i<30;i++)); do
  is_running || break
  if [[ "$(docker container inspect --format '{{.State.Health.Status}}' "$NAME")" == healthy ]] \
     && curl -fsS --max-time 2 "http://127.0.0.1:$HOST_PORT/login" | grep -q '<div id="app"'; then ready=1; break; fi
  sleep 1
done
if (( ! ready )); then
  docker logs --tail 40 "$NAME" >&2
  stop_app
  fail '容器启动检查失败；容器已保留供排查，原数据库未被初始化。'
fi
info "启动成功：$PUBLIC_URL/login；数据库仍为 ${DB_FILE}。请使用原账号。"
if [[ -n "$PUBLISH_PREFIX" ]]; then
  info "容器端口仅绑定 127.0.0.1:${HOST_PORT}，无需对公网放行；请由反向代理访问。退出 SSH 不会停止容器。"
else
  info "放行防火墙与云安全组 TCP ${HOST_PORT}；退出 SSH 不会停止容器。公网 HTTP 传输不加密。"
fi
