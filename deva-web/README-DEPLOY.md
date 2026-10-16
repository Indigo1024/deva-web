# Deva Web 独立部署包（已脱敏）

这是从 Electron 桌面版 **Deva** 改造而来的**纯 Node.js Web 服务版**。
解压即可运行，无需联网安装依赖（生产依赖已内置于 `app/node_modules`）。

## 包结构

```
deva-web/
├── app/                  # 服务程序（构建产物）
│   ├── index.cjs         # 服务入口（后端）
│   ├── ctl.cjs           # 管理工具（重置密码等）
│   ├── pty-host.js       # 终端 PTY 宿主
│   ├── pty-worker.cjs    # PTY 引导
│   ├── renderer/         # 前端静态资源（浏览器访问的页面）
│   └── node_modules/     # 生产依赖（已内置，勿删）
├── .deva/                # 数据目录（首次启动会自动填充）
│   ├── config.json       # 主配置（已脱敏：清空了密钥与私有 provider）
│   ├── secrets.json      # 密钥存放（已清空为 {}，请在部署后自行填入）
│   ├── personas/         # 角色人格定义
│   └── data/             # 聊天记录 / 检查点（已清空）
├── start.sh              # 一键启动脚本
├── deva-web.service      # systemd 服务示例
└── README-DEPLOY.md      # 本文件
```

## 系统要求

- **Node.js ≥ 20**（推荐 20 / 22；`node -v` 查看）
- Linux x86_64（其它平台需自行处理 `@lydell/node-pty` 原生模块）
- 内存：服务本体约 **160 MB**，建议 ≥ 512 MB 可用内存
  （2 核 2G 小机可跑纯对话/工具场景；如需浏览器自动化请加大内存）

## 快速开始（3 步）

```bash
# 1. 解压
unzip deva-web-*.zip && cd deva-web

# 2. 启动（默认 127.0.0.1:8790）
./start.sh

# 3. 查看自动生成的管理员密码
cat .deva/web-login.txt
```

浏览器访问 `http://服务器IP:8790`，用 `admin` + 上面的密码登录。

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEVA_WEB_PORT` | `8790` | 监听端口 |
| `DEVA_WEB_HOST` | `127.0.0.1` | 监听地址；公网访问改 `0.0.0.0` |
| `DEVA_HOME` | `~/.deva` | 数据目录（默认指向本包内 `.deva` 亦可） |
| `DEVA_WEB_USER` | `admin` | 首次初始化的管理员用户名 |
| `DEVA_WEB_PASSWORD` | 随机 | 首次初始化的管理员密码（不设则自动生成） |

## 修改管理员密码

```bash
node app/ctl.cjs passwd            # 生成一个强随机密码并重置
node app/ctl.cjs passwd 你的新密码   # 指定新密码
node app/ctl.cjs user 新用户名       # 改用户名
node app/ctl.cjs info              # 查看账号信息（不含密码）
```

## 配置模型 API 密钥

编辑 `.deva/secrets.json`，按 provider id 填入密钥，例如：

```json
{
  "anthropic": "sk-ant-...",
  "openai": "sk-...",
  "deepseek": "sk-..."
}
```

（具体字段名以你使用的 provider 适配器为准，可在 Web 界面「模型设置」里配置。）

## 用 systemd 常驻运行

```bash
sudo cp deva-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deva-web
sudo systemctl status deva-web
```

> 记得先编辑 `deva-web.service` 里的路径为你的实际解压路径。

## 安全说明

- 本包已脱敏：未包含任何真实 API 密钥、登录密码、聊天记录。
- 首次启动会自动生成全新的管理员密码与加密密钥（`web-auth.json` / `web-secret.key`）。
- 登录接口有防暴力破解：每 IP 连续 5 次失败锁定 10 分钟。
- 默认仅监听 `127.0.0.1`，公网部署请务必改密码、必要时套一层 HTTPS（如 Caddy/Nginx）。
