/**
 * Deva Web 服务器入口。
 *
 * 结构：
 *   HTTP  :8790
 *     GET  /            → 已认证：Web 版 index.html（含启动闪屏）；未认证：302 /login
 *     GET  /login       → 登录页（已认证则 302 /）；POST /api/login 校验（限速）
 *     GET  /api/boot.js → 首帧引导（同步配置 + 用户名，防闪烁）
 *     GET  /api/browse  → 认证后：服务器文件系统浏览（Web 文件选择器数据源）
 *     POST /api/logout  → 登出
 *     GET  /assets/*    → 静态资源（构建产物，带缓存头）
 *   WS    /ws           → 已认证：RPC（invoke/send/sync）+ 事件推送（175 个通道 1:1 复用）
 *
 * 服务层：直接复用 apps/desktop/src/main/services/*（经 esbuild alias 把 'electron'
 * 换成本目录的 electron-shim，零改动跑在纯 Node 进程中）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFile, readdir, stat } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { extname, join, normalize, resolve, dirname, basename } from 'path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  invokeChannel,
  emitToMain,
  syncToMain,
  hasHandler,
  fireNotifyClick,
  ipcMain as shimIpcMain
} from './electron-shim'
import { addClient, removeClient, requestClient, resolveRequest, clientCount, webWindow, broadcast } from './bus'
import {
  COOKIE_NAME,
  checkLoginAllowed,
  clearLoginFails,
  issueToken,
  loadOrInitAuth,
  parseCookies,
  recordLoginFail,
  verifyPassword,
  verifyToken,
  type AuthFile
} from './auth'
import { loginPageHtml } from './login-page'

// ── 服务注册（与主进程 index.ts 同顺序） ─────────────────────────────────────
import { getConfig, registerConfigIpc } from '../main/services/config'
import { registerWorkspaceIpc } from '../main/services/workspace'
import { registerSecretsIpc } from '../main/services/secrets'
import { registerProviderIpc } from '../main/services/provider'
import { hasActiveTurns, registerChatIpc, settleActiveTurns } from '../main/services/chat'
import { listSessions } from '../main/services/chat-store'
import { sweepCheckpoints } from '../main/services/checkpoints'
import { sweepSubagents } from '../main/services/subagent-store'
import { registerSkillsIpc } from '../main/services/skills'
import { ensureSeededPersonas, registerPersonasIpc } from '../main/services/personas'
import { registerProfileIpc } from '../main/services/profile'
import { registerMemoryIpc } from '../main/services/memory'
import {
  autoConnectEnabledServers,
  disconnectAllServers,
  registerMcpIpc
} from '../main/services/mcp'
import { registerAttachmentsIpc } from '../main/services/attachments'
import { registerTerminalIpc } from '../main/services/terminal'
import { registerGitIpc } from '../main/services/git'
import { registerClipboardIpc } from '../main/services/clipboard'
import { registerTasksIpc } from '../main/services/tasks'
import { startScheduler } from '../main/services/scheduler'
import { registerRemoteIpc, stopAllChannels } from '../main/services/remote'
import { registerUpdaterIpc } from '../main/services/updater'

const __dirname_ = __dirname
const PORT = Number(process.env.DEVA_WEB_PORT ?? 8790)
const HOST = process.env.DEVA_WEB_HOST ?? '127.0.0.1'
const STATIC_ROOT = process.env.DEVA_WEB_STATIC ?? join(__dirname_, 'renderer')

const { auth, createdPassword } = loadOrInitAuth()
if (createdPassword) {
  console.log(`[deva-web] 已生成登录凭据：用户 ${auth.user}，初始密码见 ~/.deva/web-login.txt`)
}

// ── 应用页渲染（首帧引导内联；性能优化核心） ────────────────────────────────
// 构建产物 index.html 作模板，把认证后的同步配置注入 deva-boot JSON 数据块：
//   - 替代曾经的 /api/boot.js 串行请求（省 1 个 RTT；application/json 数据块不受 CSP 限制）
//   - JSON 中 '<' 转义为 \u003c，杜绝 </script> 提前闭合
let appTemplate: string | null = null
function loadAppTemplate(): string {
  if (appTemplate === null) {
    try {
      appTemplate = readFileSync(join(STATIC_ROOT, 'index.html'), 'utf8')
    } catch {
      appTemplate = ''
    }
  }
  return appTemplate
}

function renderAppHtml(): string {
  const tpl = loadAppTemplate()
  if (!tpl) return ''
  const config = (syncToMain('config:get-sync', []) ?? {}) as Record<string, unknown>
  const json = JSON.stringify({ user: auth.user, config, version: '0.1.7' }).replace(/</g, '\\u003c')
  return tpl.replace(
    /<script id="deva-boot"[^>]*>[\s\S]*?<\/script>/,
    `<script id="deva-boot" type="application/json">${json}</script>`
  )
}

async function serveAppPage(res: ServerResponse): Promise<void> {
  const html = renderAppHtml()
  if (!html) {
    res.statusCode = 404
    res.end('Not Found')
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(html)
}

/** 登录页预取列表：构建产物中的哈希化 JS/CSS（登录后首屏直接命中浏览器缓存）。 */
async function assetPrefetchUrls(): Promise<string[]> {
  try {
    const names = await readdir(join(STATIC_ROOT, 'assets'))
    return names.filter((n) => n.endsWith('.js') || n.endsWith('.css')).map((n) => `/assets/${n}`)
  } catch {
    return []
  }
}

// ── 服务层引导（注册全部 IPC；shim 内存注册表） ─────────────────────────────
function bootServices(): void {
  const webWindowRef = (): any => webWindow()

  registerConfigIpc()
  registerWorkspaceIpc(webWindowRef)
  registerSecretsIpc()
  registerProviderIpc()
  registerChatIpc(webWindowRef)
  registerRemoteIpc(webWindowRef)
  void sweepCheckpoints(listSessions().map((m) => m.id)).catch(() => {})
  void sweepSubagents(listSessions().map((m) => m.id)).catch(() => {})
  registerSkillsIpc(webWindowRef)
  ensureSeededPersonas()
  registerPersonasIpc()
  registerProfileIpc()
  registerMemoryIpc()
  registerMcpIpc(webWindowRef)
  registerAttachmentsIpc(webWindowRef)
  registerTerminalIpc(webWindowRef)
  registerGitIpc()
  registerClipboardIpc()
  registerTasksIpc(webWindowRef)
  registerUpdaterIpc(webWindowRef)

  // Web 专属通道
  registerWebChannels()

  autoConnectEnabledServers()
  startScheduler(webWindowRef)
}

function registerWebChannels(): void {
  // 与主进程 window:* 对齐（web 无窗口：安全空操作）
  shimIpcMain.handle('window:minimize', () => {})
  shimIpcMain.handle('window:toggle-maximize', () => {})
  shimIpcMain.handle('window:close', () => {})
  shimIpcMain.handle('window:set-overlay', () => {})
  shimIpcMain.handle('app:get-platform', () => 'linux')
  // 通知点击回流（浏览器点了通知 → 触发主进程 Notification click 回调）
  shimIpcMain.on('web:notify-click', (_e: unknown, id: string) => fireNotifyClick(id))
  // 剪贴板同步（浏览器聚焦时把本机剪贴板送进服务端缓存）
  shimIpcMain.on('web:clipboard-cache', (_e: unknown, text: string) => {
    ;(globalThis as any).__devaClipboardCache = typeof text === 'string' ? text : String(text ?? '')
  })
}

// dialog 钩子：浏览器端文件选择器（往返 WS）
;(globalThis as any).__devaDialogRequest = async (opts: Record<string, unknown>) => {
  const res = await requestClient('dialog', opts)
  const r = res as { canceled?: boolean; filePaths?: string[] } | null
  if (!r || r.canceled || !Array.isArray(r.filePaths)) return { canceled: true, filePaths: [] }
  return { canceled: false, filePaths: r.filePaths }
}
// openExternal 钩子：广播给浏览器新开标签
;(globalThis as any).__devaOpenExternal = (url: string) => {
  broadcast('web:open-url', [url])
}
// 浏览器通知钩子
;(globalThis as any).__devaNotify = (payload: { id: string; title: string; body: string }) => {
  broadcast('web:notify', [payload])
}
// 剪贴板写钩子（服务端写 → 浏览器剪贴板）
;(globalThis as any).__devaClipboardWrite = (text: string) => {
  broadcast('web:clipboard-write', [text])
}

bootServices()

// ── HTTP ────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function isSecure(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  return proto === 'https' || (typeof proto === 'string' && proto.split(',')[0].trim() === 'https')
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAge: number): void {
  const bits = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (isSecure(req)) bits.push('Secure')
  res.setHeader('Set-Cookie', bits.join('; '))
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function authed(req: IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie)
  return verifyToken(auth, cookies[COOKIE_NAME])
}

async function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  try {
    // ── 登录 / 登出 ──
    if (path === '/login' && req.method === 'GET') {
      if (authed(req)) {
        res.statusCode = 302
        res.setHeader('Location', '/')
        res.end()
        return
      }
      const html = loginPageHtml(await assetPrefetchUrls())
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(html)
      return
    }

    if (path === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req)
      const gate = checkLoginAllowed(ip)
      if (!gate.ok) {
        json(res, 429, { ok: false, error: 'locked', retryAfterSec: gate.retryAfterSec })
        return
      }
      let body: { user?: string; password?: string } = {}
      try {
        const raw = await readBody(req)
        const ct = String(req.headers['content-type'] ?? '')
        if (ct.includes('application/json')) body = JSON.parse(raw.toString('utf8'))
        else body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
      } catch {
        json(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      const ok =
        typeof body.user === 'string' &&
        typeof body.password === 'string' &&
        body.user.trim() === auth.user &&
        verifyPassword(auth, body.password)
      if (!ok) {
        recordLoginFail(ip)
        json(res, 401, { ok: false, error: 'invalid' })
        return
      }
      clearLoginFails(ip)
      const { token, maxAge } = issueToken(auth)
      setSessionCookie(req, res, token, maxAge)
      json(res, 200, { ok: true, user: auth.user })
      return
    }

    if (path === '/api/logout' && req.method === 'POST') {
      clearSessionCookie(res)
      json(res, 200, { ok: true })
      return
    }

    if (path === '/api/health') {
      if (!authed(req)) {
        json(res, 401, { ok: false })
        return
      }
      json(res, 200, { ok: true, clients: clientCount(), up: Math.floor(process.uptime()) })
      return
    }

    // ── 认证墙 ──
    // 例外：/assets/* 公开（前端构建产物、无敏感数据）—— 登录页须预取它们实现「登录后秒开」，
    // 且允许 CF 边缘缓存匿名命中。数据接口 /api/*、页面本身与 WS 仍严格鉴权。
    if (!authed(req) && !(req.method === 'GET' && path.startsWith('/assets/'))) {
      if (
        req.method === 'GET' &&
        (path === '/' || path === '/index.html' || (!path.startsWith('/api/') && !path.includes('.')))
      ) {
        // 页面导航 → 登录页（不渲染任何应用内容，杜绝闪现）
        res.statusCode = 302
        res.setHeader('Location', '/login')
        res.end()
        return
      }
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    // ── 首帧引导（同步配置；防闪烁） ──
    if (path === '/api/boot.js') {
      const config = (syncToMain('config:get-sync', []) ?? {}) as Record<string, unknown>
      const js = `window.__DEVA_BOOT__=${JSON.stringify({ user: auth.user, config, version: '0.1.7' })};`
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(js)
      return
    }

    // ── 服务器文件浏览（Web 文件选择器数据源） ──
    if (path === '/api/browse' && req.method === 'GET') {
      const target = url.searchParams.get('path') || process.env.HOME || '/root'
      const abs = resolve(target)
      try {
        const st = await stat(abs)
        if (!st.isDirectory()) {
          json(res, 400, { ok: false, error: 'not-a-directory' })
          return
        }
        const dirents = await readdir(abs, { withFileTypes: true })
        const entries = dirents
          .filter((d) => d.isDirectory() || d.isFile())
          .map((d) => ({
            name: d.name,
            path: join(abs, d.name),
            type: d.isDirectory() ? ('dir' as const) : ('file' as const)
          }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
        json(res, 200, { ok: true, path: abs, parent: dirname(abs), entries })
      } catch (e) {
        json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    // ── 上传（技能包等；落临时目录后由 /api/skills/import-upload 导入） ──
    if (path === '/api/upload' && req.method === 'POST') {
      const name = url.searchParams.get('name') || 'upload.bin'
      const raw = await readBody(req, 64 * 1024 * 1024)
      const dir = join(process.env.HOME || '/root', '.deva', 'web-uploads')
      mkdirSync(dir, { recursive: true })
      const safe = basename(name).replace(/[^\w.@()-]+/g, '_') || 'upload.bin'
      const dest = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`)
      writeFileSync(dest, raw)
      json(res, 200, { ok: true, path: dest })
      return
    }

    // ── 静态资源 ──
    let rel = path === '/' ? '/index.html' : path
    // 应用主页（含 /index.html 直达）：统一走注入渲染（首帧引导内联，零额外请求）
    if (rel === '/index.html') {
      await serveAppPage(res)
      return
    }
    const filePath = normalize(join(STATIC_ROOT, rel))
    if (!filePath.startsWith(STATIC_ROOT) || !existsSync(filePath)) {
      // SPA 回落：无扩展名的路径一律回首页（同样注入首帧引导）
      if (!extname(rel)) {
        if (existsSync(join(STATIC_ROOT, 'index.html'))) {
          await serveAppPage(res)
          return
        }
      }
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const ext = extname(filePath).toLowerCase()
    const data = await readFile(filePath)
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
    if (rel.startsWith('/assets/') && !rel.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('Cache-Control', 'no-store')
    }
    res.end(data)
  } catch (e) {
    console.error('[deva-web] http error', e)
    if (!res.headersSent) {
      res.statusCode = 500
      res.end('Internal Error')
    }
  }
})

// ── WebSocket RPC ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  const cookies = parseCookies(req.headers.cookie)
  const token = cookies[COOKIE_NAME]
  if (!verifyToken(auth, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

/** Uint8Array 的 JSON 编解码（粘贴附件字节流经 WS 传输）。 */
function encodeArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a instanceof Uint8Array) {
      return { __u8: Buffer.from(a).toString('base64') }
    }
    if (a instanceof ArrayBuffer) {
      return { __u8: Buffer.from(new Uint8Array(a)).toString('base64') }
    }
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      const obj = a as Record<string, unknown>
      if (obj.data instanceof Uint8Array) {
        return { ...obj, data: { __u8: Buffer.from(obj.data).toString('base64') } }
      }
      if (obj.data instanceof ArrayBuffer) {
        return { ...obj, data: { __u8: Buffer.from(new Uint8Array(obj.data)).toString('base64') } }
      }
    }
    return a
  })
}

function decodeArgs(args: unknown[]): unknown[] {
  const dec = (v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as any).__u8) {
      return new Uint8Array(Buffer.from((v as any).__u8, 'base64'))
    }
    return v
  }
  return args.map(dec)
}

wss.on('connection', (ws: WebSocket) => {
  const conn = addClient(ws)
  conn.send(JSON.stringify({ t: 'welcome', user: auth.user, server: 'deva-web' }))

  // 心跳
  ;(ws as any).isAlive = true
  ws.on('pong', () => {
    ;(ws as any).isAlive = true
  })

  ws.on('message', (raw) => {
    let msg: any
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'ping') {
      // 客户端探活：原样回 ts，客户端据此判定链路是否僵尸
      try {
        conn.send(JSON.stringify({ t: 'pong', ts: msg.ts }))
      } catch {
        /* noop */
      }
      return
    }
    if (msg.t === 'res') {
      resolveRequest(String(msg.id), msg.payload)
      return
    }
    if (msg.t === 'invoke' && typeof msg.ch === 'string') {
      const id = msg.id
      const args = decodeArgs(Array.isArray(msg.args) ? msg.args : [])
      void (async () => {
        try {
          if (!hasHandler(msg.ch)) throw new Error(`No handler for '${msg.ch}'`)
          const value = await invokeChannel(msg.ch, args)
          conn.send(JSON.stringify({ t: 'invoke-res', id, ok: true, value }))
        } catch (e) {
          conn.send(
            JSON.stringify({
              t: 'invoke-res',
              id,
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          )
        }
      })()
      return
    }
    if (msg.t === 'send' && typeof msg.ch === 'string') {
      const args = decodeArgs(Array.isArray(msg.args) ? msg.args : [])
      try {
        emitToMain(msg.ch, args)
      } catch (e) {
        console.error(`[deva-web send ${msg.ch}]`, e)
      }
      return
    }
    if (msg.t === 'sync' && typeof msg.ch === 'string') {
      const args = decodeArgs(Array.isArray(msg.args) ? msg.args : [])
      try {
        const value = syncToMain(msg.ch, args)
        conn.send(JSON.stringify({ t: 'sync-res', id: msg.id, value }))
      } catch {
        conn.send(JSON.stringify({ t: 'sync-res', id: msg.id, value: null }))
      }
      return
    }
  })

  ws.on('close', () => removeClient(conn.id))
  ws.on('error', () => removeClient(conn.id))
})

// 会话过期踢出 + 心跳清理
const heartbeat = setInterval(() => {
  for (const ws of wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try {
      ws.ping()
    } catch {
      /* noop */
    }
  }
}, 30_000)
heartbeat.unref?.()

server.listen(PORT, HOST, () => {
  console.log(`[deva-web] listening on http://${HOST}:${PORT} (static: ${STATIC_ROOT})`)
})

// ── 优雅退出 ───────────────────────────────────────────────────────────────
let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`[deva-web] ${signal} → 收尾中…`)
  try {
    if (hasActiveTurns()) await settleActiveTurns(3000)
  } catch {
    /* noop */
  }
  try {
    await disconnectAllServers()
  } catch {
    /* noop */
  }
  try {
    await stopAllChannels()
  } catch {
    /* noop */
  }
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server shutdown')
    } catch {
      /* noop */
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref?.()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// 未捕获异常仅记录，不退出（守护模式：单个会话出错不应导致全站不可用）
process.on('uncaughtException', (e) => console.error('[deva-web] uncaughtException', e))
process.on('unhandledRejection', (e) => console.error('[deva-web] unhandledRejection', e))
