# 源码申明

## 这是什么

Deva Web 改版，一个把 [Deva](https://github.com/sqfcyily/deva) 桌面客户端移植到浏览器里运行的非官方改版。

## 来源

本仓库基于上游 Deva 的源码修改而来：

| 项 | 内容 |
| --- | --- |
| 上游项目 | [sqfcyily/deva](https://github.com/sqfcyily/deva) |
| 上游许可 | MIT |
| 本仓库跟随的上游版本 | v0.1.10（见 `apps/desktop/package.json` 的 `version`） |
| 本改版版本 | 见 `apps/desktop/web-version.json` |

上游的提交历史完整保留在本仓库里，可以在 `git log` 里看到每一条上游提交及其作者。

## 哪些是上游的

`apps/desktop/src/main/`、`apps/desktop/src/renderer/`（除 `web/` 目录外）、`apps/desktop/src/preload/`、`apps/desktop/src/shared/` 等目录下的绝大部分代码来自上游。

这些代码的著作权归上游作者所有，按 MIT 许可使用。

## 哪些是本改版的

本改版新增的部分：

```
apps/desktop/src/web-server/          服务端：HTTP、WebSocket、认证、Electron 模块替身
apps/desktop/src/renderer/src/web/    前端 Web 层：WS 客户端、启动闪屏、移动端样式、文件选择器
apps/desktop/src/renderer-web/        Vite 入口、HTML 模板、图标等静态资源
apps/desktop/scripts/build-web.mjs    Web 构建脚本
apps/desktop/scripts/gen-web-api.mjs  window.deva 桥接生成脚本
scripts/deva-update.sh                命令行升级脚本
```

外加对上游若干文件的小幅改动（新增 Web 分支判断、修复 Web 环境下的行为差异），这些改动都在提交历史里可查。

## 许可

上游代码：MIT，版权归上游作者。

本改版新增的代码：同样以 MIT 发布。

完整许可文本见 [LICENSE](LICENSE)。

## 声明

本仓库与上游作者无隶属关系，未获其背书或授权。仓库名称、描述、文档中均已标注「非官方」。

如果上游作者认为本仓库有不妥之处，请通过 Issue 联系，我会配合处理。

## 不包含什么

- 不包含任何 Electron 安装包（exe / dmg / AppImage / deb）
- 不包含上游的商标、Logo 之外的品牌资产
- 不包含任何 API 密钥、密码、服务器地址等敏感信息
