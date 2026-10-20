/**
 * Web 事件总线：把主进程服务对「窗口」的发送/接收接到 WebSocket 客户端上。
 *
 * - clients：在线浏览器连接（已认证）。
 * - broadcast(channel, args)：等价 webContents.send —— 推给所有在线客户端。
 * - webWindow()：BrowserWindow 形状的替身，供各 registerXxxIpc(() => win) 取用。
 * - 其它 hook：dialog（浏览器端文件选择器）、clipboard、openExternal、notify（前端弹通知）。
 */
import type { WebSocket } from 'ws'
import { makeSender, type IpcSender } from './electron-shim'

export type ClientSender = (json: string) => void

export interface ClientConn {
  id: number
  ws: WebSocket
  send: ClientSender
  /** invoke handler 里的 `e.sender`：定向推事件回本连接。 */
  sender: IpcSender
}

const clients = new Map<number, ClientConn>()
let seq = 0

export function addClient(ws: WebSocket): ClientConn {
  const conn: ClientConn = {
    id: ++seq,
    ws,
    sender: null as unknown as IpcSender,
    send: (json) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(json)
      } catch {
        /* 连接已断 */
      }
    }
  }
  // invoke handler 里的 `e.sender`：定向把事件推回这条连接（桌面语义），断开时通知 destroyed
  conn.sender = makeSender((channel, args) => {
    conn.send(JSON.stringify({ t: 'ev', channel, args }))
  })
  clients.set(conn.id, conn)
  return conn
}

/** 连接断开：先通知等待 destroyed 的 handler（让进行中的流式生成提前中断），再摘除。 */
export function closeClient(conn: ClientConn): void {
  conn.sender.markDestroyed()
  clients.delete(conn.id)
}

export function removeClient(id: number): void {
  clients.delete(id)
}

export function clientCount(): number {
  return clients.size
}

export function broadcast(channel: string, args: unknown[]): void {
  if (clients.size === 0) return
  const json = JSON.stringify({ t: 'ev', channel, args })
  for (const c of clients.values()) c.send(json)
}

/** 服务端 → 客户端的一次性请求（如 dialog）；等待客户端应答。 */
const pending = new Map<string, (payload: any) => void>()
let reqSeq = 0

export function requestClient(kind: string, payload: unknown, timeoutMs = 180000): Promise<any> {
  return new Promise((resolve) => {
    const id = `r${++reqSeq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeoutMs)
    pending.set(id, (pl) => {
      clearTimeout(timer)
      pending.delete(id)
      resolve(pl)
    })
    const json = JSON.stringify({ t: 'req', id, kind, payload })
    for (const c of clients.values()) c.send(json)
  })
}

/** 客户端应答（t:'res'）入口。 */
export function resolveRequest(id: string, payload: any): void {
  pending.get(id)?.(payload)
}

/** BrowserWindow 形状替身：服务层 getWindow() 取它，webContents.send → broadcast。 */
export function webWindow(): any {
  return {
    isDestroyed: (): boolean => false,
    isMinimized: (): boolean => false,
    isVisible: (): boolean => true,
    /**
     * Web 没有等价概念：浏览器标签页可能开着而用户不在看，但服务端无从得知。
     * 恒返回 true → 回复提醒（reply-notify）视为「用户正在看」而不额外弹系统通知，
     * 由浏览器自身的通知通道（页面内 Toast / 标签标题）承担，避免与桌面端逻辑打架。
     */
    isFocused: (): boolean => true,
    show: (): void => {},
    hide: (): void => {},
    focus: (): void => {},
    restore: (): void => {},
    close: (): void => {},
    maximize: (): void => {},
    unmaximize: (): void => {},
    webContents: {
      send: (channel: string, ...args: unknown[]): void => broadcast(channel, args),
      once: (): void => {},
      on: (): void => {},
      setWindowOpenHandler: (): void => {}
    }
  }
}
