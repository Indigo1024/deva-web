/**
 * Web 版在线更新。
 *
 * 上游 updater.ts 是给 Electron 客户端用的：查 GitHub Releases → 下载 exe/dmg/AppImage →
 * 交给 electron-updater 覆盖安装。Web 版没有「安装包」，服务端就是源码 + 构建产物，
 * 所以这里的「安装」是：拉取改版仓库最新代码 → 重新构建 → 重启本服务。
 *
 * 与上游对齐：状态机形状一致（idle/checking/latest/available/downloading/downloaded/error），
 * 版本比较、GitHub API 查询照抄上游，前端 UpdateSection 基本可以复用。
 *
 * 与上游不同：
 *  - 数据源是**本改版仓库**（默认 Indigo1024/deva-web），不是上游 Deva 的 Releases；
 *  - 「下载」= git fetch + 确认目标 commit 可用；
 *  - 「安装」= 导出该 commit 源码 → 复用现有 node_modules 构建 → 备份旧产物 → 切换 → 重启。
 *
 * 安全边界：这是**能在服务器上执行构建和重启**的操作，等价于代码执行权。
 *  - 只允许已登录用户触发（走 IPC，天然在认证墙后）；
 *  - 只从固定仓库拉取；
 *  - 构建失败不切换产物，线上保持旧版可用。
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateMode, UpdateRelease, UpdateState } from '../shared/update'

const execFileAsync = promisify(execFile)

/** 构建期注入的本改版仓库地址（scripts/build-web.mjs 的 __WEB_REPO__）。 */
declare const __WEB_REPO__: string | undefined

/** 从仓库 URL 解析 owner/name，供 GitHub API 用。 */
function parseRepo(url: string): string {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  return m ? `${m[1]}/${m[2]}` : 'Indigo1024/deva-web'
}

const REPO_URL =
  process.env.DEVA_WEB_UPDATE_REPO?.trim() ||
  (typeof __WEB_REPO__ === 'string' ? __WEB_REPO__ : 'https://github.com/Indigo1024/deva-web')
const REPO = parseRepo(REPO_URL)
const BRANCH = process.env.DEVA_WEB_UPDATE_BRANCH?.trim() || 'main'
const API = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`

/** 仓库根目录：构建产物在 apps/desktop/out/web，往上四级。 */
function repoRoot(): string {
  const fromOut = resolve(__dirname, '..', '..', '..', '..')
  if (existsSync(join(fromOut, '.git'))) return fromOut
  const cwd = process.cwd()
  if (existsSync(join(cwd, '..', '..', '.git'))) return resolve(cwd, '..', '..')
  return fromOut
}

let getWindow: () => BrowserWindow | null = () => null
let state: UpdateState = { phase: 'idle' }
let found: { release: UpdateRelease; mode: UpdateMode; target: string } | null = null

function setState(next: UpdateState): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const s = String((e as { stderr?: unknown }).stderr ?? '').trim()
    if (s) return s.split('\n').slice(-4).join('\n')
  }
  return e instanceof Error ? e.message : String(e)
}

/** 比较 x.y.z，忽略「-」之后的预发布后缀（同上游）。 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/**
 * 找出指向改版仓库的 git remote 名。
 * 部署约定 `web` = 改版仓库、`origin` = 上游；自建部署可能改名，按 URL 里是否含仓库名判断。
 */
async function resolveWebRemote(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd: root, timeout: 10_000 })
    const repoName = REPO.split('/')[1] ?? 'deva-web'
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)/)
      if (m && m[2].includes(repoName)) return m[1]
    }
  } catch {
    /* 读不到就用默认 */
  }
  return 'web'
}

/** 读远端仓库该 commit 的 package.json 版本（走 raw，不 clone）。 */
async function remoteVersion(sha: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/apps/desktop/package.json`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`读取远端 package.json 失败：HTTP ${res.status}`)
  const data = (await res.json()) as { version?: string }
  if (!data.version) throw new Error('远端 package.json 缺少 version 字段')
  return data.version
}

/** 读远端该 commit 的 web-version.json（Web 层自身版本），没有则 null。 */
async function remoteWebVersion(sha: string): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${REPO}/${sha}/apps/desktop/web-version.json`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data = (await res.json()) as { webVersion?: string }
    return data.webVersion ?? null
  } catch {
    return null
  }
}

async function check(): Promise<void> {
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'downloaded')
    return
  setState({ phase: 'checking' })
  try {
    const res = await fetch(API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'deva-web' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
    const data = (await res.json()) as { sha: string }
    const sha = data.sha
    const version = await remoteVersion(sha)
    const current = app.getVersion()
    if (compareVersions(version, current) <= 0) {
      found = null
      setState({ phase: 'latest' })
      return
    }
    const webVersion = await remoteWebVersion(sha)
    const release: UpdateRelease = {
      version,
      pageUrl: `https://github.com/${REPO}/commit/${sha}`
    }
    found = { release, mode: 'auto', target: sha }
    // file 字段借用一下：有 web-version 时带上，前端可显示「含 Web 层 x.y.z」
    setState({
      phase: 'available',
      release,
      mode: 'auto',
      file: webVersion ? `web-${webVersion}` : null
    } as UpdateState)
  } catch (e) {
    setState({ phase: 'error', stage: 'check', message: errorText(e) })
  }
}

/** 「下载」= 把目标 commit 取到本地并确认可检出（真正构建留到 install）。 */
async function download(): Promise<void> {
  if (!found || state.phase === 'downloading' || state.phase === 'downloaded') return
  const { release, target } = found
  setState({ phase: 'downloading', release, percent: 0 })
  try {
    const root = repoRoot()
    const remote = await resolveWebRemote(root)
    setState({ phase: 'downloading', release, percent: 10 })
    await execFileAsync('git', ['fetch', '--quiet', remote, BRANCH], {
      cwd: root,
      timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    setState({ phase: 'downloading', release, percent: 60 })
    await execFileAsync('git', ['cat-file', '-e', `${target}^{commit}`], {
      cwd: root,
      timeout: 15_000
    })
    setState({ phase: 'downloading', release, percent: 100 })
    setState({ phase: 'downloaded', release })
  } catch (e) {
    setState({ phase: 'error', stage: 'download', message: errorText(e), release })
  }
}

/** 更新日志：安装过程写这里，前端 / `/api/update-log` 可查看。 */
function logPath(): string {
  const home = process.env.DEVA_HOME?.trim() || join(process.env.HOME || '/root', '.deva')
  return join(home, 'web-update.log')
}

function appendLog(line: string): void {
  try {
    const p = logPath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' })
  } catch {
    /* 日志写不了不影响主流程 */
  }
}

/** 递归找某个目录下最近的 node_modules（构建脚本需要能 require 到依赖）。 */
function findNodeModules(start: string): string | null {
  let dir = start
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'node_modules')
    if (existsSync(cand)) return cand
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 「安装」= 服务器上构建新版本 → 备份旧产物 → 切换 → 重启。
 *
 * 关键设计：
 *  - **先构建，再切换**：构建失败时线上产物一个字节都不动，旧版继续可用。
 *  - **不改工作区**：用 `git archive` 把目标 commit 导出到 `.deva-update-build/`，
 *    在那里构建，工作区里的本地改动完全不受影响。
 *  - **复用 node_modules**：软链过去，避免每次更新都重新装几百兆依赖。
 *  - 切换前把旧 out/web 重命名备份（web.bak.<时间戳>），只留最近 2 份。
 *  - 最后 `systemctl restart deva-web`；当前进程被杀，新进程由 systemd 拉起。
 */
async function install(): Promise<void> {
  if (state.phase !== 'downloaded' || !found) return
  const { release, target } = found
  const root = repoRoot()
  const buildDir = join(root, '.deva-update-build')
  const log = (s: string): void => appendLog(s)

  try {
    log(`=== 开始更新到 ${release.version} (${target.slice(0, 8)}) ===`)
    rmSync(buildDir, { recursive: true, force: true })
    mkdirSync(buildDir, { recursive: true })

    // 1. 导出目标 commit 的源码树（不动工作区）
    log('导出源码…')
    await execFileAsync(
      'bash',
      ['-lc', `git archive ${JSON.stringify(target)} | tar -x -C ${JSON.stringify(buildDir)}`],
      { cwd: root, timeout: 180_000 }
    )

    // 2. 依赖：默认复用仓库里的 node_modules；package.json 变了才重新装
    const newPkgPath = join(buildDir, 'apps', 'desktop', 'package.json')
    const curPkgPath = join(root, 'apps', 'desktop', 'package.json')
    const readJson = (p: string): Record<string, unknown> => {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    const depKey = (o: Record<string, unknown>): string =>
      JSON.stringify([o.dependencies ?? {}, o.devDependencies ?? {}])
    const depsChanged =
      existsSync(newPkgPath) && depKey(readJson(newPkgPath)) !== depKey(readJson(curPkgPath))

    if (depsChanged) {
      log('依赖有变化，安装中（可能需要几分钟）…')
      await execFileAsync('pnpm', ['install', '--filter', '@deva/desktop'], {
        cwd: buildDir,
        timeout: 900_000,
        env: { ...process.env, CI: '1' }
      })
    } else {
      log('依赖无变化，复用现有 node_modules')
      // 构建脚本在 buildDir/apps/desktop 下跑，依赖从 buildDir/node_modules 解析
      const nm = findNodeModules(root)
      if (nm) {
        await execFileAsync('ln', ['-s', nm, join(buildDir, 'node_modules')], {
          timeout: 10_000
        }).catch(() => {})
      }
      const subNm = join(root, 'apps', 'desktop', 'node_modules')
      if (existsSync(subNm)) {
        await execFileAsync('ln', ['-s', subNm, join(buildDir, 'apps', 'desktop', 'node_modules')], {
          timeout: 10_000
        }).catch(() => {})
      }
    }

    // 3. 生成桥接 + 构建
    log('生成 window.deva 桥接…')
    await execFileAsync('node', ['scripts/gen-web-api.mjs'], {
      cwd: join(buildDir, 'apps', 'desktop'),
      timeout: 180_000
    })
    log('构建中（约 10–90 秒）…')
    await execFileAsync('node', ['scripts/build-web.mjs'], {
      cwd: join(buildDir, 'apps', 'desktop'),
      timeout: 1_200_000,
      env: { ...process.env, NODE_ENV: 'production' }
    })

    // 4. 校验产物
    const newOut = join(buildDir, 'apps', 'desktop', 'out', 'web')
    if (
      !existsSync(join(newOut, 'index.cjs')) ||
      !existsSync(join(newOut, 'renderer', 'index.html'))
    ) {
      throw new Error('构建完成但产物不完整（缺 index.cjs 或 renderer/index.html）')
    }

    // 5. 切换：旧产物改名备份 → 新产物就位
    const liveOut = join(root, 'apps', 'desktop', 'out', 'web')
    const backupOut = join(root, 'apps', 'desktop', 'out', `web.bak.${Date.now()}`)
    log('切换产物…')
    if (existsSync(liveOut)) renameSync(liveOut, backupOut)
    try {
      renameSync(newOut, liveOut)
    } catch (e) {
      if (existsSync(backupOut) && !existsSync(liveOut)) renameSync(backupOut, liveOut)
      throw e
    }
    log(`旧产物备份于 ${backupOut}`)

    // 只留最近 2 份备份
    try {
      const outRoot = join(root, 'apps', 'desktop', 'out')
      const baks = readdirSync(outRoot)
        .filter((n) => n.startsWith('web.bak.'))
        .sort()
      while (baks.length > 2) {
        const old = baks.shift()
        if (old) rmSync(join(outRoot, old), { recursive: true, force: true })
      }
    } catch {
      /* 清理失败无妨 */
    }

    // 6. 记录待重启标记
    writeFileSync(
      join(root, '.deva-update-pending.json'),
      JSON.stringify({ version: release.version, target, at: Date.now() })
    )
    rmSync(buildDir, { recursive: true, force: true })

    log('=== 构建完成，重启服务 ===')
    setState({ phase: 'downloaded', release })
    await execFileAsync('systemctl', ['restart', 'deva-web'], { timeout: 30_000 }).catch((e) => {
      log(`systemctl restart 返回：${errorText(e)}（进程可能已被重启，属正常）`)
    })
  } catch (e) {
    log(`=== 更新失败：${errorText(e)} ===`)
    // 回滚：构建失败时线上产物没动过；只有「旧产物已改名、新产物未就位」才需要还原
    try {
      const outRoot = join(root, 'apps', 'desktop', 'out')
      const live = join(outRoot, 'web')
      if (!existsSync(live) && existsSync(outRoot)) {
        const bak = readdirSync(outRoot)
          .filter((n) => n.startsWith('web.bak.'))
          .sort()
          .pop()
        if (bak) {
          renameSync(join(outRoot, bak), live)
          log(`已回滚到 ${bak}`)
        }
      }
    } catch (re) {
      log(`回滚失败：${errorText(re)}`)
    }
    try {
      rmSync(buildDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    setState({ phase: 'error', stage: 'download', message: errorText(e), release })
  }
}

export function registerWebUpdaterIpc(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
  ipcMain.handle('update:get-state', (): UpdateState => state)
  ipcMain.handle('update:check', () => check())
  ipcMain.handle('update:download', () => download())
  ipcMain.handle('update:install', () => install())
}

/** 供 HTTP 端点读取安装日志。 */
export function readUpdateLog(): string {
  try {
    return readFileSync(logPath(), 'utf8')
  } catch {
    return ''
  }
}
