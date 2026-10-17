/**
 * Deva Web 认证（单管理员）。
 *
 * 凭据存储：~/.deva/web-auth.json（0600）
 *   { user, salt, hash(scrypt), secret(HMAC 会话密钥), createdAt }
 * 首次启动自动生成：用户名 admin + 强随机密码（同时写 ~/.deva/web-login.txt 供用户查看，
 * 可用 `node out/web/ctl.js passwd <新密码>` 重置后删除该文件）。
 *
 * 会话：无状态签名 token —— `<exp>.<hmac(secret, "s1|exp|user")>`，HttpOnly Cookie，默认 30 天。
 * 登录限速：每 IP 连续 5 次失败锁定 10 分钟（内存态，重启清零）。
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface AuthFile {
  user: string
  salt: string
  hash: string
  secret: string
  createdAt: number
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
export const COOKIE_NAME = 'deva_sid'

function devaHome(): string {
  const o = process.env.DEVA_HOME?.trim()
  return o && o.length > 0 ? o : join(homedir(), '.deva')
}

function authPath(): string {
  return join(devaHome(), 'web-auth.json')
}

/** 生成强密码：大小写 + 数字 + 符号，20 位（约 128 bit 熵）。 */
export function generateStrongPassword(): string {
  const sets = [
    'abcdefghijkmnpqrstuvwxyz',
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    '23456789',
    '!@#$%^&*-_=+?'
  ]
  const all = sets.join('')
  const buf = randomBytes(64)
  let out = ''
  let bi = 0
  const next = (): number => buf[bi++ % buf.length]
  // 每类至少一位
  for (const s of sets) out += s[next() % s.length]
  while (out.length < 20) out += all[next() % all.length]
  // 洗牌（Fisher–Yates，用随机字节驱动）
  const arr = out.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

export function hashPassword(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, 'hex')
  return scryptSync(password, salt, 64).toString('hex')
}

export function loadOrInitAuth(): { auth: AuthFile; createdPassword?: string } {
  const p = authPath()
  try {
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as AuthFile
    if (parsed?.user && parsed?.salt && parsed?.hash && parsed?.secret) {
      return { auth: parsed }
    }
  } catch {
    /* 不存在 / 损坏 → 重建 */
  }
  const user = process.env.DEVA_WEB_USER?.trim() || 'admin'
  const password = process.env.DEVA_WEB_PASSWORD?.trim() || generateStrongPassword()
  const salt = randomBytes(16).toString('hex')
  const auth: AuthFile = {
    user,
    salt,
    hash: hashPassword(password, salt),
    secret: randomBytes(32).toString('hex'),
    createdAt: Date.now()
  }
  mkdirSync(devaHome(), { recursive: true })
  const tmp = `${p}.tmp-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
  // 初始密码留档（0600），供用户登录后取走；重置密码（ctl passwd）后此文件被覆盖为提示
  try {
    writeFileSync(
      join(devaHome(), 'web-login.txt'),
      `Deva Web 登录凭据（请在首次登录后妥善保存，然后删除本文件）\n用户名: ${user}\n密码: ${password}\n`,
      { mode: 0o600 }
    )
  } catch {
    /* 落档失败不阻挡启动；密码会打印到日志一次 */
  }
  return { auth, createdPassword: password }
}

export function verifyPassword(auth: AuthFile, password: string): boolean {
  try {
    const got = Buffer.from(hashPassword(password, auth.salt), 'hex')
    const want = Buffer.from(auth.hash, 'hex')
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}

function sign(secret: string, exp: number, user: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`s1|${exp}|${user}`).digest('base64url')
}

export function issueToken(auth: AuthFile): { token: string; maxAge: number } {
  const exp = Date.now() + SESSION_TTL_MS
  return { token: `${exp}.${sign(auth.secret, exp, auth.user)}`, maxAge: Math.floor(SESSION_TTL_MS / 1000) }
}

export function verifyToken(auth: AuthFile, token: string | undefined): boolean {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const exp = Number(token.slice(0, dot))
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const sig = token.slice(dot + 1)
  const want = sign(auth.secret, exp, auth.user)
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  } catch {
    return false
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

// ── 登录限速（每 IP） ──────────────────────────────────────────────────────
const MAX_FAILS = 5
const LOCK_MS = 10 * 60 * 1000
const bucket = new Map<string, { fails: number; lockedUntil: number }>()

export function checkLoginAllowed(ip: string): { ok: boolean; retryAfterSec: number } {
  const b = bucket.get(ip)
  if (!b) return { ok: true, retryAfterSec: 0 }
  if (b.lockedUntil > Date.now()) {
    return { ok: false, retryAfterSec: Math.ceil((b.lockedUntil - Date.now()) / 1000) }
  }
  return { ok: true, retryAfterSec: 0 }
}

export function recordLoginFail(ip: string): void {
  const b = bucket.get(ip) ?? { fails: 0, lockedUntil: 0 }
  b.fails += 1
  if (b.fails >= MAX_FAILS) {
    b.lockedUntil = Date.now() + LOCK_MS
    b.fails = 0
  }
  bucket.set(ip, b)
}

export function clearLoginFails(ip: string): void {
  bucket.delete(ip)
}

/** 最近是否发生过失败（登录页提示用，不暴露具体计数）。 */
export function hasRecentFails(ip: string): boolean {
  const b = bucket.get(ip)
  return Boolean(b && (b.fails > 0 || b.lockedUntil > Date.now()))
}
