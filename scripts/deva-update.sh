#!/usr/bin/env bash
#
# Deva Web 一键升级脚本（服务器端）
#
# 用途：在服务器上把 Deva Web 更新到改版仓库的最新版本。
#       这是「设置 → 关于 → 检查更新」的等价命令行版本，也是旧版本首次升级的入口
#       （旧构建里还没有在线更新代码，需要先在服务器上跑一次本脚本）。
#
# 用法：
#   ./deva-update.sh            # 更新到远端最新
#   ./deva-update.sh --check    # 只检查是否有新版
#   ./deva-update.sh --rollback # 回滚到上一份产物备份
#
# 设计：
#   · 源码用 git fetch + git archive 导出，不动工作区（本地改动不会丢）
#   · 构建在临时目录进行，失败不动线上产物
#   · 成功后切换 out/web 并重启服务
#   · 旧产物保留最近 2 份，可回滚
set -uo pipefail

REPO_DIR="${DEVA_REPO_DIR:-/root/deva-src}"
SERVICE="${DEVA_SERVICE:-deva-web}"
WEB_REMOTE="${DEVA_WEB_REMOTE:-web}"
BRANCH="${DEVA_WEB_BRANCH:-main}"
BUILD_DIR="$REPO_DIR/.deva-update-build"
LIVE_OUT="$REPO_DIR/apps/desktop/out/web"
LOG="${DEVA_HOME:-/root/.deva}/web-update.log"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
die() { log "❌ 失败：$*"; exit 1; }

cd "$REPO_DIR" || die "仓库目录不存在：$REPO_DIR"

# ── 回滚 ──────────────────────────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
  OUT_ROOT="$REPO_DIR/apps/desktop/out"
  BAK=$(ls -1d "$OUT_ROOT"/web.bak.* 2>/dev/null | sort | tail -1)
  [[ -z "$BAK" ]] && die "没有可回滚的备份"
  log "回滚到 $(basename "$BAK")"
  [[ -d "$LIVE_OUT" ]] && mv "$LIVE_OUT" "$OUT_ROOT/web.failed.$(date +%s)"
  mv "$BAK" "$LIVE_OUT" || die "移动备份失败"
  systemctl restart "$SERVICE" || die "重启失败"
  log "✅ 已回滚并重启"
  exit 0
fi

# ── 检查更新 ──────────────────────────────────────────────────────
log "════════ 检查更新 ════════"
git fetch --quiet "$WEB_REMOTE" "$BRANCH" || die "git fetch 失败（remote=$WEB_REMOTE）"
TARGET=$(git rev-parse "$WEB_REMOTE/$BRANCH")
CUR_VER=$(python3 -c "import json;print(json.load(open('apps/desktop/package.json'))['version'])" 2>/dev/null || echo "?")
NEW_VER=$(git show "$TARGET:apps/desktop/package.json" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null || echo "?")
NEW_WEB_VER=$(git show "$TARGET:apps/desktop/web-version.json" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('webVersion','?'))" 2>/dev/null || echo "?")

log "当前版本：上游 $CUR_VER"
log "远端版本：上游 $NEW_VER / Web 改版 $NEW_WEB_VER (${TARGET:0:8})"

if [[ "$CUR_VER" == "$NEW_VER" ]]; then
  log "已是最新，无需更新"
  exit 0
fi

[[ "${1:-}" == "--check" ]] && { log "有新版本可用（未安装）"; exit 0; }

# ── 构建 ──────────────────────────────────────────────────────────
log "════════ 开始更新 ════════"
rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR" || die "无法创建构建目录"
log "导出源码 ${TARGET:0:8}…"
git archive "$TARGET" | tar -x -C "$BUILD_DIR" || die "导出源码失败"

# 依赖：package.json 有变化才重新装
CUR_DEPS=$(python3 -c "import json;d=json.load(open('apps/desktop/package.json'));print(json.dumps([d.get('dependencies',{}),d.get('devDependencies',{})],sort_keys=True))" 2>/dev/null)
NEW_DEPS=$(python3 -c "import json;d=json.load(open('$BUILD_DIR/apps/desktop/package.json'));print(json.dumps([d.get('dependencies',{}),d.get('devDependencies',{})],sort_keys=True))" 2>/dev/null)
if [[ "$CUR_DEPS" != "$NEW_DEPS" ]]; then
  log "依赖有变化，安装中…"
  (cd "$BUILD_DIR" && pnpm install --filter @deva/desktop) || die "依赖安装失败"
else
  log "依赖无变化，复用 node_modules"
  [[ -d "$REPO_DIR/node_modules" ]] && ln -sfn "$REPO_DIR/node_modules" "$BUILD_DIR/node_modules"
  [[ -d "$REPO_DIR/apps/desktop/node_modules" ]] && ln -sfn "$REPO_DIR/apps/desktop/node_modules" "$BUILD_DIR/apps/desktop/node_modules"
fi

log "生成桥接…"
(cd "$BUILD_DIR/apps/desktop" && node scripts/gen-web-api.mjs) || die "生成桥接失败"
log "构建中（约 10–90 秒）…"
(cd "$BUILD_DIR/apps/desktop" && NODE_ENV=production node scripts/build-web.mjs) || die "构建失败"

NEW_OUT="$BUILD_DIR/apps/desktop/out/web"
[[ -f "$NEW_OUT/index.cjs" && -f "$NEW_OUT/renderer/index.html" ]] || die "构建产物不完整"

# ── 切换 ──────────────────────────────────────────────────────────
OUT_ROOT="$REPO_DIR/apps/desktop/out"
BAK="$OUT_ROOT/web.bak.$(date +%s)"
log "切换产物…"
[[ -d "$LIVE_OUT" ]] && mv "$LIVE_OUT" "$BAK"
if ! mv "$NEW_OUT" "$LIVE_OUT"; then
  [[ -d "$BAK" && ! -d "$LIVE_OUT" ]] && mv "$BAK" "$LIVE_OUT"
  die "切换产物失败（已还原）"
fi
log "旧产物备份：$(basename "$BAK")"

# 只留最近 2 份
ls -1d "$OUT_ROOT"/web.bak.* 2>/dev/null | sort | head -n -2 | xargs -r rm -rf

echo "{\"version\":\"$NEW_VER\",\"webVersion\":\"$NEW_WEB_VER\",\"target\":\"$TARGET\",\"at\":$(date +%s)000}" \
  > "$REPO_DIR/.deva-update-pending.json"

rm -rf "$BUILD_DIR"
log "重启服务…"
systemctl restart "$SERVICE" || die "重启失败"
log "✅ 更新完成：上游 $NEW_VER / Web 改版 $NEW_WEB_VER"
