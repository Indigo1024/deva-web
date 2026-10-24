# Deva Web 改版

把 Deva 桌面客户端搬到浏览器里用。

## 先说清楚

这不是 Deva 官方项目，是非官方的第三方改版。我跟上游作者没有关系，也没得到授权，这里的东西不代表他们的立场。

- 上游项目：https://github.com/sqfcyily/deva
- 上游官网：https://sqfcyily.github.io/deva/
- 上游许可：MIT

要桌面客户端，去上游下载。这个仓库不提供任何 Electron 安装包。

## 这是什么

上游 Deva 是 Electron 桌面应用，每台电脑装一份。这个改版把它改成服务器上的一个 Node 进程加浏览器界面：服务器装一次，手机、平板、其他电脑打开网址就能用。

做法是在 Electron 那一层做替换，业务代码不动：

- 构建时把 `electron` 模块换成一个纯 Node 的替代实现，主进程代码原样跑
- preload 暴露的 `window.deva` 通过 WebSocket 桥接到浏览器，桥接代码由脚本从 preload 自动生成
- 前端还是上游那套 React，上面加了一层 Web 样式和移动端布局

上游的功能是上游做的，这个仓库不解释也不认领。想看 Deva 有什么本事，去上游项目看。

## 这个改版加了什么

下面这些是本仓库自己写的。

### 登录

- 用户名加强密码，密码用 scrypt 加盐哈希，存在 `$DEVA_HOME/web-auth.json`
- 登录状态是一个签名 token，放在 HttpOnly Cookie 里，默认 30 天
- 同一个 IP 连续错 5 次，锁 10 分钟
- 没登录访问 `/` 或 `/index.html`，服务端直接 302 到 `/login`，不会先闪一下主界面
- 登录页用应用自己的 CSS 变量和类名，看起来和主界面是一套的

### 手机

不是把桌面版压小，是换成手机的结构（纯 CSS，`@media (max-width: 719px)`）：

- 侧栏变成抽屉，宽度 `min(78vw, 330px)`，带半透明遮罩
- 底部图标栏变成标签栏
- 弹窗层级提到 `z-index: 120`，不然会被抽屉盖住点不到
- 模型选择器在窄屏改成占满输入框宽度，原来锚定右边会跑出屏幕

### 断线重连

手机上切后台、锁屏、换网络，WebSocket 断开是常事。做了四层：

| 机制 | 作用 |
| --- | --- |
| 连接看门狗 8 秒 | 卡在连接中超过 8 秒就重来 |
| ping/pong 探活 4 秒 | 4 秒没回 pong 就当连接死了，强制重连 |
| 心跳 25 秒 | 只在页面可见时发，省电 |
| 生命周期触发 | 页面重新可见、`pageshow`、`online` 时立刻重连 |

启动闪屏是个可重置的状态机。这里踩过坑：早先用一次性开关写，结果第一次连上之后，以后再断线，覆盖层就永远不消失了——连接其实是好的，界面被"正在重连"盖死了。

### 桌面才有的操作，在浏览器里怎么处理

| 桌面 | 这个改版 |
| --- | --- |
| 系统文件选择框 | 浏览服务器目录 |
| 用默认应用打开交付文件 | 走 `/api/deliverable` 下载 |
| 在文件管理器里显示 | 改成复制路径 |
| 系统通知 | 浏览器通知或页面内提示 |
| 缩略图 | 返回空，前端显示类型图标 |
| 窗口全屏 / macOS 红绿灯 | 空实现 |
| electron-updater 自动更新 | 用不了，升级靠重新构建 |

### 附件

支持粘贴和选择文件上传。图片、PDF、文本类直接发给模型；压缩包（zip/tar/gz 等）会解开，把目录清单和里面的文本文件内容一起发过去。

粘贴进来的文件存在服务器临时目录，发送时内容转成 base64 进历史，文件只活到发送前。

### 在线更新

设置 → 关于里有检查更新。有新版时点一下，服务器会自己拉源码、重新构建、重启服务，浏览器等它回来之后自动刷新。

旧版本（还没有这个功能的构建）可以用命令行升级一次：

```bash
bash scripts/deva-update.sh
```

之后就能在界面里点了。

### 站点图标

图标取自应用启动时的闪屏标志，生成了 ico（7 档尺寸）、svg、192、512、apple-touch-icon 和 site.webmanifest。安卓可以添加到主屏幕当独立应用用。

## 装起来

需要 Node.js 20 以上、pnpm、Linux（x64 或 arm64）。

```bash
git clone https://github.com/Indigo1024/deva-web.git
cd deva-web
pnpm install

cd apps/desktop
node scripts/gen-web-api.mjs
node scripts/build-web.mjs

DEVA_HOME=$HOME/.deva \
DEVA_WEB_PORT=8790 \
DEVA_WEB_HOST=127.0.0.1 \
DEVA_WEB_STATIC=$PWD/out/web/renderer \
node out/web/index.cjs
```

第一次启动会生成登录密码，写在 `$DEVA_HOME/web-login.txt`：

```bash
cat ~/.deva/web-login.txt
```

然后浏览器打开 `http://127.0.0.1:8790`。

改密码：

```bash
node out/web/ctl.cjs passwd
```

部署细节（环境变量、systemd、Cloudflare Tunnel、nginx、合并上游的检查清单）在 [docs/WEB.md](docs/WEB.md)。

## 安全

这个改版把桌面应用的完整权限搬到了浏览器上：

- agent 的文件工具没有路径限制
- 终端没有命令白名单
- 唯一的边界就是登录

别用弱密码暴露在公网，也别装在多人共用的机器上。登录的人能用服务器上的 shell 和整个文件系统。

## 跟着上游更新

每次上游发版，合并之后都要检查 Web 层有没有被破坏——新的 IPC 通道、`BrowserWindow` 方法、`e.sender` 用法都可能让 Web 版在运行时崩掉。检查清单在 [docs/WEB.md](docs/WEB.md)。

## 许可

上游是 MIT，版权归上游作者。没有它就没有这个改版。

这个仓库的 Web 适配层同样用 MIT，随便部署随便改。
