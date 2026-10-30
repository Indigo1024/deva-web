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

/** 比较 x.y.z，忽略「-」之后的预发布后缀（同上游）；容忍 "web 1.2.0" 这类前缀。 */
function compareVersions(a: string, b: string): number {
  const clean = (s: string): string => s.replace(/^[a-z]+\s+/i, '').trim()
  const pa = clean(a).split('-')[0].split('.').map(Number)
  const pb = clean(b).split('-')[0].split('.').map(Number)
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

/**
 * 本地当前部署对应的 commit（HEAD）。
 *
 * 版本号比较有个盲区：远端有新提交但没升版本号时，光比数字永远是「已是最新」。
 * 拿 HEAD 与远端 commit 比一次，才能覆盖这种情况。
 * 读不到（非 git 部署、浅克隆）返回 null，退化成纯版本号比较。
 */
async function localCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot(),
      timeout: 10_000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
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

/** 读本地 Web 改版版本（web-version.json），读不到返回 null。 */
function localWebVersion(): string | null {
  try {
    const dir = __dirname
    for (const d of [dir, join(dir, '..', '..')]) {
      const p = join(d, 'web-version.json')
      if (existsSync(p)) {
        const o = JSON.parse(readFileSync(p, 'utf8')) as { webVersion?: string }
        return o.webVersion ?? null
      }
    }
  } catch {
    /* ignore */
  }
  return null
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
    const remoteWeb = await remoteWebVersion(sha)
    const current = app.getVersion()
    const currentWeb = localWebVersion()

    // 三个维度都要比：
    //  1. 上游版本（package.json）—— 合并了新上游
    //  2. Web 改版版本（web-version.json）—— 纯 Web 层更新，最常见
    //  3. commit —— 远端推了新提交但没升版本号，光比数字永远收不到更新
    const sourceNewer = compareVersions(version, current) > 0
    const webNewer = Boolean(remoteWeb && currentWeb && compareVersions(remoteWeb, currentWeb) > 0)
    const head = await localCommit()
    const commitNewer = Boolean(head && head !== sha)

    if (!sourceNewer && !webNewer && !commitNewer) {
      found = null
      setState({ phase: 'latest' })
      return
    }

    const release: UpdateRelease = {
      // 显示用版本号：上游有新版就显示上游版本；只有 Web 层更新时显示 Web 版本号；
      // 仅 commit 不同（版本号没动）时，用短 sha 标明是「有新代码」
      version: sourceNewer
        ? version
        : webNewer
          ? String(remoteWeb ?? version)
          : `构建 ${sha.slice(0, 7)}`,
      pageUrl: `https://github.com/${REPO}/commit/${sha}`
    }
    found = { release, mode: 'auto', target: sha }
    setState({
      phase: 'available',
      release,
      mode: 'auto',
      file: remoteWeb ? `web-${remoteWeb}` : null
    } as UpdateState)
  } catch (e) {
    setState({ phase: 'error', stage: 'check', message: errorText(e) })
  }
}

/**
 * 「下载」= 确认目标 commit 的源码能拿到。
 *
 * 两种部署都要支持：
 *  - **git 部署**（clone 下来的）：`git fetch` 把 commit 取到本地对象库；
 *  - **非 git 部署**（下载 zip 解压、或 git 目录被删）：走 GitHub tarball 下载到
 *    `.deva-update-build/`，install 阶段直接用这份，不再依赖 git archive。
 *
 * 判断依据是仓库根目录有没有 `.git`。
 */
async function download(): Promise<void> {
  if (!found || state.phase === 'downloading' || state.phase === 'downloaded') return
  const { release, target } = found
  setState({ phase: 'downloading', release, percent: 0 })
  const root = repoRoot()
  const hasGit = existsSync(join(root, '.git'))

  if (!hasGit) {
    // 非 git 部署：直接下 tarball，解到 build 目录
    try {
      const buildDir = join(root, '.deva-update-build')
      rmSync(buildDir, { recursive: true, force: true })
      mkdirSync(buildDir, { recursive: true })
      setState({ phase: 'downloading', release, percent: 20 })
      const url = `https://codeload.github.com/${REPO}/tar.gz/${target}`
      const res = await fetch(url, {
        headers: { 'user-agent': 'deva-web' },
        signal: AbortSignal.timeout(180_000)
      })
      if (!res.ok) throw new Error(`下载源码包失败：HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      setState({ phase: 'downloading', release, percent: 70 })
      const tarPath = join(buildDir, 'src.tar.gz')
      writeFileSync(tarPath, buf)
      // --strip-components=1 去掉 github 打的顶层目录名
      await execFileAsync('tar', ['-xzf', tarPath, '-C', buildDir, '--strip-components=1'], {
        timeout: 180_000
      })
      rmSync(tarPath, { force: true })
      if (!existsSync(join(buildDir, 'apps', 'desktop', 'package.json'))) {
        throw new Error('源码包解压后结构不对（缺 apps/desktop/package.json）')
      }
      setState({ phase: 'downloading', release, percent: 100 })
      setState({ phase: 'downloaded', release })
    } catch (e) {
      setState({ phase: 'error', stage: 'download', message: errorText(e), release })
    }
    return
  }

  try {
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

    // 记录当前 HEAD，后面判断工作区是否需要对齐
    const headAt = (await localCommit()) ?? ''

    // 1. 导出目标 commit 的源码树（不改工作区）
    //
    // git 部署走 git archive；非 git 部署的 download 阶段已经下好 tarball 解在 buildDir，
    // 直接复用，不再重复下载。
    const buildDirHasSrc = existsSync(join(buildDir, 'apps', 'desktop', 'package.json'))
    if (buildDirHasSrc) {
      log('复用已下载的源码包')
    } else {
      log('导出源码…')
      await execFileAsync(
        'bash',
        ['-lc', `git archive ${JSON.stringify(target)} | tar -x -C ${JSON.stringify(buildDir)}`],
        { cwd: root, timeout: 180_000 }
      )
    }

    // 非 git 部署没有 HEAD 可比，headAt 留空即可（reset 那段会跳过）
    const canReset = existsSync(join(root, '.git'))

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

    // 5.5 工作区快进到目标 commit。
    //
    // 产物已经换成新的了，但工作区 HEAD 还停在旧 commit —— 那样 `check()` 里的
    // commit 比对会永远判定「有更新」，用户会反复看到更新提示。这里把 HEAD 对齐。
    // 用 reset --hard 而不是 pull：目标是确定的那个 commit，不该被本地改动干扰；
    // 失败不阻塞更新（产物已经好了），只记日志。
    if (canReset && headAt && headAt !== target) {
      try {
        log(`工作区对齐到 ${target.slice(0, 8)}…`)
        await execFileAsync('git', ['reset', '--hard', target], { cwd: root, timeout: 60_000 })
        log('工作区已对齐')
      } catch (e) {
        log(`工作区对齐失败（不影响已部署的产物）：${errorText(e)}`)
      }
    }

    rmSync(buildDir, { recursive: true, force: true })

    log('=== 构建完成，重启服务 ===')
    setState({ phase: 'downloaded', release })

    // 6. 重启：优先用 systemd（能自愈、有日志），失败则进程自我替换。
    //
    // 早期版本这里写死 `systemctl restart deva-web`，在非 systemd 部署（直接
    // `node out/web/index.cjs`、docker、其他服务名）上一律失败，而失败又被 catch
    // 吞掉 —— 前端显示更新成功，实际进程没重启，用户看到的是旧界面。
    //
    // 现在按顺序试，每一步失败都记日志，最后一定落到「自我替换」这条保底路径。
    await restartSelf(log)
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

/**
 * 重启自身，兼容各种部署方式。
 *
 * 顺序：
 *  1. `DEVA_WEB_RESTART_CMD`（自定义命令，含管道时走 shell）—— 部署方能精确指定
 *  2. `DEVA_WEB_SERVICE` 指定 / 自动探测到的 systemd 单元 —— `systemctl restart <unit>`
 *  3. **进程自我替换 `execve`** —— 任何部署方式都能用，保底
 *
 * 自我替换的前提：进程由 `node out/web/index.cjs` 直接拉起，且当前环境变量就是启动时的
 * 那一套（systemd 部署下由 Restart=always 兜底，用不到这一步）。
 * 用 execve 而不是 spawn 新进程，是为了不留孤儿进程、端口也能立刻释放。
 */
async function restartSelf(log: (s: string) => void): Promise<void> {
  const run = async (cmd: string, args: string[], useShell = false): Promise<boolean> => {
    try {
      if (useShell) {
        await execFileAsync('bash', ['-lc', cmd], { timeout: 60_000 })
      } else {
        await execFileAsync(cmd, args, { timeout: 60_000 })
      }
      return true
    } catch (e) {
      log(`重启命令失败（${cmd} ${args.join(' ')}）：${errorText(e)}`)
      return false
    }
  }

  /**
   * 静默执行：只回布尔，不把「被自己杀掉」当成错误记日志。
   * systemctl restart 杀掉本进程时命令会以非零退出，那是正常现象。
   */
  const runQuiet = async (cmd: string, args: string[]): Promise<boolean> => {
    try {
      await execFileAsync(cmd, args, { timeout: 60_000 })
      return true
    } catch {
      return false
    }
  }

  // 1. 部署方自定义
  const custom = process.env.DEVA_WEB_RESTART_CMD?.trim()
  if (custom) {
    log(`用自定义重启命令：${custom}`)
    if (await run(custom, [], true)) return
  }

  // 2. systemd：显式指定的单元名，或探测到的、本进程确实是 MainPID 的单元
  const unit = process.env.DEVA_WEB_SERVICE?.trim() || detectSystemdUnit()
  if (unit) {
    log(`用 systemd 重启：${unit}`)
    // systemctl restart 会先杀掉本进程（我们就是那个进程），所以这条命令几乎必然
    // 以「失败」返回 —— 但重启其实已经发生了。不能据此判定失败，否则会再走一次
    // 自我替换，凭空多起一个进程抢同一个端口。
    // 正确做法：发出请求后只等片刻；如果自己还活着，说明 systemd 没接管（单元名
    // 不对、没有权限等），这时才回退到自我替换。
    const started = await runQuiet('systemctl', ['restart', unit])
    await new Promise((r) => setTimeout(r, 3000))
    if (!started) {
      // 命令返回失败，但我们已被杀 → 进程已经不在这里了，不会走到这行
      log(`systemctl 返回失败，但本进程仍在运行 → 该单元未接管，改用自我替换`)
    } else {
      log(`已请求 systemd 重启 ${unit}`)
      return
    }
  } else {
    log('未探测到 systemd 单元（或本进程不是该单元的主进程），改用进程自我替换')
  }

  // 3. 保底：进程自我替换（spawn 新进程 + 本进程退出）
  //
  // 时序很关键：新进程要 bind 同一个端口，必须先让旧进程释放端口。
  // 但反过来先退出又没人拉起新进程。做法是「先 spawn（它 bind 会失败几次重试），
  // 本进程随即退出释放端口」——所以新进程必须允许端口被占时重试。
  log('执行进程自我替换…')
  try {
    const { spawn } = await import('node:child_process')
    const args = process.argv.slice(1)
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      // 告诉新进程：端口可能被上一任占着，等它退出再 bind
      env: { ...process.env, DEVA_WEB_RESTARTING: String(Date.now()) }
    })
    child.unref()
    log(`已拉起新进程 pid=${child.pid}，本进程退出以释放端口`)
    // 给 spawn 一点时间完成 fork，再退出
    setTimeout(() => {
      try {
        process.exit(0)
      } catch {
        process.kill(process.pid, 'SIGKILL')
      }
    }, 500)
  } catch (e) {
    log(`自我替换失败：${errorText(e)}`)
    throw new Error('无法重启服务，请手动重启')
  }
}

/**
 * 探测当前进程是否真的由某个 systemd 单元直接拉起。
 *
 * 不能只读 cgroup 就算数：进程常常是「从别的服务里 fork 出来」的（比如在某个
 * systemd 服务的 shell 里手动 `node index.cjs`），那时 cgroup 显示的是**父进程**
 * 的单元。早期版本据此去 `systemctl restart` 那个单元，等于重启了毫不相干的服务
 * —— 自己的进程却没动，用户看到界面还是旧的。
 *
 * 判定条件两条同时满足才算数：
 *  1. cgroup 指向某个 .service；
 *  2. 该单元的 MainPID 就是本进程。
 */
function detectSystemdUnit(): string | null {
  let unit: string | null = null
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8')
    const m = cgroup.match(/\/system\.slice\/(?:system-)?([^/\n]+\.service)/)
    if (m) unit = m[1]
  } catch {
    return null
  }
  if (!unit) return null

  // 确认本进程就是这个单元的主进程；否则说明只是被它 fork 出来的子进程
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', unit], {
      timeout: 5_000,
      encoding: 'utf8'
    }).trim()
    if (Number(out) === process.pid) return unit
  } catch {
    /* systemctl 不可用或查询失败 → 当探测不到处理 */
  }
  return null
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
