#!/usr/bin/env sh
# 无人深空 · 电力模拟器 本地一键启动脚本（macOS / Linux）
# 默认端口 8900（8899 已被同目录其它项目占用），占用时自动 +1。
PORT=8900
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

echo "============================================"
echo "  无人深空 · 电力模拟器 本地服务"
echo "============================================"
echo ""

# 端口占用检测（若系统有 lsof）
while command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  echo "[提示] 端口 $PORT 已被占用，尝试下一个端口…"
  PORT=$((PORT + 1))
done

open_browser() {
  URL="http://localhost:$PORT/"
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1
  fi
}

if command -v python3 >/dev/null 2>&1; then
  ( sleep 1; open_browser ) &
  echo "正在启动 Python 静态服务器： http://localhost:$PORT/"
  echo "关闭此终端即停止服务"
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  ( sleep 1; open_browser ) &
  echo "正在启动 Python 静态服务器： http://localhost:$PORT/"
  echo "关闭此终端即停止服务"
  exec python -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  ( sleep 1; open_browser ) &
  echo "正在启动 Node serve 静态服务器： http://localhost:$PORT/"
  echo "关闭此终端即停止服务"
  exec npx --yes serve -l "$PORT" .
else
  echo "[错误] 未检测到 python3 / python / npx，请先安装其中之一。"
  exit 1
fi
