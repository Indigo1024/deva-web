/**
 * Web 版的内置浏览器替身（构建期替换，见 scripts/build-web.mjs 的 browser 解析覆盖）。
 *
 * 上游的「内置浏览器」是纯桌面的东西：它靠 Electron 的 `WebContentsView` 把网页**叠在**
 * 「Deva 浏览器」窗口里、用 `debugger` 走 CDP 发真实输入事件、收起时把窗口挪到屏幕外继续渲染。
 * 服务端只有一个 Node 进程，没有窗口、没有 WebContents，这套机制没有对应物。
 *
 * 所以 Web 版把整个 `main/services/browser` 从构建里摘掉，换成这个替身：
 *  · `browserToolSpec = null` → 工具清单里不出现 browser（tools.ts 用 `browserToolSpec ? [..] : []` 展开），
 *    模型不会去调一个用不了的工具；
 *  · 其余导出是空实现，供 chat.ts / tools.ts 的调用点（回合结束、删除对话、成员交接等）安全落地；
 *  · 界面侧：web-server 另外为 `browser:state` 注册了一个「空状态」应答，
 *    胶囊组件拿到空状态即不渲染，用户看不到任何与浏览器相关的死界面。
 *
 * 要真正把浏览器搬上服务端，需要另写一份基于无头 Chromium 的 pages/host 实现（CDP 部分可复用），
 * 那是独立的一件事，不在本次移植范围内。
 */
import type { ToolSpec } from '../main/providers/types'

/** Web 版没有内置浏览器：置空即让 tools.ts 不把 browser 列进工具清单。 */
export const browserToolSpec: ToolSpec | null = null

/** 按需加载用的简版工具说明（见 tool-search.ts）；工具不在清单里，这段文案不会被用到。 */
export const BROWSER_BRIEF = ''

/** 浏览器用法说明：browser 不在工具清单里，这段文案不会被用到。 */
export const BROWSER_GUIDE = ''

/** 成员交接的上下文（见 browser/index.ts）：Web 版没有浏览器，类型留着让调用点零改动。 */
export interface MemberHandoff {
  name: string
  notify: (reason: string) => void
}

export function runBrowserTool(): { content: string; summary: string; isError: boolean } {
  return {
    content: '内置浏览器只在桌面客户端可用，当前是 Web 版，无法打开网页。',
    summary: '环境不支持',
    isError: true
  }
}

/** 该对话是否有「请用户在网页上操作」的等待：Web 版恒为否（没有浏览器可交接）。 */
export function browserHasHandoff(_sessionId: string): boolean {
  return false
}

export function clearBrowserOperating(_sessionId: string): void {}
export function closeSessionPages(_sessionId: string): void {}
export function markBrowserTurnEnded(_sessionId: string): void {}
export function setBrowserSessionBusyCheck(_fn: (sessionId: string) => boolean): void {}
export function setSessionAborter(_fn: (sessionId: string, signal: AbortSignal) => void): void {}
