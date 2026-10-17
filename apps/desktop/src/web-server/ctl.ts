/**
 * Deva Web 管理工具（ctl）：
 *   node out/web/ctl.cjs passwd <新密码>   重置管理员密码（旧会话立即失效）
 *   node out/web/ctl.cjs passwd            生成一个强随机密码并重置
 *   node out/web/ctl.cjs user <用户名>     修改管理员用户名
 *   node out/web/ctl.cjs info              显示凭据文件位置与账号名（不含密码）
 */
import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function devaHome(): string {
  const o = process.env.DEVA_HOME?.trim()
  return o && o.length > 0 ? o : join(homedir(), '.deva')
}

const authPath = join(devaHome(), 'web-auth.json')

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(authPath, 'utf8'))
  } catch {
    console.error(`凭据文件不存在或损坏：${authPath}\n先启动一次 deva-web 以初始化。`)
    process.exit(1)
  }
}

function save(auth: Record<string, string>): void {
  const tmp = `${authPath}.tmp-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 })
  renameSync(tmp, authPath)
}

function genPassword(): string {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*-_=+?']
  const all = sets.join('')
  const buf = randomBytes(64)
  let i = 0
  const next = (): number => buf[i++ % buf.length]
  let out = ''
  for (const s of sets) out += s[next() % s.length]
  while (out.length < 20) out += all[next() % all.length]
  return out
}

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'passwd') {
  const auth = load()
  const pw = rest[0] && rest[0].length > 0 ? rest[0] : genPassword()
  if (pw.length < 8) {
    console.error('密码至少 8 位')
    process.exit(1)
  }
  const salt = randomBytes(16).toString('hex')
  auth.salt = salt
  auth.hash = scryptSync(pw, Buffer.from(salt, 'hex'), 64).toString('hex')
  // 轮换会话密钥：旧 cookie 全部失效
  auth.secret = randomBytes(32).toString('hex')
  save(auth)
  console.log(`已重置密码（用户名 ${auth.user}）。所有旧登录已失效，请用新密码重新登录。`)
  if (!rest[0]) console.log(`新密码：${pw}`)
} else if (cmd === 'user') {
  const auth = load()
  if (!rest[0]) {
    console.error('用法：ctl.cjs user <用户名>')
    process.exit(1)
  }
  auth.user = rest[0]
  save(auth)
  console.log(`用户名已改为 ${rest[0]}（旧登录的 cookie 仍有效——会话不以用户名为凭据）`)
} else if (cmd === 'info') {
  const auth = load()
  console.log(`凭据文件：${authPath}`)
  console.log(`用户名：${auth.user}`)
  console.log(`初始密码文件：${join(devaHome(), 'web-login.txt')}（存在则有初始密码；重置后应删除）`)
} else {
  console.log(`Deva Web 管理工具

用法：
  node out/web/ctl.cjs passwd [密码]   重置管理员密码（省略密码则随机生成并打印）
  node out/web/ctl.cjs user <用户名>   修改管理员用户名
  node out/web/ctl.cjs info            查看凭据信息（不含密码）
`)
}
