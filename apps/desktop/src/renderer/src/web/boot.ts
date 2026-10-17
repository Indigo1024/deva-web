/**
 * Web 桥接引导：把 window.deva 装上（由 preload 自动生成、经 web-ipc 走 WS），
 * 并驱动启动闪屏 / 断线覆盖层 / 系统通知 / 外链 / 剪贴板同步。
 *
 * 防闪烁与转圈体验（用户要求）：
 *  - 服务器对未认证请求直接 302 /login，应用 HTML 永远不落到登录前 → 不会闪出背后界面
 *  - 已认证后：闪屏覆盖整个页面，等 WS 连接就绪 + React 首帧提交后才淡出
 *  - 刷新（外部/内部）同样先见闪屏，不闪登录页
 *  - 断线 → 覆盖层「连接已断开，正在重连…」；会话过期 → 跳登录
 */
import { devaApi } from './deva-api.gen'
import { webIpc } from './web-ipc'
// web.css 由 renderer-web/main.tsx 统管加载位置（须排在 redesign.css 之后，见那边注释）

let splashEl: HTMLElement | null = null
let splashTextEl: HTMLElement | null = null
let splashGone = false
let splashHideTimer: ReturnType<typeof setTimeout> | null = null
let reactMounted = false

function splash(): HTMLElement | null {
  if (splashEl) return splashEl
  splashEl = document.getElementById('deva-splash')
  splashTextEl = document.getElementById('deva-splash-text')
  return splashEl
}

function setSplashText(text: string): void {
  splash()
  if (splashTextEl) splashTextEl.textContent = text
}

function showSplash(text?: string): void {
  const el = splash()
  if (!el) return
  // 取消在途的隐藏定时器，并复位「已隐藏」标记 —— 否则重连成功后 hideSplash 会被
  // 旧的 splashGone=true 挡掉，覆盖层永远不消失（表现为「一直正在重连…」卡死）。
  if (splashHideTimer) {
    clearTimeout(splashHideTimer)
    splashHideTimer = null
  }
  splashGone = false
  el.classList.remove('is-gone')
  el.style.display = ''
  el.style.opacity = ''
  if (text) setSplashText(text)
}

function hideSplash(): void {
  const el = splash()
  if (!el || splashGone) return
  splashGone = true
  el.classList.add('is-gone')
  splashHideTimer = setTimeout(() => {
    splashHideTimer = null
    el.style.display = 'none'
  }, 400)
}

/** React 首帧提交后调用（由 main.tsx 在 render 后调用）。 */
export function markAppMounted(): void {
  reactMounted = true
  maybeDismissSplash()
}

function maybeDismissSplash(): void {
  if (reactMounted && webIpc.connected) {
    // 稍作停留：避免「闪屏一闪而过」的廉价感
    setTimeout(hideSplash, 200)
  }
}

function setupSplashFlow(): void {
  const el = splash()
  if (!el) return
  const retryBtn = document.getElementById('deva-splash-retry')
  let hintTimer: ReturnType<typeof setTimeout> | null = null
  const clearHint = (): void => {
    if (hintTimer) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
    if (retryBtn) retryBtn.style.display = 'none'
  }
  window.addEventListener('deva:ws-open', () => {
    clearHint()
    maybeDismissSplash()
  })
  window.addEventListener('deva:ws-close', () => {
    showSplash('连接已断开，正在重连…')
    // 12 秒仍未连上：在不丢掉「正在重连…」语义的前提下给出兜底按钮（点击整页刷新）。
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(() => {
      hintTimer = null
      if (!webIpc.connected) {
        setSplashText(webIpc.everConnected ? '连接已断开，正在重连…' : '无法连接服务器')
        if (retryBtn) retryBtn.style.display = 'inline-flex'
      }
    }, 12000)
  })
  window.addEventListener('deva:session-expired', () => {
    setSplashText('会话已过期，正在跳转登录…')
    setTimeout(() => location.replace('/login'), 1200)
  })
  // 首次载入 12 秒仍未连上：给出明确失败提示（点击重试）
  setTimeout(() => {
    if (!webIpc.connected && !webIpc.everConnected) {
      setSplashText('无法连接服务器')
      if (retryBtn) retryBtn.style.display = 'inline-flex'
    }
  }, 12000)
  retryBtn?.addEventListener('click', () => location.reload())
}

function setupNotifications(): void {
  window.addEventListener('deva:server-request', (() => {}) as EventListener)
  // 服务端 Notification → 浏览器通知
  const onNotify = (ev: Event): void => {
    const detail = (ev as CustomEvent).detail as { id: string; title: string; body: string }
    if (!detail) return
    try {
      if (typeof Notification === 'undefined') return
      if (Notification.permission === 'granted') {
        const n = new Notification(detail.title || 'Deva', { body: detail.body || '' })
        n.onclick = () => {
          window.focus()
          webIpc.send('web:notify-click', detail.id)
        }
      } else if (Notification.permission === 'default') {
        // 首次触达时申请（浏览器可能要求用户手势，静默失败即可）
        void Notification.requestPermission()
      }
    } catch {
      /* noop */
    }
  }
  // 事件经 WS 下发；挂到 webIpc 监听
  webIpc.on('web:notify', (_e, payload) => {
    onNotify(new CustomEvent('deva:notify', { detail: payload }) as unknown as Event)
  })
}

function setupOpenUrl(): void {
  webIpc.on('web:open-url', (_e, url) => {
    try {
      window.open(String(url), '_blank', 'noopener,noreferrer')
    } catch {
      /* noop */
    }
  })
}

function setupClipboard(): void {
  // 服务端写剪贴板 → 浏览器写（需权限；失败静默）
  webIpc.on('web:clipboard-write', (_e, text) => {
    try {
      void navigator.clipboard?.writeText(String(text ?? '')).catch(() => {})
    } catch {
      /* noop */
    }
  })
  // 窗口重新聚焦 → 把系统剪贴板同步到服务端缓存（终端右键粘贴用）
  window.addEventListener('focus', () => {
    try {
      void navigator.clipboard
        ?.readText()
        .then((t) => {
          if (t) webIpc.send('web:clipboard-cache', t)
        })
        .catch(() => {})
    } catch {
      /* 无权限 → 保持服务端缓存 */
    }
  })
}

/** 安装 window.deva 并启动连接。幂等：Electron 环境已由 preload 装好则跳过。 */
export function installWebBridge(): void {
  if ((window as any).deva) return
  ;(window as any).deva = devaApi
  webIpc.connect()
  setupSplashFlow()
  setupNotifications()
  setupOpenUrl()
  setupClipboard()
}
