#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUNTIME="$PROJECT_DIR/.runtime"
CONFIG="$PROJECT_DIR/.env.linux"
PID_FILE="$RUNTIME/goodwork.pid"
LOG_FILE="$PROJECT_DIR/logs/goodwork.log"
NODE_VERSION="$(tr -d '[:space:]' < "$PROJECT_DIR/.node-version")"
ACTION="${1:-help}"; [[ $# -eq 0 ]] || shift
[[ "$ACTION" != --help && "$ACTION" != -h ]] || ACTION=help
PUBLIC_IP=''; SELECTED_PORT=''; SELECTED_DB=''; FORCE=0
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
usage() {
  cat <<'HELP'
GoodWork Linux 安装与后台启动（保留已有 SQLite）
  bash scripts/linux.sh check [--db /已有数据库.sqlite]
  bash scripts/linux.sh install --public-ip 公网IPv4 [--port 3100] [--db /已有数据库.sqlite]
  bash scripts/linux.sh start | stop [--force] | restart | status | logs

默认数据库：项目目录/data/homepage-demo.sqlite。禁止初始化、迁移、清空或重置账号。
install 只安装和构建；start 才启动服务。已有配置会保留。首次配置必须提供公网 IP。
普通后台进程退出 SSH 后继续运行，不配置开机自启或自动重启。
HELP
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip|--port|--db)
      [[ $# -ge 2 && -n "$2" ]] || fail "$1 缺少参数"
      case "$1" in --public-ip) PUBLIC_IP="$2";; --port) SELECTED_PORT="$2";; --db) SELECTED_DB="$2";; esac
      shift 2;;
    --force) FORCE=1; shift;;
    -h|--help) usage; exit 0;;
    *) fail "未知参数：$1";;
  esac
done
[[ "$ACTION" != help ]] || { usage; exit 0; }
case "$ACTION" in check|install|start|stop|restart|status|logs) ;; *) fail "未知命令：$ACTION";; esac
if [[ "$ACTION" != install && "$ACTION" != check && -n "$PUBLIC_IP$SELECTED_PORT$SELECTED_DB" ]]; then
  fail 'IP、端口和数据库参数仅用于 install/check；修改配置请先 stop，再 install。'
fi
[[ "$(uname -s)" == Linux ]] || fail '此脚本仅支持 Linux；不会修改当前系统。'
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '.node-version 格式无效'
cd -- "$PROJECT_DIR"

os_value() { awk -F= -v key="$1" '$1==key {gsub(/"/,"",$2);print $2}' /etc/os-release; }
DISTRO="$(os_value ID)"
DISTRO_VERSION="$(os_value VERSION_ID)"
case "$DISTRO" in
  ubuntu|debian) PACKAGE_MANAGER=apt-get;;
  rocky|almalinux) PACKAGE_MANAGER=dnf;;
  centos)
    CENTOS_MAJOR="${DISTRO_VERSION%%.*}"
    [[ "$CENTOS_MAJOR" =~ ^[0-9]{1,2}$ ]] || fail '无法识别 CentOS 版本，请提供 /etc/os-release 内容。'
    (( 10#$CENTOS_MAJOR >= 8 )) || fail "检测到 CentOS ${DISTRO_VERSION}；本脚本不支持 CentOS 7 及更早版本。Node ${NODE_VERSION} 要求内核至少 4.18、glibc 至少 2.28；此为宿主直装限制；如已有本机 Docker，可执行 bash scripts/centos7-docker.sh check 验证容器路径。不会修改数据库。"
    PACKAGE_MANAGER=dnf;;
  *) fail "暂不支持发行版 ${DISTRO}；识别 Ubuntu/Debian/Rocky/AlmaLinux/CentOS 8 及以上版本，仍需满足内核和 glibc 要求。";;
esac
case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) fail "不支持 CPU 架构：$(uname -m)";; esac
version_at_least() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$2" ]]; }
GLIBC="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')" || fail '需要 glibc Linux，不能使用 musl/Alpine。'
version_at_least "$GLIBC" 2.28 || fail "glibc $GLIBC 低于 2.28，不能运行要求的 Node。"
version_at_least "$(uname -r | cut -d- -f1)" 4.18 || fail 'Linux 内核需要至少 4.18。'
NODE_BIN="$RUNTIME/node-v$NODE_VERSION-linux-$ARCH/bin/node"
if [[ ! -x "$NODE_BIN" ]] && command -v node >/dev/null && [[ "$(node -v)" == "v$NODE_VERSION" ]]; then NODE_BIN="$(command -v node)"; fi
have_node() { [[ -x "$NODE_BIN" && -x "$(dirname -- "$NODE_BIN")/npm" ]] && [[ "$("$NODE_BIN" -v 2>/dev/null)" == "v$NODE_VERSION" ]]; }

# Node parses env files; never source/eval configuration as shell code.
setting() {
  env -u HOST -u PORT -u PUBLIC_BASE_URL -u DATABASE_PATH -u DATABASE_MODE -u SERVE_WEB -u NODE_ENV \
    "$NODE_BIN" --env-file="$CONFIG" -e 'process.stdout.write(process.env[process.argv[1]] || "")' "$1"
}
load_config() {
  PORT=3100; DATABASE_PATH="$PROJECT_DIR/data/homepage-demo.sqlite"; PUBLIC_BASE_URL=''
  if [[ -f "$CONFIG" ]]; then
    have_node || fail "读取已有配置需要 Node $NODE_VERSION，请先运行 install。"
    PORT="$(setting PORT)"; DATABASE_PATH="$(setting DATABASE_PATH)"; PUBLIC_BASE_URL="$(setting PUBLIC_BASE_URL)"
  fi
  [[ -z "$SELECTED_PORT" ]] || PORT="$SELECTED_PORT"
  [[ -z "$SELECTED_DB" ]] || DATABASE_PATH="$SELECTED_DB"
  [[ "$PORT" =~ ^[0-9]+$ && ${#PORT} -le 5 ]] && (( 10#$PORT >= 1024 && 10#$PORT <= 65535 )) || fail '端口必须为 1024–65535 的整数。'
  [[ "$DATABASE_PATH" == /* ]] || DATABASE_PATH="$PROJECT_DIR/$DATABASE_PATH"
  [[ -f "$DATABASE_PATH" && -s "$DATABASE_PATH" ]] || fail "缺少已有数据库或文件为空：$DATABASE_PATH。不会创建新库。"
  [[ -r "$DATABASE_PATH" && -w "$DATABASE_PATH" && -w "$(dirname -- "$DATABASE_PATH")" ]] || fail "数据库及其目录需要当前运行用户读写权限：$DATABASE_PATH"
}
check_database() {
  "$NODE_BIN" --import tsx "$PROJECT_DIR/server/src/scripts/check-database.ts" "$DATABASE_PATH"
}
process_start() { local stat; stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1; printf '%s\n' "${stat##*) }" | awk '{print $20}'; }
running() {
  [[ -f "$PID_FILE" ]] || return 1
  read -r APP_PID APP_START < "$PID_FILE" || return 1
  [[ "$APP_PID" =~ ^[0-9]+$ && "$APP_START" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$APP_PID" 2>/dev/null || return 1
  [[ "$(process_start "$APP_PID")" == "$APP_START" ]] || return 1
  [[ "$(readlink -f "/proc/$APP_PID/cwd" 2>/dev/null)" == "$PROJECT_DIR" ]] || return 1
  tr '\0' '\n' < "/proc/$APP_PID/cmdline" | grep -Fxq "$PROJECT_DIR/server/src/main.ts"
}
port_free() { command -v ss >/dev/null || fail '缺少 ss，请先 install。'; ! ss -H -ltn "sport = :$PORT" | grep -q .; }
basic_check() {
  local errors=0
  info "系统：${DISTRO} ${DISTRO_VERSION} / $ARCH / glibc $GLIBC"
  info "项目：$PROJECT_DIR"
  [[ -w "$PROJECT_DIR" ]] || { info '缺少项目目录写权限'; errors=1; }
  local free_kb; free_kb="$(df -Pk "$PROJECT_DIR" | awk 'END{print $4}')"
  (( free_kb >= 1048576 )) || { info '磁盘可用空间不足 1 GiB'; errors=1; }
  info "可用磁盘：$((free_kb / 1024)) MiB；内存：$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo) MiB"
  for tool in curl tar xz sha256sum python3 make g++ flock ss nohup; do
    command -v "$tool" >/dev/null || { info "缺少工具：$tool"; errors=1; }
  done
  if have_node; then info "Node：$("$NODE_BIN" -v)"; else info "缺少匹配的 Node $NODE_VERSION（install 会安装到项目 .runtime）"; errors=1; fi
  load_config
  info "已有数据库：$DATABASE_PATH"
  if command -v ss >/dev/null; then
    if port_free; then info "端口 $PORT 可用"; elif running; then info "本项目已运行，PID $APP_PID"; else info "端口 $PORT 被其他服务占用"; errors=1; fi
  fi
  if have_node; then
    export PATH="$(dirname -- "$NODE_BIN"):$PATH"
    if "$NODE_BIN" -e 'require("better-sqlite3");require("tsx");require("@fastify/static")' 2>/dev/null; then
      check_database || errors=1
    else info '依赖不完整或 SQLite 原生模块不匹配，请运行 install'; errors=1; fi
  fi
  if command -v curl >/dev/null; then
    for url in "https://nodejs.org/download/release/v$NODE_VERSION/SHASUMS256.txt" 'https://registry.npmjs.org/'; do
      curl -fsSL --connect-timeout 5 --max-time 15 -o /dev/null "$url" || { info "无法访问：$url"; errors=1; }
    done
  fi
  return "$errors"
}
install_tools() {
  local missing=0
  for tool in curl tar xz sha256sum python3 make g++ flock ss nohup; do command -v "$tool" >/dev/null || missing=1; done
  (( missing )) || return 0
  local elevate=()
  if (( EUID != 0 )); then command -v sudo >/dev/null || fail "缺少基础工具且无 sudo；请管理员使用 $PACKAGE_MANAGER 安装 curl ca-certificates tar xz python3 make C++ 编译器 util-linux iproute2。"; elevate=(sudo); fi
  if [[ "$PACKAGE_MANAGER" == apt-get ]]; then
    "${elevate[@]}" apt-get update
    "${elevate[@]}" apt-get install -y curl ca-certificates tar xz-utils coreutils python3 make g++ util-linux iproute2
  else
    "${elevate[@]}" dnf install -y curl ca-certificates tar xz coreutils python3 make gcc-c++ util-linux iproute
  fi
}
install_node() {
  have_node && return 0
  local name="node-v$NODE_VERSION-linux-$ARCH" temp
  temp="$(mktemp -d "$RUNTIME/download.XXXXXX")"
  local url="https://nodejs.org/download/release/v$NODE_VERSION"
  curl -fSL --retry 2 --connect-timeout 10 --max-time 300 "$url/$name.tar.xz" -o "$temp/$name.tar.xz"
  curl -fsSL --retry 2 --connect-timeout 10 --max-time 60 "$url/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
  ( cd -- "$temp"; awk -v file="$name.tar.xz" '$2==file {print}' SHASUMS256.txt > selected.sha256
    [[ -s selected.sha256 ]] || fail '官方下载清单缺少所需文件'
    sha256sum -c selected.sha256
    tar -xJf "$name.tar.xz"
  )
  [[ ! -e "$RUNTIME/$name" ]] || fail "已有 Node 目录不可用，保留现场：$RUNTIME/$name"
  mv -- "$temp/$name" "$RUNTIME/$name"
  rm -rf -- "$temp"
  NODE_BIN="$RUNTIME/$name/bin/node"
  have_node || fail 'Node 安装后无法执行，请核对系统兼容性。'
}
write_config() {
  GW_INSTALL_IP="$PUBLIC_IP" GW_INSTALL_PORT="$PORT" GW_INSTALL_DB="$DATABASE_PATH" GW_INSTALL_URL="$PUBLIC_BASE_URL" \
    "$NODE_BIN" --input-type=module - "$CONFIG" <<'JS'
import {readFileSync,existsSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {isIP} from 'node:net';
const path=process.argv[2],env=process.env;
let url=env.GW_INSTALL_URL;
if(env.GW_INSTALL_IP){if(isIP(env.GW_INSTALL_IP)!==4)throw new Error('--public-ip 必须为公网 IPv4 地址');url=`http://${env.GW_INSTALL_IP}:${Number(env.GW_INSTALL_PORT)}`;}
if(!url)throw new Error('首次安装必须提供 --public-ip 公网IPv4');
const parsed=new URL(url);if(parsed.protocol!=='http:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('配置需要 HTTP IP 与端口访问地址');
if(isIP(parsed.hostname)!==4||parsed.hostname==='0.0.0.0')throw new Error('访问地址必须为有效服务器 IPv4，不能使用 0.0.0.0');
parsed.port=String(Number(env.GW_INSTALL_PORT));
const values={HOST:'0.0.0.0',PORT:String(Number(env.GW_INSTALL_PORT)),PUBLIC_BASE_URL:parsed.origin,DATABASE_PATH:env.GW_INSTALL_DB,DATABASE_MODE:'existing-only',SERVE_WEB:'true',NODE_ENV:'production'};
let text=existsSync(path)?readFileSync(path,'utf8'): '# GoodWork Linux：保留已有数据库，不自动迁移或初始化\n';
for(const [key,value] of Object.entries(values)){
 if(/[\r\n"\\]/.test(value))throw new Error(`${key} 包含不支持的换行、引号或反斜线`);
 const line=`${key}="${value}"`,pattern=new RegExp(`^${key}=.*$`,'m');
 text=pattern.test(text)?text.replace(pattern,()=>line):`${text.trimEnd()}\n${line}\n`;
}
const temp=path+'.tmp';writeFileSync(temp,text,{mode:0o600});chmodSync(temp,0o600);renameSync(temp,path);
JS
}
install_app() {
  running && fail "服务正在运行（PID $APP_PID），请先 stop，再安装。"
  # File checks precede downloads, dependency installation and building.
  if [[ ! -f "$CONFIG" ]]; then load_config; fi
  [[ -w "$PROJECT_DIR" ]] || fail '项目目录不可写。'
  local free_kb; free_kb="$(df -Pk "$PROJECT_DIR" | awk 'END{print $4}')"
  (( free_kb >= 1048576 )) || fail '磁盘可用空间不足 1 GiB。'
  install_tools; install_node
  export PATH="$(dirname -- "$NODE_BIN"):$PATH"
  load_config
  info '安装依赖（包含运行 TypeScript 服务需要的 tsx）…'
  npm ci --include=dev
  check_database
  npm run build
  write_config
  info "安装完成；原数据库保持不变。配置：$CONFIG"
  info '请使用原账号登录。执行 bash scripts/linux.sh start 启动。'
}
start_app() {
  running && { info "已运行，PID $APP_PID"; return; }
  have_node || fail "缺少 Node $NODE_VERSION，请先 install。"
  export PATH="$(dirname -- "$NODE_BIN"):$PATH"
  [[ -f "$CONFIG" ]] || fail '缺少 .env.linux，请先 install。'
  for tool in curl ss nohup; do command -v "$tool" >/dev/null || fail "缺少 $tool，请先 install。"; done
  load_config; check_database
  [[ -f "$PROJECT_DIR/client/dist/index.html" ]] || fail '缺少前端构建，请先 install。'
  port_free || fail "端口 $PORT 已占用，不会终止其他服务。"
  mkdir -p -- "$PROJECT_DIR/logs"
  # Redirect stdin as well as both outputs so an SSH disconnect cannot close the service.
  HOST=0.0.0.0 PORT="$PORT" PUBLIC_BASE_URL="$PUBLIC_BASE_URL" DATABASE_PATH="$DATABASE_PATH" DATABASE_MODE=existing-only SERVE_WEB=true NODE_ENV=production \
    nohup "$NODE_BIN" --env-file="$CONFIG" --import tsx "$PROJECT_DIR/server/src/main.ts" 9>&- </dev/null >>"$LOG_FILE" 2>&1 &
  local pid=$! stamp
  stamp="$(process_start "$pid")" || fail "Node 未成功启动，请查看 $LOG_FILE"
  printf '%s %s\n' "$pid" "$stamp" > "$PID_FILE"
  local ready=0
  for ((i=0;i<30;i++)); do
    running || break
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health/ready" >/dev/null; then ready=1; break; fi
    sleep 1
  done
  if (( ! ready )) || ! curl -fsS --max-time 5 "http://127.0.0.1:$PORT/login" | grep -q '<div id="app"'; then
    if running; then kill -TERM "$APP_PID"; fi
    tail -n 30 "$LOG_FILE" >&2
    fail "启动检查失败，请查看 $LOG_FILE"
  fi
  # Probe a real compiled asset, not just the SPA fallback.
  local asset; asset="$(sed -nE 's/.*src="(\/assets\/[^" ]+)".*/\1/p' client/dist/index.html | head -1)"
  if [[ -z "$asset" ]] || ! curl -fsS --max-time 5 "http://127.0.0.1:$PORT$asset" >/dev/null; then
    if running; then kill -TERM "$APP_PID"; fi
    fail "静态资源检查失败，请查看 $LOG_FILE"
  fi
  info "启动成功：$PUBLIC_BASE_URL/login（PID $APP_PID）"
  info "请放行主机防火墙及云安全组 TCP $PORT。本机检查通过，公网连通性请在其他设备验证。"
  info "日志：$LOG_FILE；使用原账号登录。公网 HTTP 传输不加密。"
}
stop_app() {
  if ! running; then info '服务未运行或 PID 记录已过期；未向其他进程发送信号。'; return; fi
  local pid="$APP_PID"
  kill -TERM "$pid"
  for ((i=0;i<20;i++)); do
    if ! running; then rm -f -- "$PID_FILE"; info '服务已停止。'; return; fi
    sleep 1
  done
  if (( FORCE )) && running; then kill -KILL "$APP_PID"; rm -f -- "$PID_FILE"; info '已强制停止本项目进程。'; else fail '进程仍在退出，请检查日志；必要时使用 stop --force。'; fi
}

case "$ACTION" in
  check) basic_check; exit $?;;
  status) if running; then info "运行中：PID $APP_PID"; else info '未运行'; exit 1; fi; exit 0;;
  logs) [[ -f "$LOG_FILE" ]] || fail '尚无运行日志'; exec tail -n 100 -f "$LOG_FILE";;
esac
umask 077
mkdir -p -- "$RUNTIME"
if ! command -v flock >/dev/null; then [[ "$ACTION" == install ]] || fail '缺少 flock，请先 install。'; install_tools; fi
exec 9>"$RUNTIME/control.lock"
flock -n 9 || fail '另一个安装或启动操作正在执行，请稍后重试。'
case "$ACTION" in install) install_app;; start) start_app;; stop) stop_app;; restart) stop_app; start_app;; esac
