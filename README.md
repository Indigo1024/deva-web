# Deva Web 改版

把 [Deva](https://github.com/sqfcyily/deva) 桌面客户端搬到浏览器里用。

> **这是非官方的第三方改版，不是 Deva 官方项目。**
> 作者与上游开发者无关联，未获授权，也不代表上游立场。
>
> - 上游项目：**[sqfcyily/deva](https://github.com/sqfcyily/deva)**
> - 上游官网：**https://sqfcyily.github.io/deva/**
> - 上游许可：MIT
>
> 想用桌面客户端，请去上游下载。**本仓库不发布任何 Electron 安装包。**

---

## 本改版做了什么

上游 Deva 是 Electron 桌面应用，一人装一份。本改版把它改成 **Linux 服务器上的一个 Node 进程 + 浏览器界面**：服务端装一次，手机、平板、任意电脑打开网址就能用，不需要安装客户端。

改造方式是**在 Electron 边界上打替身**，不重写上游业务逻辑：

- 构建时用 esbuild alias 把 `'electron'` 换成一个纯 Node 的替身模块，让主进程服务代码原样跑在 Node 进程里
- 把 preload 暴露的 `window.deva` 通过 WebSocket 一比一桥接到浏览器，这份桥接由脚本从 preload 自动生成，不手写
- 前端复用上游渲染层，在其上叠一层 Web 样式与移动端布局

**上游功能本身是上游的成果**，本仓库不含那些功能的实现说明。想了解 Deva 有哪些能力，请看 [上游项目](https://github.com/sqfcyily/deva)。

---

## 改版新增的能力

以下内容是本仓库自己实现的，上游没有。

### 登录与访问控制

- 用户名 + 强密码，密码 scrypt 加盐哈希，存 `$DEVA_HOME/web-auth.json`
- 会话是无状态签名 token（`<exp>.<hmac>`），HttpOnly + SameSite=Lax Cookie，默认 30 天
- 同一 IP 连续 5 次失败锁 10 分钟
- 未认证访问 `/` 与 `/index.html` 由**服务端直接 302 到 `/login`**，不会先渲染应用界面再闪断
- 登录页复用应用自身的 CSS 变量与组件类名，视觉与主界面一致

### 移动端适配

不是把桌面布局压缩，而是换成移动端结构（纯 CSS `@media (max-width: 719px)`）：

- 侧栏变抽屉（`min(78vw, 330px)`）+ 半透明遮罩
- 底部图标栏变标签栏
- 弹窗层级提到 `z-index: 120`，压住抽屉，避免被盖住点不到
- 模型选择器在窄屏改为占满输入框宽度（原本锚定右侧会跑出屏幕）

### 连接可靠性

WebSocket 断线在移动端是常态（切后台、锁屏、换网），做了四层防护：

| 机制 | 作用 |
| --- | --- |
| 升级看门狗 8s | socket 卡在 CONNECTING 就主动关掉重来 |
| ping/pong 探活 4s | 4s 内没 pong 判定僵尸连接，强制重连 |
| 心跳 25s | 仅在页面可见时发送，省电 |
| 生命周期 kick | 页面可见 / `pageshow` / `online` 立即重连 |

启动闪屏是**可重置的状态机**：`showSplash()` 会清掉待执行的隐藏定时器并把「已隐藏」标记复位。这里踩过坑——用一次性闩锁写会导致连接恢复后界面被「正在重连…」永久盖死，连接是好的但界面死了。

### 桌面专属行为在浏览器里的降级

| 桌面做法 | 本改版的做法 |
| --- | --- |
| 系统原生文件选择框 | 服务端目录浏览（浏览服务器文件系统） |
| 默认应用打开交付文件 | `/api/deliverable` 下载 |
| 文件管理器中显示 | 降级为复制路径 |
| 系统通知 | 浏览器通知 / 页面内提示 |
| 缩略图 | 返回 `null`，前端回落类型图标 |
| 窗口全屏 / macOS 红绿灯 | 空实现 |
| electron-updater 自动更新 | 不适用，升级靠重新构建部署 |

### 站点图标与 PWA

图标取自应用自身的启动闪屏标志，生成 `favicon.ico`（7 档尺寸）、`svg`、`192`、`512`、`apple-touch-icon` 与 `site.webmanifest`。安卓「添加到主屏幕」可作独立应用打开。图标路径在认证墙里单独放行，避免浏览器匿名请求拿到 401。

---

## 快速开始

需要 Node.js 20 以上、pnpm、Linux（x64 / arm64）。

```bash
git clone https://github.com/Indigo1024/deva-web.git
cd deva-web
pnpm install

cd apps/desktop
node scripts/gen-web-api.mjs     # 生成 window.deva 桥接
node scripts/build-web.mjs       # 构建服务端 + 前端

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

浏览器打开 `http://127.0.0.1:8790`。

改密码：

```bash
node out/web/ctl.cjs passwd     # 同时作废所有已登录会话
```

**完整部署文档**（环境变量、systemd、Cloudflare Tunnel / nginx、架构细节、合并上游的检查清单、已知限制）见 **[docs/WEB.md](docs/WEB.md)**。

---

## ⚠️ 安全边界

本改版把桌面应用的完整权力搬到了浏览器：

- agent 的文件工具**没有路径限制**
- 终端命令**没有命令白名单**
- 唯一的边界是那道登录墙

**不要用弱密码暴露在公网**，不要装在多人共用的机器上。服务器的 PTY 与文件系统对登录者完全开放。

---

## 同步上游

本仓库跟随上游更新。每次合并都要做 Web 适配检查——上游新增的 IPC 通道、`BrowserWindow` 方法、`e.sender` 用法都可能让 Web 版在运行时崩溃。完整检查清单在 [docs/WEB.md](docs/WEB.md#维护合并上游新版本)。

---

## 致谢与许可

上游 [sqfcyily/deva](https://github.com/sqfcyily/deva) 为 MIT 许可，版权归其作者所有。没有它就没有这个改版。

本仓库的 Web 适配层同样以 [MIT](LICENSE) 发布，欢迎自行部署或继续修改。
