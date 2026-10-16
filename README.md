# Deva Web 工作助手

Deva Web 是一款全能型 AI 工作助手，提供浏览器可访问的 Web 界面，集成代码开发、文件管理、终端操作与技能系统，帮助开发者在一个界面内完成从构思到落地的全流程工作。

## 核心特性

- **多模型接入**：支持华为云 ModelArts、GLM、DeepSeek 等多种大模型供应商，可自由切换与配置
- **内置终端**：基于 PTY 的完整 Shell 会话，支持多标签、实时输出与交互式命令
- **文件工作区**：可视化浏览与编辑项目文件，支持挂载任意目录作为工作区
- **技能系统（Skills）**：以 Markdown 定义的技能可被对话自动加载，扩展助手能力边界
- **角色人格（Personas）**：可自定义助手身份、性格与专业领域，打造专属工作伙伴
- **会话持久化**：聊天记录、检查点与上下文自动保存，跨会话延续工作状态
- **一键部署**：纯 Node.js 实现，生产依赖内置，解压即运行，无需联网安装

## 技术架构

```
deva-web/
├── app/
│   ├── index.cjs        # 服务入口：HTTP 服务 + 会话编排 + 工具调度
│   ├── ctl.cjs          # 管理工具：重置密码等运维操作
│   ├── pty-host.js      # 终端宿主：PTY 会话管理
│   ├── pty-worker.cjs   # PTY 引导 Worker
│   ├── renderer/        # 前端静态资源（HTML/CSS/JS）
│   └── node_modules/    # 生产依赖（内置）
├── .deva/               # 数据目录：配置、密钥、人格、聊天记录
├── start.sh             # 一键启动脚本
└── deva-web.service     # systemd 服务定义
```

**运行方式**：Node.js 服务端渲染 + 前端静态资源，浏览器访问；后端通过 child_process 管理 PTY 终端与文件系统操作。

## 快速开始

```bash
# 1. 启动服务
./start.sh

# 2. 浏览器访问
#    http://127.0.0.1:8790

# 3. 首次登录密码
cat .deva/web-login.txt
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEVA_HOME` | `./.deva` | 数据目录 |
| `DEVA_WEB_PORT` | `8790` | 监听端口 |
| `DEVA_WEB_HOST` | `127.0.0.1` | 监听地址 |
| `DEVA_WEB_STATIC` | `./app/renderer` | 前端静态资源目录 |

### 部署为系统服务

```bash
sudo cp deva-web.service /etc/systemd/system/
sudo systemctl enable --now deva-web
```

## 适用场景

- 个人开发者的日常编码助手：查资料、写代码、跑命令、整理文件一站式完成
- 团队内部 AI 工具平台：集中部署，成员通过浏览器使用，无需各自安装客户端
- 技能与人格的实验场：快速验证自定义 Skill 与 Persona 的效果

## 许可

本项目为内部部署包，请遵守相关服务条款使用。
