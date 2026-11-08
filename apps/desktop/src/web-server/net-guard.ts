import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'

export type TrustProxyMode = 'auto' | 'cloudflare' | 'none'

export interface GuardRequest {
  headers: IncomingHttpHeaders
  socket?: { remoteAddress?: string | null }
}

export interface WsOriginCheckResult {
  action: 'allow' | 'deny'
  warn?: string
}

/** 进程内只打印一次「反代未透传 Host」告警，避免每次 WS 重连刷屏。 */
let missingHostProxyWarned = false

function firstHeader(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return (v[0] ?? '').trim()
  return typeof v === 'string' ? v.trim() : ''
}

function isPrivateIpv4Parts(a: number, b: number): boolean {
  if (a === 127) return true // 127.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 169.254.0.0/16
  return false
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const a = Number(parts[0])
  const b = Number(parts[1])
  return isPrivateIpv4Parts(a, b)
}

function expandIpv6Words(ip: string): number[] | null {
  let addr = ip
  // 处理末段内嵌点分 IPv4（如 ::ffff:127.0.0.1）
  const lastColon = addr.lastIndexOf(':')
  if (lastColon !== -1 && addr.indexOf('.', lastColon) !== -1) {
    const v4 = addr.slice(lastColon + 1)
    if (isIP(v4) !== 4) return null
    const oct = v4.split('.').map(Number)
    const hi = ((oct[0] << 8) | oct[1]).toString(16)
    const lo = ((oct[2] << 8) | oct[3]).toString(16)
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = addr.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null

  const full = [...left, ...Array<string>(missing).fill('0'), ...right]
  if (full.length !== 8) return null
  const words: number[] = []
  for (const h of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null
    words.push(parseInt(h, 16))
  }
  return words
}

/**
 * 判断地址是否属于回环或内网：
 * 127.0.0.0/8、::1、10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10，
 * 以及 ::ffff: 开头的 IPv4 映射形式（先剥离 ::ffff: 再按 IPv4 判断）。
 */
export function isLoopbackOrPrivateIp(raw: string | undefined | null): boolean {
  if (!raw) return false
  const trimmed = raw.trim()
  if (!trimmed) return false
  // Linux socket 对链路本地地址可能附带 %eth0 作用域后缀
  const noZone = trimmed.includes('%') ? trimmed.slice(0, trimmed.indexOf('%')) : trimmed
  const v4Candidate = noZone.replace(/^::ffff:/i, '')
  if (isIP(v4Candidate) === 4) {
    return isPrivateIpv4(v4Candidate)
  }
  if (isIP(noZone) === 6) {
    const w = expandIpv6Words(noZone)
    if (!w) return false
    // ::1
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && w[6] === 0 && w[7] === 1) {
      return true
    }
    // ::ffff:0:0/96（十六进制形式的 IPv4 映射）
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
      return isPrivateIpv4Parts(w[6] >> 8, w[6] & 0xff)
    }
    // fc00::/7
    if ((w[0] & 0xfe00) === 0xfc00) return true
    // fe80::/10
    if ((w[0] & 0xffc0) === 0xfe80) return true
  }
  return false
}

function cleanIpCandidate(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v) return null
  return isIP(v) !== 0 ? v : null
}

function extractLastXff(xff: string | string[] | undefined): string | null {
  if (xff === undefined) return null
  const joined = Array.isArray(xff) ? xff.join(',') : xff
  if (!joined.trim()) return null
  const parts = joined.split(',')
  return cleanIpCandidate(parts[parts.length - 1])
}

/**
 * 解析真实客户端 IP（供登录失败限速等使用）。
 * mode 默认读取环境变量 DEVA_WEB_TRUST_PROXY（未设则 auto）。
 */
export function resolveClientIp(
  req: GuardRequest,
  mode: string = process.env.DEVA_WEB_TRUST_PROXY ?? 'auto'
): string {
  const remote = req.socket?.remoteAddress?.trim() || 'unknown'
  const m = (mode || 'auto').trim().toLowerCase()
  if (m === 'none') return remote
  if (!isLoopbackOrPrivateIp(remote)) return remote

  if (m === 'cloudflare') {
    const cfRaw = firstHeader(req.headers['cf-connecting-ip'])
    if (cfRaw.length > 0) {
      return cleanIpCandidate(cfRaw) ?? remote
    }
    return extractLastXff(req.headers['x-forwarded-for']) ?? remote
  }

  // auto（默认）
  return extractLastXff(req.headers['x-forwarded-for']) ?? remote
}

function normalizeOriginFull(s: string): string {
  return s.trim().replace(/\/+$/, '').toLowerCase()
}

function parseOrigin(origin: string): { protocol: string; hostPort: string } | null {
  try {
    const u = new URL(origin.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      return null
    }
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      return null
    }
    // URL.host 已将主机名转小写，并自动剥离对应协议的默认端口（http/ws 80、https/wss 443）
    return { protocol: u.protocol, hostPort: u.host.toLowerCase() }
  } catch {
    return null
  }
}

function normalizeCandidateHostPort(rawHost: string, originProtocol: string): string | null {
  const c = rawHost.trim()
  if (!c || c.includes('/') || c.includes('@') || c.includes('?') || c.includes('#')) return null
  try {
    const u = new URL(`${originProtocol}//${c}`)
    if (u.username || u.password || u.pathname !== '/') return null
    // URL.host 自动归一对应协议的默认端口（http/ws 80、https/wss 443）并转小写
    return u.host.toLowerCase()
  } catch {
    return null
  }
}

function isHostIpOrLocalhost(rawHost: string): boolean {
  const c = rawHost.trim()
  if (!c || c.includes('/') || c.includes('@') || c.includes('?') || c.includes('#')) return false
  try {
    const u = new URL(`http://${c}`)
    const hn = u.hostname.toLowerCase()
    if (hn === 'localhost') return true
    const bare = hn.startsWith('[') && hn.endsWith(']') ? hn.slice(1, -1) : hn
    return isIP(bare) !== 0
  } catch {
    return false
  }
}

function sanitizeForLog(v: string | undefined): string {
  if (!v) return '-'
  return v.replace(/[\r\n\t]+/g, ' ').slice(0, 256)
}

function logWsOriginWarn(kind: 'deny' | 'warn', msg: string, req: GuardRequest, remote: string): void {
  const origin = sanitizeForLog(firstHeader(req.headers.origin))
  const host = sanitizeForLog(firstHeader(req.headers.host))
  const xfh = sanitizeForLog(firstHeader(req.headers['x-forwarded-host']))
  const peer = sanitizeForLog(remote)
  const text = msg.includes('可设置 DEVA_WEB_ALLOWED_ORIGINS 放行')
    ? msg
    : `${msg}（可设置 DEVA_WEB_ALLOWED_ORIGINS 放行）`
  // 严禁打印 Cookie、Authorization 或 URL 查询串（避免泄露会话或免密 token）
  console.warn(
    `[deva-web] ws origin ${kind}: ${text} | Origin=${origin} Host=${host} X-Forwarded-Host=${xfh} remote=${peer}`
  )
}

/**
 * WebSocket 升级请求的 Origin 校验（防跨站 WebSocket 劫持 CSWSH）。
 */
export function checkWsOrigin(req: GuardRequest): WsOriginCheckResult {
  // 1. 无 Origin 头 → allow（非浏览器客户端）
  const rawOrigin = firstHeader(req.headers.origin)
  if (!rawOrigin) return { action: 'allow' }

  // 2. DEVA_WEB_ORIGIN_CHECK=off → allow
  const checkMode = (process.env.DEVA_WEB_ORIGIN_CHECK ?? 'strict').trim().toLowerCase()
  if (checkMode === 'off') return { action: 'allow' }

  // 3. 命中 DEVA_WEB_ALLOWED_ORIGINS（逗号分隔，忽略大小写和末尾斜杠）→ allow
  const allowedEnv = process.env.DEVA_WEB_ALLOWED_ORIGINS ?? ''
  if (allowedEnv.trim().length > 0) {
    const target = normalizeOriginFull(rawOrigin)
    const allowed = allowedEnv
      .split(',')
      .map(normalizeOriginFull)
      .filter((x) => x.length > 0)
    if (allowed.includes(target)) return { action: 'allow' }
  }

  const remote = req.socket?.remoteAddress?.trim() || 'unknown'
  const peerTrusted = isLoopbackOrPrivateIp(remote)
  const hostHeader = firstHeader(req.headers.host)
  const xfhRaw = firstHeader(req.headers['x-forwarded-host'])
  const xfhFirst = xfhRaw ? xfhRaw.split(',')[0].trim() : ''

  // 4. 比较 Origin 的 host:port 与候选（Host，以及内网对端下的 X-Forwarded-Host 第一项）
  const parsed = parseOrigin(rawOrigin)
  if (parsed) {
    const candidates = [hostHeader]
    if (peerTrusted && xfhFirst) candidates.push(xfhFirst)
    for (const cand of candidates) {
      if (!cand) continue
      const candNorm = normalizeCandidateHostPort(cand, parsed.protocol)
      if (candNorm && candNorm === parsed.hostPort) {
        return { action: 'allow' }
      }
    }

    // 5. 对端属于回环或内网，且 Host 主机名为 IP 字面量或 localhost（反代未透传 Host）→ allow + warn（进程内只打印一次）
    if (peerTrusted && isHostIpOrLocalhost(hostHeader)) {
      const warn = '反代未透传 Host，已放行；建议配置 Host 透传或 DEVA_WEB_ALLOWED_ORIGINS'
      if (!missingHostProxyWarned) {
        missingHostProxyWarned = true
        logWsOriginWarn('warn', warn, req, remote)
      }
      return { action: 'allow', warn }
    }
  }

  // 6. 其他不匹配情况：warn 模式放行并告警，默认 strict 拒绝
  if (checkMode === 'warn') {
    const warn = 'Origin 与 Host 不匹配，warn 模式已放行；可设置 DEVA_WEB_ALLOWED_ORIGINS 放行'
    logWsOriginWarn('warn', warn, req, remote)
    return { action: 'allow', warn }
  }

  logWsOriginWarn('deny', 'Origin 与 Host 不匹配，已拒绝连接；可设置 DEVA_WEB_ALLOWED_ORIGINS 放行', req, remote)
  return { action: 'deny' }
}
