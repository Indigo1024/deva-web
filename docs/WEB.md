# Deva Web 改版 · 部署与维护

把 [Deva](https://github.com/sqfcyily/deva) 桌面客户端搬到浏览器里用。

> **这是非官方的第三方改版，不是 Deva 官方项目。**
> 作者与上游开发者无关联，未获授权，也不代表上游立场。
>
> - 上游项目：**[sqfcyily/deva](https://github.com/sqfcyily/deva)**
> - 上游官网：**https://sqfcyily.github.io/deva/**
> - 上游许可：MIT
>
> 本仓库不发布 Electron 安装包，需要桌面客户端请去上游下载。

本文档只讲**本改版自己的东西**：Web 层怎么搭的、怎么部署、怎么跟随上游更新。
上游 Deva 本身有哪些功能，属于上游的成果，请查阅[上游项目](https://github.com/sqfcyily/deva)。

当前跟随的上游版本：**v0.1.9**。

---

## 改版做了什么

上游是 Electron 桌面应用，一人装一份。本改版把它改成 **一个 Node 进程 + 浏览器前端**，服务端装一次即可多设备访问。

实现方式是**在 Electron 边界打替身**，不重写业务逻辑：构建时把 `'electron'` 模块替换成纯 Node 替身，让主进程服务代码原样运行；再把 preload 的 `window.deva` 经 WebSocket 一比一桥接到浏览器。

---

## 和桌面版的区别

下表描述的是**运行形态的差异**，不是功能对比：

| 维度 | 上游桌面版 | 本改版 |
| --- | --- | --- |
| 运行形态 | Electron 应用 | 纯 Node.js 进程 + 浏览器 |
| 分发方式 | 每人装一份 | 服务端一份，多设备访问 |
| 登录 | 系统账户 | 用户名 + 强密码（scrypt）+ HttpOnly Cookie |
| 文件选择器 | 系统原生对话框 | 服务端目录浏览（浏览服务器文件系统） |
| 终端 | 本机 PTY | 服务器上的 PTY（**等于给了服务器 shell**） |
| 系统通知 | 桌面通知 | 浏览器 Notification / 页面内提示 |
| 交付文件 | 用默认应用打开 | 浏览器下载 |
| 自动更新 | electron-updater | 不适用（更新 = 重新构建部署） |

⚠️ **本改版把桌面应用的完整权力搬到了浏览器**：agent 的文件工具**没有路径限制**，终端命令**没有命令白名单**。唯一的安全边界就是那道登录墙。**不要把这个服务暴露在公网且用弱密码**，也不要在多人共用的机器上跑。

---

## 快速开始

需要 Node.js 20 以上、pnpm，以及 Linux（x64/arm64）。

```bash
git clone https://github.com/Indigo1024/deva-web.git
cd deva-web

pnpm install                       # 安装依赖（Electron 不会被下载，本改版用不到）
cd apps/desktop
node scripts/gen-web-api.mjs       # 生成 window.deva 的 Web 桥接（改了 preload 就要重跑）
node scripts/build-web.mjs         # 构建：服务端 bundle + 前端静态资源
```

构建产物在 `apps/desktop/out/web/`：

```
out/web/
├── index.cjs          # 服务端（HTTP + WebSocket + 全部 main 服务）
├── ctl.cjs            # 运维工具（改密码等）
├── pty-host.js
├── pty-worker.cjs
└── renderer/          # 前端静态资源
```

启动：

```bash
DEVA_HOME=$HOME/.deva \
DEVA_WEB_PORT=8790 \
DEVA_WEB_HOST=127.0.0.1 \
DEVA_WEB_STATIC=$PWD/out/web/renderer \
node out/web/index.cjs
```

首次启动会生成登录凭据，写在 `$DEVA_HOME/web-login.txt`（权限 0600）：

```bash
cat ~/.deva/web-login.txt
```

然后浏览器打开 `http://127.0.0.1:8790`。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEVA_HOME` | `~/.deva` | 数据目录：配置、密钥、对话、人格、技能 |
| `DEVA_WEB_PORT` | `8790` | 监听端口 |
| `DEVA_WEB_HOST` | `127.0.0.1` | 监听地址（对外请走反向代理/隧道，别直接 `0.0.0.0`） |
| `DEVA_WEB_STATIC` | `out/web/renderer` | 前端静态资源目录 |
| `DEVA_WEB_PASSWORD` | 随机生成 | 首次初始化时的管理员密码（设了就不随机） |

### 改密码 / 重置会话

```bash
node out/web/ctl.cjs passwd        # 交互式改密码，会同时作废所有已登录会话
```

---

## 部署为系统服务

```ini
# /etc/systemd/system/deva-web.service
[Unit]
Description=Deva Web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/deva-web/apps/desktop
Environment=NODE_ENV=production
Environment=DEVA_HOME=/root/.deva
Environment=DEVA_WEB_PORT=8790
Environment=DEVA_WEB_HOST=127.0.0.1
Environment=DEVA_WEB_STATIC=/opt/deva-web/apps/desktop/out/web/renderer
ExecStart=/usr/local/bin/node /opt/deva-web/apps/desktop/out/web/index.cjs
Restart=always
RestartSec=3
# 有活跃对话时优雅退出要等，给足时间
TimeoutStopSec=150
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now deva-web
```

`TimeoutStopSec` 别设太小：正在跑对话时，服务要等当前轮次收尾，短了会被 SIGKILL 打断，下次启动还得重新注册所有 MCP 子进程（可能慢几分钟）。

---

## 公网访问

推荐 Cloudflare Tunnel（不需要开防火墙端口、自带 TLS）：

```bash
cloudflared tunnel route dns <隧道名> deva.example.com
```

在隧道的 `config.yml` ingress 里加一条：

```yaml
ingress:
  - hostname: deva.example.com
    service: http://127.0.0.1:8790
  - service: http_status:404
```

WebSocket（`/ws`）会跟着 HTTP 一起走，不用额外配置。

### 反向代理（nginx）

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

---

## 架构

本改版没有重写业务逻辑，而是在 Electron 边界上做替身，让 `src/main/services/*`（约 1.7 万行）原样跑在纯 Node 里。

```
浏览器
  │  window.deva（与 preload 1:1 的 API 面，自动生成）
  │  HTTP  +  WebSocket /ws
  ▼
web-server/index.ts        HTTP 路由、认证、静态资源、WS RPC 调度
  ├── bus.ts               事件总线：broadcast（等价 webContents.send）、webWindow 替身
  ├── electron-shim.ts     'electron' 模块替身
  └── ../../main/services/*  桌面版原班业务代码，零改动
```

### 关键设计

**1. Electron 模块替身**（`electron-shim.ts`）

构建时用 esbuild alias 把 `'electron'` 换成本文件，`'electron-updater'` 换成 stub。替身覆盖：

| Electron API | Web 替身 |
| --- | --- |
| `ipcMain.handle` | 内存注册表，由 WS RPC 调度器驱动 |
| `app` | 极简替身（`getPath` / `getVersion` / `whenReady`…） |
| `BrowserWindow` | 无窗口体系，`webWindow()` 提供形状兼容的空实现 |
| `safeStorage` | AES-256-GCM，密钥落 `~/.deva/web-secret.key`（0600） |
| `dialog` | 往返浏览器端「服务器文件选择器」 |
| `clipboard` | 缓存 + 往返浏览器 `navigator.clipboard` |
| `Notification` | 广播给前端弹通知，点击可回传 |
| `shell` | `openExternal` 转发浏览器新开标签 |
| `nativeImage` | pngjs / jpeg-js |
| `utilityProcess` | `worker_threads`（PTY 宿主） |

**2. `window.deva` 桥接是生成的，不要手改**

`src/renderer/src/web/deva-api.gen.ts` 由 `scripts/gen-web-api.mjs` 从 `src/preload/index.ts` 机械生成。改了 preload（哪怕只改类型），必须重跑：

```bash
node scripts/gen-web-api.mjs
```

**3. `e.sender` 的 Web 语义**

桌面里 IPC handler 的 `e.sender` 是 `WebContents`，可以 `.send()` 边跑边推中间结果（例如 AI 生成提交信息的流式片段）、可以 `.once('destroyed')` 在窗口关闭时中断。Web 里没有 WebContents，`makeSender()` 给了一个按连接定向的替身：

- `send(channel, ...)` → 只推给发起这次 invoke 的那条 WebSocket（**不是广播**，与桌面语义一致）
- `once('destroyed')` / `markDestroyed()` → 连接断开时触发，让后端提前中断，不空跑

**如果给 `null`，上游一碰就 `TypeError`。** 这是合并上游新版本时最容易踩的坑。

**4. 认证**

- 密码 scrypt 加盐哈希，落 `$DEVA_HOME/web-auth.json`
- 会话是无状态签名 token：`<exp>.<hmac>`，HttpOnly + SameSite=Lax Cookie，30 天
- 失败限速：同一 IP 5 次失败锁 10 分钟
- 未认证访问 `/` 和 `/index.html` → **302 到 `/login`**（服务端重定向，前端不会先闪一下应用界面）
- 站点图标、manifest、`/assets/*` 免认证（浏览器匿名请求这些，不豁免会在控制台刷 401）

---

## Web 层目录

```
apps/desktop/src/
├── web-server/                 # 服务端（新增）
│   ├── index.ts                #   HTTP + WS + 全部 IPC 装配
│   ├── electron-shim.ts        #   'electron' 替身 + makeSender
│   ├── bus.ts                  #   事件总线 / webWindow
│   ├── auth.ts                 #   密码哈希、签名会话
│   ├── login-page.ts           #   登录页（服务端渲染）
│   ├── ctl.ts                  #   改密码等运维命令
│   ├── native-image.ts         #   nativeImage 替身
│   ├── electron-updater-stub.ts
│   └── pty-worker.cjs
├── renderer/src/web/           # 前端 Web 层（新增）
│   ├── web-ipc.ts              #   WS RPC 客户端（重连/心跳/僵尸连接检测）
│   ├── deva-api.gen.ts         #   window.deva 桥接（生成物）
│   ├── boot.ts                 #   启动闪屏状态机
│   ├── web.css / mobile.css    #   Web 与移动端样式覆盖
│   ├── FilePicker.tsx          #   服务端文件选择器
│   └── MobileMenuButton.tsx
└── renderer-web/               # Vite 入口（新增）
    ├── index.html
    ├── main.tsx
    └── public/                 # 图标、manifest、theme-init
```

---

## 移动端

移动端是 **纯 CSS** 的 `@media (max-width: 719px)` 覆盖（`renderer/src/web/mobile.css`），不压缩桌面布局，而是换成移动端结构：

- 侧栏变成抽屉（宽 `min(78vw, 330px)`），带遮罩
- 底部 6 个图标变成标签栏
- 弹窗层级提到 `z-index: 120`，压住抽屉（否则任务弹窗被抽屉盖住点不到）
- 模型选择器在窄屏改为占满输入框宽度（原本锚定右侧会跑到屏幕外）

### ⚠️ CSS 加载顺序是硬约束

`web.css` / `mobile.css` 必须在 `App`（→ `ChatFirstShell` → `redesign.css`）**之后** import，否则覆盖规则会被桌面样式反杀——表现为"移动端看起来像被压扁的桌面版"。

`scripts/build-web.mjs` 里有构建守卫：产物 CSS 中 `is-mobdrawer` 必须出现在 `.cf-body{position:relative` 之后，否则构建失败。

---

## 连接可靠性

WebSocket 断线是常态（切后台、锁屏、换网络），`web-ipc.ts` 做了四层防护：

| 机制 | 作用 |
| --- | --- |
| 升级看门狗（8s） | socket 卡在 CONNECTING 就主动关掉重来 |
| ping/pong 探活（4s） | 发 `{t:'ping'}`，4s 内没 pong 判定僵尸连接并强断 |
| 心跳（25s） | 只在页面可见时发，省电 |
| 生命周期 kick | 页面可见 / `pageshow` / `online` 事件触发立即重连 |

闪屏覆盖层是**可重置的状态机**，不是一次性闩锁：

```ts
// 反例：这样写会导致第一次连上后，以后再断线覆盖层永远不消失
let splashGone = false
function hideSplash() { if (splashGone) return; splashGone = true; ... }
```

正确做法是 `showSplash()` 要把 `splashGone` 重置回 `false` 并清掉待执行的隐藏定时器。历史上这个 bug 的表现是：连接已经恢复（WS 重连成功），但界面被"正在重连…"永久盖死。

---

## 维护：合并上游新版本

本仓库跟随上游发布同步（不是 GitHub 上的 fork，是独立仓库按版本合并）。合并本身是常规操作，但**必须做 Web 适配检查**。

```bash
git fetch origin --tags
git log --oneline HEAD..origin/main          # 看上游加了什么
git diff --stat HEAD...origin/main

# 1. 先提交本地改动（git 不允许在有冲突的脏文件上 merge）
git add -A && git commit -m "wip"

# 2. 备份分支，再合并
git branch backup/pre-merge-$(date +%Y%m%d)
git merge --no-ff origin/main

# 3. 重新生成桥接
cd apps/desktop && node scripts/gen-web-api.mjs

# 4. 检查新的 IPC 通道
git diff --name-only <老HEAD>..HEAD -- 'src/main/**' 'src/preload/**'
```

### 合并检查清单

每合并一个上游版本，按这个顺序过一遍：

1. **preload 新增了什么 API？** → 重跑 `gen-web-api.mjs`，确认生成的 `deva-api.gen.ts` 里有对应字段
2. **主进程新增了什么 `ipcMain.handle`？** → 这些经过 shim 会自动注册，但要确认 web-server 调用了对应的 `registerXxxIpc()`
3. **有新 handler 用了 `e.sender` 吗？** → `grep -rn "sender\." src/main`。用了 `sender.send` / `sender.once` 的，shim 的 `makeSender` 要能兜住
4. **新的 `BrowserWindow` 方法调用？** → `webWindow()` 在 `bus.ts` 里，要补上同名空实现
5. **新的 `app.getPath()` / `app.isPackaged`？** → 确认 `electron-shim.ts` 的 `app` 替身能返回合理值
6. **新增的启动期清扫 / 定时逻辑？** → web-server 的启动流程要跟着加（例：v0.1.9 的 `sweepMedia`）
7. **桌面专用交互（打开文件、系统通知、托盘）？** → 前端要降级成 Web 可行的行为（下载、浏览器通知、忽略）
8. **跑两个 typecheck + 构建 + 真机验证**

```bash
npm run typecheck:web      # 前端
npm run typecheck:node     # 主进程（较慢，约 4-5 分钟）
node scripts/build-web.mjs
systemctl restart deva-web
```

---

## 本机已验证的适配点（v0.1.9）

| 上游功能 | 桌面行为 | Web 适配 |
| --- | --- | --- |
| `present_files` 交付卡 | 默认应用打开 / 文件夹中显示 | `/api/deliverable` 下载；reveal 降级为复制路径；缩略图返回 `null` |
| 回复完成通知 | 系统通知，窗口聚焦时跳过 | `webWindow().isFocused()` 恒 `true`，交给页面内提示 |
| macOS 红绿灯 | 窗口左侧留位 | `window:is-fullscreen` 恒 `false`，不做布局预留 |
| AI 生成提交信息（流式） | `sender.send` 推片段 | `makeSender` 定向推到发起连接 |
| 图片/PDF 外置存储 | `sweepMedia` 清扫孤儿 | web-server 启动时同样调用 |
| 模型详情页（上下文/输出上限） | 正常 | 无需适配（纯渲染层） |

---

## 已知限制

- **单管理员**：没有多用户 / 权限体系，一个服务一套凭据
- **无审计**：谁在什么时候跑了什么命令，没有独立日志
- **无沙箱**：agent 的终端和文件工具权限等于启动服务的系统用户
- **PTY 会话随服务重启丢失**：终端里跑到一半的进程会断
- **自动更新不适用**：升级靠 `git pull` + 重新构建 + 重启
- **通知需要浏览器授权**，且页面关闭后收不到（没有 Service Worker 推送）

---

## 许可

跟上游一致：[MIT](../LICENSE)。
