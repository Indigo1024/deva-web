# 维护说明

这份文档讲的是：这东西以后坏了怎么修，平时要不要管。

它是**上游 Deva 桌面客户端的 Web 改版**——上游在正常发版，我们在后面追。所以没有"写完就不用管"的那一天，
每次上游发版都得跟一遍。这份文档的重点不是加功能，而是出问题时能快速定位，以及跟版时别踩坑。

---

## 它靠什么活着

整个项目只依赖四样东西，出问题一定是其中之一：

**上游仓库** —— `sqfcyily/deva`。它一改主进程的接口（IPC 通道、`BrowserWindow` 方法、`e.sender` 用法），
Web 版就跑不了了。这是最容易出问题的一环。

**数据目录 `$DEVA_HOME`** —— 默认 `/root/.deva`：账号密码、会话密钥（`web-auth.json`）、
免密链接、对话、人格、技能、密钥密文（`secrets.json` + `web-secret.key`）。它和源码树完全分离，
升级不动它——**这也是升级永远不会丢数据的原因**，别把这两样混在一起。

**Web 适配层** —— 我们自己的代码，四块：`src/web-server/`（服务端 + 桥接替身）、
`src/renderer/src/web/`（前端桥接 + 移动端样式）、`src/renderer/src/redesign/`（改过的界面）、
`scripts/build-web.mjs`（构建）。上游发版后需要检查的就是这四块。

**运行环境** —— Node 20+、`out/web/` 构建产物、Cloudflare 隧道（或 nginx）。
缺了会启动就报错，或者页面打开却连不上（WebSocket 起不来）。

排错顺序就按这个来：**先看是不是上游发版把接口改了，再看数据目录权限，最后才看具体功能**。别一上来就翻代码。

---

## 三种典型症状

### 服务起不来 / 起完端口不通

先看日志：

```bash
journalctl -u deva-web -n 80 --no-pager
```

| 日志里看到 | 意思 | 怎么办 |
|---|---|---|
| `No matching export in ".../browser-unavailable.ts" for import "xxx"` | 上游给浏览器模块加了新导出，我们的替身缺一个 | 在 `browser-unavailable.ts` 里补上同名空实现（照抄上游签名） |
| `preload 结构变了：找不到 electron import` | 上游改了 preload 顶部的 electron 导入行 | 改 `scripts/gen-web-api.mjs` 的匹配规则，然后重跑它 |
| `Cannot find module 'electron'` | 构建时的 `electron` 替身没生效 | 确认 `node scripts/build-web.mjs` 跑的是一份全新构建，不是旧的 `out/web` |
| `EADDRINUSE` | 端口被别的服务占了 | 换 `DEVA_WEB_PORT`（本机 8786 是它自己的） |

### 页面能打开，但一直"正在重连…"或直接白屏

九成是 WebSocket 没握上手。按顺序查：

1. 浏览器控制台看 `/ws` 的返回码。**403** = Origin 校验拒了（反代没透传 `Host`，见 `docs/WEB.md` 的安全环境变量）；
   **401** = 会话过期，重新打开免密链接就行。
2. 从服务器本地绕开隧道测一遍（确认不是隧道的问题）：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' <你的域名>/login
   ```

   这条返回 200 说明服务本身活着，问题在浏览器与隧道之间。
3. 隧道状态：`cloudflared` 那几个连接是不是还在（`systemctl status cloudflared-*`）。

### 某个功能不对（升级之后才出现）

先确认是不是"上游改了、我们没跟"：

```bash
cd /opt/deva-web
git log --oneline -5 upstream/main          # 上游最近提交
git log --oneline -3                        # 我们跟到哪了
```

然后按 `docs/WEB.md` 的「维护：合并上游新版本」检查清单走一遍。**改之前先确认"是不是真的坏了"**：
很多"功能没了"其实是上游把入口挪了位置（例如右键菜单挪到顶栏），不是坏了。

---

## 平时要不要管

推荐只做两件事：

一是**打开「设置 → 关于」，看版本三件套**：上游版本、Web 版版本、以及"运行中 / 源码"的提交号是否一致。
出现「待构建」说明源码换了但产物没重打，按下面的标准流程重来一遍即可。

二是**偶尔看看服务状态**：

```bash
systemctl status deva-web          # active 且 NRestarts 不涨就正常
journalctl -u deva-web --since "1 hour ago" | grep -iE "error|失败" | head
```

不用做的：不用定时重启（systemd 配了 `Restart=always`）；不用手清 `out/web`；
不用管 `/root/.deva/data/chats` 之类（对话自己会随用随写）。
**唯一要主动做的是跟上游发版**，以及**别忘了备份 `web-secret.key`**。

---

## 跟随上游发版（最常做的一件事）

```bash
cd /opt/deva-web
git fetch upstream --tags
git log --oneline -20 upstream/main      # 看这次改了什么

# 1) 先备份分支（出错能整体退回）
git branch -f backup/pre-merge-upstream-XXX-$(date +%Y%m%d-%H%M) HEAD

# 2) 合并
git merge --no-ff upstream/main
```

冲突处理原则（本项目固定口径）：

| 冲突文件 | 怎么解 |
|---|---|
| `README.md` / `README.en.md` | **保留我们的**（改版说明）；上游那份是桌面版的口径 |
| `docs/index.html`、`docs/screenshot*.png` | **不要**（本仓库不放上游的官网与截图） |
| `.github/workflows/release.yml` | **不要**（本仓库不发 Electron 安装包） |
| `src/web-server/*`、`src/renderer-web/*`、`src/renderer/src/web/*` | 上游不该动这些；动了要逐个看清是不是把我们的适配冲掉了 |
| `ChatFirstShell.tsx`、`composer-editor.ts`、`redesign.css` | **两边都要**：我们的消息操作行 / 滚动模型 / 移动端粘贴保留，上游的新组件并入 |
| 其余业务代码 | 以上游为准，只在类型/枚举上补我们的分支（如附件的 `serverPath` 模式） |

合并后必跑（顺序固定，别跳）：

```bash
cd /opt/deva-web/apps/desktop
node scripts/gen-web-api.mjs     # preload 变了就必须重跑（生成 window.deva 桥接）
npm run typecheck                # node + web 两侧
node scripts/build-web.mjs       # Web 包（含 browser 替身替换）
cd /opt/deva-web && pnpm build   # 桌面端构建：确认没把渲染层改坏
node apps/desktop/scripts/verify-security-hardening.mjs   # 安全用例回归
```

全绿之后再：改 `web-version.json` 版本号 → 提交 → 重建 → 重启 → 冒烟（见下）。

---

## 改完代码要跑这几步

```bash
cd /opt/deva-web/apps/desktop
npm run typecheck && node scripts/build-web.mjs
cd /opt/deva-web && pnpm build
systemctl restart deva-web
```

冒烟（20 秒）：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
systemctl is-active deva-web
curl -s -o /dev/null -w '/login %{http_code}\n' http://127.0.0.1:8786/login
curl -s -o /dev/null -w '公网 %{http_code}\n' <你的域名>/login
cat apps/desktop/out/web/build-info.json     # 提交号 == git rev-parse --short HEAD 才对
```

界面上再点一遍：开一个对话发条消息（模型请求通不通）、打开设置看关于页、手机上滑一下对话。

---

## 改代码要注意的

这几条都是踩过坑总结的。

### 构建产物里的提交号要在提交之后重建

`build-info.json` 的 commit 是构建时从源码树 `git rev-parse` 读的。先构建再提交的话，
关于页会把上一个提交当成"当前跑的版本"，一直显示「待构建」。**顺序固定：改代码 → 提交 → 构建 → 重启。**

### 本机有全局代理，脚本要剥掉

本机 `HTTP_PROXY/HTTPS_PROXY` 是全局设的，`git clone`、`pnpm install`、以及任何打
`http://127.0.0.1:…` 的脚本都会被送去代理（表现为 `Proxy CONNECT aborted`、403、空响应）。
所有这类命令前面加：

```bash
env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy
```

### preload 改了就必须重跑 gen-web-api

`src/renderer/src/web/deva-api.gen.ts` 是从 `src/preload/index.ts` 机械生成的（175+ 个通道），
手改它下次生成就没了。上游加一个 `window.deva` 方法，跑一次脚本就够。

### 不要用界面里的「检查更新」升级

它拉的是**上游桌面版**的发布，不是我们的改版；本地提交领先远端时它还会把线上切回旧构建。
升级只走本文的 git 流程。

### 改渲染层要两种构建都过

`build-web.mjs`（Web 包）和 `pnpm build`（桌面端）用的是同一份渲染层源码。
只跑一边的话，另一边可能已经编译不过了——上游随时可能用到新的类型。

### CSS 顺序是硬约束

`renderer-web/main.tsx` 里 `web.css` / `mobile.css` 必须排在 `App`（连带 `redesign.css`）之后，
否则手机端覆盖规则全被桌面规则压掉，界面退化成"被压小的桌面版"。`build-web.mjs` 里有护栏校验，
顺序错了构建会直接失败——**别去改那个顺序，改的是你新增样式的归属文件**。

---

## 什么时候该动架构

出现下面这些情况，说明当前做法到瓶颈了，再打补丁也没用：

**想要内置浏览器** —— 这是目前唯一的"上游有、我们没有"的功能。它靠 Electron 的
`WebContentsView` 叠窗口 + CDP，服务端没有窗口体系。要做得另写一份基于无头 Chromium 的
pages/host 实现（CDP 那半可以复用）。这是独立的一件事，不是"适配一下"能解决的。

**多人用同一个服务** —— 当前是单管理员、无权限体系、无审计日志。
真要多用户，得先在数据层分出用户空间，不是加个登录页就完事。

**不想让 agent 的权限等于服务进程** —— 现在 agent 的终端与文件工具没有限制，
唯一边界是登录墙。正解是换一个专用低权限 Linux 用户跑服务，靠操作系统隔离，
而不是在文件工具里加路径黑名单（终端一条命令就能绕过去）。

---

## 发版（打 tag + 写 Release）

版本号有两套，一起改：`VERSION`（仓库级）与 `apps/desktop/web-version.json`（渲染层读到"关于"页的那个）。
两者保持同一个号（当前 1.7.7）。

```bash
cd /opt/deva-web
# 1) 改版本号（两处都要）
echo 1.7.8 > VERSION
$EDITOR apps/desktop/web-version.json      # webVersion 改成 1.7.8

# 2) 提交 → 重建（顺序不能反，否则"关于"页的提交号会滞后）
git add -A && git commit -m "chore: 版本号 1.7.7 → 1.7.8"
cd apps/desktop && node scripts/build-web.mjs && cd /opt/deva-web

# 3) 推 main + 打 tag 并推送
git push origin main
git tag -f v1.7.8 -m "Web 改版 1.7.8（跟随上游 v0.1.x）" HEAD
git push origin v1.7.8

# 4) 写 Release（说明写给人看：这版同步了上游什么、网页端哪里不同、怎么升级）
gh release create v1.7.8 --repo Indigo1024/deva-web \
  --title "Web 改版 v1.7.8 — 跟随上游 Deva v0.1.x" \
  --notes-file /tmp/release-notes.md --latest
```

Release 说明建议包含四段：**这一版是什么 / 上游同步过来的新能力 / 网页端的不同（降级说明）/ 本版校验**。
最后一段写实测结果（typecheck、两种构建、安全用例、线上冒烟），别只写"已修复"。

⚠️ 别把上游的 tag（`v0.1.x`，那是 `git fetch upstream --tags` 带进来的、指向上游提交）
推到本仓库——只推 `v1.7.x` 这一条线。

---

## 常用命令

```bash
# 服务
systemctl status deva-web
systemctl restart deva-web
journalctl -u deva-web -n 100 --no-pager

# 改密码（会作废所有已登录会话与现有免密链接，必须重发链接）
cd /opt/deva-web/apps/desktop
DEVA_HOME=/root/.deva node out/web/ctl.cjs passwd '<新密码>'

# 构建 / 校验
node scripts/gen-web-api.mjs
npm run typecheck
node scripts/build-web.mjs
cd /opt/deva-web && pnpm build
node apps/desktop/scripts/verify-security-hardening.mjs

# 看后端在跑哪一版
cat apps/desktop/out/web/build-info.json
git log --oneline -3

# 数据目录（升级不动它，但也别乱删）
ls -la /root/.deva/          # web-auth.json / web-secret.key / secrets.json / admin-password.txt / magic-link.txt
```

四个凭据文件的位置与用途，见 `docs/WEB.md` 的认证章节；`web-secret.key` **必须和 `secrets.json` 一起备份**，
丢了它旧密文就解不开了。

---

## 后续待办

按"值不值得做"排，不是按"想不想做"。

1. **内置浏览器上服务端**（唯一的真缺口）—— 写一份无头 Chromium 的 pages/host，复用上游的 CDP 逻辑，
   把 `browser-unavailable.ts` 换成真实现。工作量大，但是和桌面版功能对齐的最后一块。
2. **用低权限用户跑服务** —— 现在服务以 root 跑，agent 的终端等于 root shell。
   建一个专用用户、把 `$DEVA_HOME` 与 `/opt/deva-web` chown 过去，是最划算的一层加固。
3. **在线更新接到 Release** —— 现在「检查更新」读的是仓库分支的最新提交与 `web-version.json`，
   tag/Release 已经打起来了（见上一节），下一步可以让它优先比对 Release 版本号，
   别人部署的实例就能一眼看出"落后几个版本"。
4. **多用户 / 审计日志** —— 多人共用时的前置条件，见上一节。
5. **移动端继续打磨** —— 长文本粘贴、滚动回拉这几处已经修好；
   剩下的多是手感问题（输入框高度、键盘弹起时的布局），有具体案例再动。

---

## 许可

上游 [sqfcyily/deva](https://github.com/sqfcyily/deva) 是 MIT；Web 适配层同样 MIT，随便部署随便改。
