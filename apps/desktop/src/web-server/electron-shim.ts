/**
 * Node 侧 Electron 兼容层（Deva Web 版专用，仅经 esbuild alias 注入 web 构建）。
 *
 * 目的：让 src/main/services/*（约 1.7 万行、原本跑在 Electron 主进程）零改动在纯 Node
 * 进程中运行 ——
 *   ipcMain        → 内存注册表，由 web-server 的 WS RPC 调度器驱动
 *   app            → 极简替身（getPath / getVersion / whenReady…）
 *   safeStorage    → AES-256-GCM（密钥落 ~/.deva/web-secret.key，0600）
 *   dialog         → 往返浏览器端「服务器文件选择器」（经 WS 由客户端 UI 完成）
 *   clipboard      → 缓存 + 往返浏览器 navigator.clipboard
 *   Notification   → 广播给浏览器前端弹通知（点击可回传）
 *   shell          → openExternal 转发浏览器新开标签；openPath 不支持返回错误文本
 *   net            → 全局 fetch（Node 18+）
 *   utilityProcess → worker_threads（pty 宿主以 worker 方式运行）
 *   BrowserWindow / Tray / Menu / nativeTheme → 无害替身（web 无窗口体系）
 *
 * 桌面（Electron）构建不受影响：electron.vite.config.ts 不做此替换。
 */
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import * as nodeFs from 'node:fs'
import * as nodeCrypto from 'node:crypto'
import { join as _join } from 'node:path'
import { Worker } from 'node:worker_threads'

export type IpcHandler = (event: unknown, ...args: any[]) => any

// ── ipcMain：注册表 ────────────────────────────────────────────────────────
const handlers = new Map<string, IpcHandler>()
const listeners = new Map<string, Set<IpcHandler>>()

export const ipcMain = {
  handle(channel: string, fn: IpcHandler): void {
    handlers.set(channel, fn)
  },
  handleOnce(channel: string, fn: IpcHandler): void {
    handlers.set(channel, fn)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(channel: string, fn: IpcHandler): void {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(fn)
  },
  once(channel: string, fn: IpcHandler): void {
    ipcMain.on(channel, fn)
  },
  removeListener(channel: string, fn: IpcHandler): void {
    listeners.get(channel)?.delete(fn)
  },
  emit(channel: string, ...args: any[]): void {
    for (const fn of listeners.get(channel) ?? []) {
      try {
        fn({ sender: null }, ...args)
      } catch (e) {
        console.error(`[ipcMain.on ${channel}]`, e)
      }
    }
  }
}

/** 供 WS RPC 调度器调用：执行 handle 注册的处理器。 */
export async function invokeChannel(channel: string, args: any[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No handler registered for '${channel}'`)
  return await fn({ sender: null }, ...args)
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

/** 供 WS RPC 调度器调用：投递 send 到 ipcMain.on 监听器。 */
export function emitToMain(channel: string, args: any[]): void {
  ipcMain.emit(channel, ...args)
}

/** 模拟 sendSync：跑监听器并取 evt.returnValue。 */
export function syncToMain(channel: string, args: any[]): any {
  const evt: { sender: null; returnValue: any } = { sender: null, returnValue: undefined }
  for (const fn of listeners.get(channel) ?? []) {
    try {
      const r = fn(evt, ...args)
      if (r !== undefined) evt.returnValue = r
    } catch (e) {
      console.error(`[ipcMain.sync ${channel}]`, e)
    }
  }
  return evt.returnValue
}

// ── app ────────────────────────────────────────────────────────────────────
function devaHome(): string {
  const o = process.env.DEVA_HOME?.trim()
  return o && o.length > 0 ? o : nodePath.join(nodeOs.homedir(), '.deva')
}

export const app = {
  isPackaged: false,
  runningUnderARM64Translation: false,
  getVersion: (): string => '0.1.7-web',
  getName: (): string => 'Deva Web',
  getPath: (name: string): string => {
    if (name === 'home') return nodeOs.homedir()
    if (name === 'userData') return nodePath.join(devaHome(), 'web-userdata')
    if (name === 'temp') return nodeOs.tmpdir()
    return nodeOs.homedir()
  },
  whenReady: (): Promise<void> => Promise.resolve(),
  isReady: (): boolean => true,
  on: (): any => app,
  once: (): any => app,
  quit: (): void => {},
  relaunch: (): void => {},
  requestSingleInstanceLock: (): boolean => true
}

// ── safeStorage：AES-256-GCM ──────────────────────────────────────────────
let keyCache: Buffer | null = null

function loadKey(): Buffer | null {
  if (keyCache) return keyCache
  try {
    const p = nodePath.join(devaHome(), 'web-secret.key')
    if (!nodeFs.existsSync(p)) {
      nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true })
      const k = nodeCrypto.randomBytes(32)
      nodeFs.writeFileSync(p, k.toString('hex'), { mode: 0o600 })
      keyCache = k
      return k
    }
    const hex = nodeFs.readFileSync(p, 'utf8').trim()
    if (hex.length !== 64) return null
    keyCache = Buffer.from(hex, 'hex')
    return keyCache
  } catch {
    return null
  }
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return loadKey() !== null
  },
  encryptString(plain: string): Buffer {
    const k = loadKey()
    if (!k) throw new Error('encryption unavailable')
    const iv = nodeCrypto.randomBytes(12)
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', k, iv)
    const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct])
  },
  decryptString(enc: Buffer): string {
    const k = loadKey()
    if (!k) throw new Error('decryption unavailable')
    const iv = Buffer.from(enc.subarray(0, 12))
    const tag = Buffer.from(enc.subarray(12, 28))
    const ct = Buffer.from(enc.subarray(28))
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', k, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  }
}

// ── dialog：往返浏览器端文件选择器 ────────────────────────────────────────
// 由 web-server 注入 __devaDialogRequest（WS 往返），浏览器端弹「服务器文件选择器」。
export const dialog = {
  async showOpenDialog(
    winOrOpts?: unknown,
    maybeOpts?: unknown
  ): Promise<{ canceled: boolean; filePaths: string[] }> {
    const opts = (maybeOpts ?? winOrOpts ?? {}) as Record<string, unknown>
    const hook = (globalThis as any).__devaDialogRequest
    if (typeof hook === 'function') {
      try {
        return await hook(opts)
      } catch {
        /* 浏览器不应答 → 视作取消 */
      }
    }
    return { canceled: true, filePaths: [] }
  }
}

// ── shell ──────────────────────────────────────────────────────────────────
export const shell = {
  async openExternal(url: string): Promise<void> {
    try {
      ;(globalThis as any).__devaOpenExternal?.(String(url))
    } catch {
      /* noop */
    }
  },
  async openPath(_p: string): Promise<string> {
    return 'Web 版不支持在服务器文件管理器中打开'
  }
}

// ── net ────────────────────────────────────────────────────────────────────
export const net = {
  fetch: (input: any, init?: any): Promise<any> => (globalThis.fetch as any)(input, init)
}

// ── clipboard：缓存 + 往返 ────────────────────────────────────────────────
export const clipboard = {
  readText(): string {
    const v = (globalThis as any).__devaClipboardCache
    return typeof v === 'string' ? v : ''
  },
  writeText(text: string): void {
    const t = typeof text === 'string' ? text : String(text)
    ;(globalThis as any).__devaClipboardCache = t
    try {
      ;(globalThis as any).__devaClipboardWrite?.(t)
    } catch {
      /* noop */
    }
  }
}

// ── Notification：广播给浏览器 ────────────────────────────────────────────
let notifySeq = 0
const notifyClicks = new Map<string, () => void>()

export class Notification {
  static isSupported(): boolean {
    return true
  }
  private id: string
  constructor(private opts: { title?: string; body?: string }) {
    this.id = `n${++notifySeq}`
  }
  on(evt: string, cb: () => void): this {
    if (evt === 'click') notifyClicks.set(this.id, cb)
    return this
  }
  show(): void {
    try {
      ;(globalThis as any).__devaNotify?.({
        id: this.id,
        title: this.opts.title ?? 'Deva',
        body: this.opts.body ?? ''
      })
    } catch {
      /* noop */
    }
  }
}

/** 浏览器端点通知回传时调用。 */
export function fireNotifyClick(id: string): void {
  const cb = notifyClicks.get(id)
  notifyClicks.delete(id)
  try {
    cb?.()
  } catch {
    /* noop */
  }
}

// ── utilityProcess → worker_threads ──────────────────────────────────────
// pty 宿主以 Worker 方式运行（worker 文件 pty-worker.cjs 与产物同目录，由它注入
// process.parentPort 后 require 目标宿主模块）。产物为 CJS：__dirname 直接可用。
function joinWorkerPath(): string {
  return _join(__dirname, 'pty-worker.cjs')
}

function forkWorker(modulePath: string): any {
  const sets: Record<string, Set<Function>> = {
    spawn: new Set(),
    message: new Set(),
    exit: new Set()
  }
  const emit = (evt: string, ...a: any[]): void => {
    for (const cb of sets[evt] ?? []) {
      try {
        cb(...a)
      } catch (e) {
        console.error(`[pty worker ${evt}]`, e)
      }
    }
  }
  const worker = new Worker(joinWorkerPath(), { workerData: { modulePath } })
  worker.on('online', () => emit('spawn'))
  worker.on('message', (m: unknown) => emit('message', m))
  worker.on('error', (e: Error) => {
    console.error('[pty worker error]', e)
    emit('exit', -1)
  })
  worker.on('exit', (code: number) => emit('exit', code))
  return {
    on(evt: string, cb: Function): void {
      sets[evt]?.add(cb)
    },
    postMessage(m: unknown): void {
      try {
        worker.postMessage(m)
      } catch {
        /* worker 已退出 */
      }
    },
    kill(): void {
      void worker.terminate()
    }
  }
}

export const utilityProcess = {
  fork: (modulePath: string): any => forkWorker(modulePath)
}

// ── 无害替身（web 无窗口体系；服务层仅类型引用或深度降级） ────────────────
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null
  }
  isDestroyed(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  isVisible(): boolean {
    return true
  }
  show(): void {}
  hide(): void {}
  focus(): void {}
  restore(): void {}
  close(): void {}
  maximize(): void {}
  unmaximize(): void {}
}

export class Tray {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
}

export class Menu {
  static buildFromTemplate(): { popup: () => void } {
    return { popup: () => {} }
  }
}

export const nativeTheme = {
  shouldUseDarkColors: false,
  on: (): void => {}
}

// ── nativeImage：pngjs/jpeg-js 替代 ────────────────────────────────────────
export { NativeImage, NativeImage as nativeImage } from './native-image'
