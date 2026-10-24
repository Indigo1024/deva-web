/**
 * 浏览器端 IPC 传输：把 Electron 的 ipcRenderer 语义（invoke/send/sendSync/on）
 * 实现为 WebSocket RPC，供桥接层（deva-api.gen.ts，由 preload 自动生成）1:1 使用。
 *
 * 特性：
 *  - 断线自动重连（指数退避），重连期间 invoke 排队、连上后自动发出
 *  - 会话过期（服务器返回 401/页面风暴）→ 派发 deva:session-expired 事件
 *  - Uint8Array / ArrayBuffer 经 base64 标记传输（粘贴附件等二进制）
 *  - sendSync('config:get-sync') 读首帧引导 window.__DEVA_BOOT__（服务端注入，同步可用）
 */

type Listener = (...args: any[]) => void

interface PendingInvoke {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

const RECONNECT_MIN = 500
const RECONNECT_MAX = 8000
const INVOKE_TIMEOUT = 120_000
/** 连接升级看门狗：CONNECTING 挂起超过此时长（CF 隧道偶发）→ 放弃本次、走重连。 */
const CONNECT_WATCHDOG = 8000

/**
 * 把调用参数转成可 JSON 传输的形状：二进制 → `{__u8: base64}`。
 *
 * 必须**递归**进对象和数组。附件上传把字节放在对象字段里
 * （`{name, mime, size, data: Uint8Array}`），早期只处理顶层和一个写死的 data 字段，
 * 其他位置（数组里的对象、别的字段名）会原样进 JSON.stringify，
 * 变成 `{"0":137,"1":80,...}` 这种垃圾，服务端解不回来。
 */
function toWire(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __u8: b64encode(v) }
  if (v instanceof ArrayBuffer) return { __u8: b64encode(new Uint8Array(v)) }
  if (Array.isArray(v)) return v.map(toWire)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toWire(val)
    return out
  }
  return v
}

/**
 * Uint8Array → base64。
 *
 * 用 `String.fromCharCode.apply` 分块（chunk 32KB）：这是 V8 里最快的同步做法。
 * 注意**不要**改成逐字节 `s += String.fromCharCode(b)`——那会为每个字节创建新字符串，
 * 20MB 就要几十秒（实测比 apply 慢一个数量级）。
 */
function b64encode(u8: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK) as unknown as number[]))
  }
  return btoa(parts.join(''))
}

class WebIpc {
  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<string, PendingInvoke>()
  private listeners = new Map<string, Set<Listener>>()
  private outQueue: string[] = []
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private probeSentAt = 0
  private lastPongAt = 0
  private lifeHooked = false
  private started = false
  private closedByUser = false

  /** 是否曾成功连接过（用于「首次载入」与「断线重连」两种覆盖层文案）。 */
  everConnected = false
  connected = false

  connect(): void {
    if (this.started) return
    this.started = true
    this.hookLifecycle()
    this.open()
  }

  /** 页面重新可见 / bfcache 恢复 / 网络恢复：立即探活或立即重连（跳过退避等待）。 */
  private hookLifecycle(): void {
    if (this.lifeHooked) return
    this.lifeHooked = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.kick()
    })
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) this.kick()
    })
    window.addEventListener('online', () => this.kick())
  }

  /**
   * 回前台/网络恢复时的即时处置：连着 → 探活（防僵尸连接）；没连 → 清退避秒连。
   * 移动端浏览器挂后台时定时器被节流、TCP 可能被中间设备悄悄掐断而 close 事件迟迟不来，
   * 只靠退避定时器会让「重连中」僵住——此函数是用户回来那一刻的急救入口。
   */
  private kick(): void {
    if (this.closedByUser) return
    const st = this.ws ? this.ws.readyState : WebSocket.CLOSED
    if (st === WebSocket.OPEN && this.connected) {
      this.probe()
      return
    }
    if (st === WebSocket.CONNECTING) return // 升级中有在看门狗兜底
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retry = 0
    this.open()
  }

  /** 探活：发 ping 等 pong；4 秒无应答按僵尸连接强制重连。 */
  private probe(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const sentAt = Date.now()
    this.probeSentAt = sentAt
    try {
      ws.send(JSON.stringify({ t: 'ping', ts: sentAt }))
    } catch {
      /* 发送异常按断线处理 */
      this.forceReconnect()
      return
    }
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.probeSentAt === sentAt && this.lastPongAt < sentAt) this.forceReconnect()
    }, 4000)
  }

  /** 强制断开并立即走重连（处理「close 事件不来」的僵尸连接）。 */
  private forceReconnect(): void {
    const ws = this.ws
    const wasConnected = this.connected
    if (ws) {
      // 解绑旧连接事件，避免其迟到回调干扰随后建立的新连接
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
    if (this.connectWatchdog) {
      clearTimeout(this.connectWatchdog)
      this.connectWatchdog = null
    }
    this.stopKeepalive()
    this.ws = null
    this.connected = false
    if (wasConnected) window.dispatchEvent(new CustomEvent('deva:ws-close'))
    this.scheduleReconnect()
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    // 升级看门狗：CF 隧道偶发会让新 WS 卡在 CONNECTING 且永不触发 close → 整个重连停摆。
    // 超时未 open 则主动放弃本次（close 触发统一的重连路径）。
    if (this.connectWatchdog) clearTimeout(this.connectWatchdog)
    this.connectWatchdog = setTimeout(() => {
      this.connectWatchdog = null
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close()
        } catch {
          /* noop */
        }
      }
    }, CONNECT_WATCHDOG)

    ws.onopen = () => {
      if (this.ws !== ws) return // 迟到的旧连接事件：已被新连接替换，忽略
      if (this.connectWatchdog) {
        clearTimeout(this.connectWatchdog)
        this.connectWatchdog = null
      }
      this.retry = 0
      this.connected = true
      this.everConnected = true
      this.startKeepalive()
      // 冲刷排队消息
      for (const m of this.outQueue) {
        try {
          ws.send(m)
        } catch {
          /* noop */
        }
      }
      this.outQueue.length = 0
      window.dispatchEvent(new CustomEvent('deva:ws-open'))
    }

    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.t === 'pong') {
        this.lastPongAt = Date.now()
        return
      }
      this.dispatch(msg)
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // 迟到的旧连接关闭事件：新连接已接管，忽略
      const wasConnected = this.connected
      this.connected = false
      this.ws = null
      this.stopKeepalive()
      if (this.closedByUser) return
      if (wasConnected) window.dispatchEvent(new CustomEvent('deva:ws-close'))
      void this.checkSessionThenReconnect()
    }

    ws.onerror = () => {
      /* onclose 兜底重连 */
    }
  }

  /** 断线后先探测会话是否仍有效：401 → 会话过期（跳登录）；否则退避重连。 */
  private async checkSessionThenReconnect(): Promise<void> {
    try {
      // 探测也要限时：网络黑洞时 fetch 会挂很久，把重连拖成停摆。
      const r = await fetch('/api/health', {
        credentials: 'same-origin',
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined
      })
      if (r.status === 401) {
        window.dispatchEvent(new CustomEvent('deva:session-expired'))
        return
      }
    } catch {
      /* 网络故障 → 继续重连 */
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return
    const delay = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** this.retry)
    this.retry += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.connected) this.open()
    }, delay)
  }

  /**
   * 连接成功后启动保活：页面可见时每 25 秒探活一次，把「静默僵死」的发现窗口压到约 30 秒。
   * 挂后台时定时器被浏览器节流、探活无意义 → 跳过；回前台由 kick() 立即探活兜底。
   */
  private startKeepalive(): void {
    this.stopKeepalive()
    this.lastPongAt = Date.now()
    this.keepaliveTimer = setInterval(() => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (document.visibilityState === 'hidden') return
      this.probe()
    }, 25_000)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  private dispatch(msg: any): void {
    switch (msg.t) {
      case 'invoke-res': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (p.timer) clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.value)
        else p.reject(new Error(String(msg.error ?? 'invoke failed')))
        return
      }
      case 'sync-res': {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (p.timer) clearTimeout(p.timer)
          p.resolve(msg.value)
        }
        return
      }
      case 'ev': {
        const set = this.listeners.get(msg.channel)
        if (!set) return
        for (const cb of set) {
          try {
            cb({ sender: null }, ...(Array.isArray(msg.args) ? msg.args : []))
          } catch (e) {
            console.error(`[web-ipc event ${msg.channel}]`, e)
          }
        }
        return
      }
      case 'req': {
        // 服务端 → 客户端请求（文件选择器等）：对外派发事件，由 UI 层应答
        window.dispatchEvent(
          new CustomEvent('deva:server-request', {
            detail: { id: msg.id, kind: msg.kind, payload: msg.payload, respond: (payload: unknown) => this.respondRequest(msg.id, payload) }
          })
        )
        return
      }
      default:
        return
    }
  }

  respondRequest(id: string, payload: unknown): void {
    this.sendRaw({ t: 'res', id, payload })
  }

  private sendRaw(obj: unknown): boolean {
    const json = JSON.stringify(obj)
    if (this.ws && this.connected) {
      try {
        this.ws.send(json)
        return true
      } catch {
        /* 落到队列 */
      }
    }
    // 队列上限：仅保留最近的 200 条（终端输入等高频消息防爆）
    this.outQueue.push(json)
    if (this.outQueue.length > 200) this.outQueue.splice(0, this.outQueue.length - 200)
    if (!this.started) this.connect()
    if (!this.connected && !this.retryTimer) this.scheduleReconnect()
    return false
  }

  // ── ipcRenderer 形状 ──────────────────────────────────────────────────────

  invoke(channel: string, ...args: unknown[]): Promise<any> {
    const id = `i${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`invoke timeout: ${channel}`))
      }, INVOKE_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.sendRaw({ t: 'invoke', id, ch: channel, args: args.map(toWire) })
    })
  }

  send(channel: string, ...args: unknown[]): void {
    this.sendRaw({ t: 'send', ch: channel, args: args.map(toWire) })
  }

  /** 同步读取：目前仅 config:get-sync —— 由服务端注入的 __DEVA_BOOT__ 提供。 */
  sendSync(channel: string, ..._args: unknown[]): any {
    if (channel === 'config:get-sync') {
      const boot = (window as any).__DEVA_BOOT__
      return (boot && boot.config) || {}
    }
    return undefined
  }

  on(channel: string, listener: Listener): void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(listener)
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener)
  }
}

export const webIpc = new WebIpc()
