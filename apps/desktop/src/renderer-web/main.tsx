/**
 * Web 版渲染入口：与桌面 main.tsx 同构（同一套 Provider 树、同一 App），
 * 差别只在最前面多一步 installWebBridge()——把 window.deva 装到浏览器上
 * （WebSocket 桥），并驱动启动闪屏。
 *
 * 模块副作用顺序：ESM 的 import 按声明顺序求值 —— 第一步先求值 web 桥接，
 * 之后才求值各 store / App，确保它们模块初始化时 window.deva 已就绪。
 */
import '@renderer/web/install'
import React from 'react'
import ReactDOM from 'react-dom/client'
import '@renderer/styles/tokens.css'
import '@renderer/styles/app.css'
import { App } from '@renderer/App'
import { ThemeProvider } from '@renderer/theme/ThemeContext'
import { I18nProvider } from '@renderer/i18n/i18n'
import { DialogProvider } from '@renderer/components/DialogProvider'
import { ToastProvider } from '@renderer/components/ToastProvider'
import { ModelsProvider } from '@renderer/store/models'
import { ExtensionsProvider } from '@renderer/store/extensions'
import { WorkspaceProvider } from '@renderer/store/workspace'
import { ChatProvider } from '@renderer/store/chat'
import { TasksProvider } from '@renderer/store/tasks'
import { ProfileProvider } from '@renderer/store/profile'
import { FilePickerHost } from '@renderer/web/FilePicker'
import { markAppMounted } from '@renderer/web/boot'
// ⚠️ 顺序敏感（勿上移）：web 覆盖样式必须排在 App（经 ChatFirstShell → redesign.css）之后。
// 打包 CSS 按模块求值顺序拼接，同优先级下后者胜 —— 若排到前面，手机端（<720px）覆盖
// 规则全被桌面规则压掉，界面退化成「被压缩的桌面端」（build-web.mjs 有护栏校验）。
import '@renderer/web/web.css'
import '@renderer/web/mobile.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <DialogProvider>
          <ToastProvider>
            <ModelsProvider>
              <ExtensionsProvider>
                <WorkspaceProvider>
                  <ChatProvider>
                    <TasksProvider>
                      <ProfileProvider>
                        <App />
                        <FilePickerHost />
                      </ProfileProvider>
                    </TasksProvider>
                  </ChatProvider>
                </WorkspaceProvider>
              </ExtensionsProvider>
            </ModelsProvider>
          </ToastProvider>
        </DialogProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
)

// React 首帧提交后放行闪屏淡出（双击 rAF：等样式与首帧都落定）
requestAnimationFrame(() => requestAnimationFrame(() => markAppMounted()))
