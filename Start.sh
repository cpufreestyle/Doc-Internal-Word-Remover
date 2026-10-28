#!/bin/bash
#==============================================================
# 文档敏感词批量清除工具 - UOS / Linux 本地服务器启动脚本
#
# 功能与 Windows 的 Start.bat 对等：
#   1. 自动探测可用端口（8080 起，占用则顺延，上限 8099）
#   2. 优先使用 Python 启动 http.server，其次 npx serve
#   3. 自动用默认浏览器打开页面
#   4. 退出时自动清理后台服务进程
#
# UOS / 统信桌面版 / Deepin / 通用 Linux 均可使用。
#==============================================================

set -e

# ---- 定位脚本所在目录（支持符号链接） ----
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
cd "$SCRIPT_DIR"

# ---- 横幅 ----
echo "========================================"
echo "  文档敏感词批量清除工具 - 本地服务器"
echo "  UOS / Linux 版"
echo "========================================"
echo ""

# ---- 自动探测可用端口 ----
PORT=8080
while [ $PORT -le 8099 ]; do
  if ! ss -tln 2>/dev/null | grep -q ":$PORT " ; then
    break
  fi
  # ss 不可用时回退到 /proc 检测
  if ! grep -q ":$(printf '%04X' $PORT) " /proc/net/tcp 2>/dev/null; then
    break
  fi
  PORT=$((PORT + 1))
done

if [ $PORT -gt 8099 ]; then
  echo "8080-8099 端口均被占用，请手动释放后重试。"
  read -p "按回车键退出..."
  exit 1
fi

# ---- 检测可用的 HTTP 服务器 ----
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

if command -v python3 &>/dev/null; then
  echo "检测到 Python3，正在 http://127.0.0.1:$PORT 启动服务..."
  python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SCRIPT_DIR" &
  SERVER_PID=$!

elif command -v python &>/dev/null && python -c 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)' &>/dev/null; then
  echo "检测到 Python3，正在 http://127.0.0.1:$PORT 启动服务..."
  python -m http.server "$PORT" --bind 127.0.0.1 --directory "$SCRIPT_DIR" &
  SERVER_PID=$!

elif command -v npx &>/dev/null; then
  echo "检测到 Node.js (npx)，正在 http://127.0.0.1:$PORT 启动服务..."
  npx --yes serve -l "tcp://127.0.0.1:$PORT" "$SCRIPT_DIR" &
  SERVER_PID=$!

else
  echo "未检测到 Python 3 或 Node.js。"
  echo "请安装其一后再运行本脚本，或直接用浏览器打开 index.html。"
  echo ""
  echo "  UOS 安装 Python3：sudo apt install python3"
  echo "  UOS 安装 Node.js：sudo apt install nodejs npm"
  echo ""
  read -p "按回车键退出..."
  exit 1
fi

# ---- 等待服务就绪 ----
sleep 2
URL="http://127.0.0.1:$PORT/index.html"
echo ""
echo "服务已启动：$URL"
echo "按 Ctrl+C 退出（将自动关闭后台服务）"
echo ""

# ---- 打开浏览器 ----
# UOS / Deepin 默认浏览器
if command -v xdg-open &>/dev/null; then
  xdg-open "$URL" 2>/dev/null &
elif command -v deepin-open &>/dev/null; then
  deepin-open "$URL" 2>/dev/null &
elif command -v sensible-browser &>/dev/null; then
  sensible-browser "$URL" 2>/dev/null &
else
  echo "无法自动打开浏览器，请手动访问：$URL"
fi

# ---- 前台等待，直到用户 Ctrl+C ----
wait "$SERVER_PID" 2>/dev/null
