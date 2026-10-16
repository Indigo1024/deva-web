#!/usr/bin/env bash
# Deva Web 一键启动脚本
set -e
cd "$(dirname "$0")"

export DEVA_HOME="${DEVA_HOME:-$PWD/.deva}"
export DEVA_WEB_PORT="${DEVA_WEB_PORT:-8790}"
export DEVA_WEB_HOST="${DEVA_WEB_HOST:-127.0.0.1}"
export DEVA_WEB_STATIC="${DEVA_WEB_STATIC:-$PWD/app/renderer}"
export NODE_ENV=production

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js >= 20。" >&2
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "警告：当前 Node 版本 $(node -v) 低于 20，可能无法运行。" >&2
fi

echo "==============================================="
echo "  Deva Web 启动中..."
echo "  地址:     http://$DEVA_WEB_HOST:$DEVA_WEB_PORT"
echo "  数据目录: $DEVA_HOME"
echo "  首次启动后，管理员密码见: $DEVA_HOME/web-login.txt"
echo "==============================================="

exec node app/index.cjs
