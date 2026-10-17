/**
 * Deva Web 构建脚本：产出 out/web/（可直接 `node out/web/index.cjs` 运行）。
 *
 * 两个构建面：
 *  1) 服务端   src/web-server/index.ts  ── esbuild ──► out/web/index.cjs
 *     关键：alias 把 'electron' → 本目录 electron-shim、'electron-updater' → stub，
 *     使 1.7 万行主进程服务零改动跑在纯 Node 里；dependencies external（node_modules 解析）。
 *     pty 宿主另出一份 out/web/pty-host.cjs（worker_threads 载入）+ pty-worker.cjs 引导。
 *  2) 前端    src/renderer-web/ ── Vite ──► out/web/renderer/（静态托管）
 *     复用桌面渲染层全部源码（@renderer 别名）、外加 web/ 桥接与启动闪屏。
 *
 * 运行：node scripts/build-web.mjs
 */
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'out', 'web')
const require_ = createRequire(import.meta.url)

// 构建产物依赖外置（node_modules 就近解析；hoisted 布局下从 apps/desktop 起向上都能找到）
const externalDeps = [
  'ws',
  'pngjs',
  'jpeg-js',
  '@lydell/node-pty',
  '@modelcontextprotocol/sdk',
  '@larksuiteoapi/node-sdk',
  'qrcode',
  'fflate',
  'electron-updater'
]

const shimPlugin = {
  name: 'deva-electron-shim',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({
      path: join(root, 'src', 'web-server', 'electron-shim.ts')
    }))
    b.onResolve({ filter: /^electron-updater$/ }, () => ({
      path: join(root, 'src', 'web-server', 'electron-updater-stub.ts')
    }))
  }
}

async function buildServer() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // 服务端入口（CJS：服务层大量用 __dirname / require 语义）
  await esbuild({
    entryPoints: [join(root, 'src', 'web-server', 'index.ts')],
    outfile: join(outDir, 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    plugins: [shimPlugin],
    external: externalDeps,
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    logLevel: 'info'
  })

  // pty 宿主（原样搬进产物目录；被 electron-shim 的 worker 引导 require）
  // 文件名必须与 terminal.ts 里 `join(__dirname, 'pty-host.js')` 一致
  await esbuild({
    entryPoints: [join(root, 'src', 'main', 'pty-host.ts')],
    outfile: join(outDir, 'pty-host.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    external: ['@lydell/node-pty'],
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    logLevel: 'info'
  })
  // 目标宿主模块路径写进 worker 引导：不同构建布局下文件名保持一致
  cpSync(join(root, 'src', 'web-server', 'pty-worker.cjs'), join(outDir, 'pty-worker.cjs'))

  // 管理工具 ctl（重置密码等）
  await esbuild({
    entryPoints: [join(root, 'src', 'web-server', 'ctl.ts')],
    outfile: join(outDir, 'ctl.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'error'
  })

  console.log('[build-web] 服务端完成 →', join(outDir, 'index.cjs'))
}

async function buildRenderer() {
  const rendererOut = join(outDir, 'renderer')
  await viteBuild({
    configFile: false,
    root: join(root, 'src', 'renderer-web'),
    base: '/',
    resolve: {
      alias: {
        '@renderer': join(root, 'src', 'renderer', 'src'),
        '@shared': join(root, 'src', 'shared')
      }
    },
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify('0.1.7')
    },
    build: {
      outDir: rendererOut,
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight']
          }
        }
      }
    },
    logLevel: 'info'
  })
  // —— 护栏：web 覆盖样式（mobile.css/web.css）必须排在 redesign.css 之后 ——
  // 打包 CSS 按模块求值顺序拼接，同优先级下后者胜；顺序反了手机端会退化成「压缩桌面端」。
  const assetsDir = join(rendererOut, 'assets')
  for (const f of readdirSync(assetsDir).filter((n) => n.endsWith('.css'))) {
    const css = readFileSync(join(assetsDir, f), 'utf8')
    const iMobile = css.indexOf('is-mobdrawer')
    const iDesktop = css.indexOf('.cf-body{position:relative')
    if (iMobile >= 0 && iDesktop >= 0 && iMobile < iDesktop) {
      throw new Error(
        `[build-web] CSS 顺序护栏未通过（${f}）：移动端覆盖样式排在桌面规则之前，手机端将退化为“压缩桌面端”。请检查 renderer-web/main.tsx 的 import 顺序。`
      )
    }
  }
  // —— theme-init.js 内容哈希化 ——
  // 移到 /assets/ 下走 immutable 长缓存（首屏同步脚本不再每次重新下载），并改写 index.html 引用。
  const themeSrc = join(rendererOut, 'theme-init.js')
  if (existsSync(themeSrc)) {
    const content = readFileSync(themeSrc, 'utf8')
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8)
    const hashed = `theme-init-${hash}.js`
    writeFileSync(join(assetsDir, hashed), content)
    rmSync(themeSrc)
    const idx = join(rendererOut, 'index.html')
    const html = readFileSync(idx, 'utf8').replace(/\/theme-init\.js/g, `/assets/${hashed}`)
    writeFileSync(idx, html)
    console.log(`[build-web] theme-init 哈希化 → assets/${hashed}`)
  }
  console.log('[build-web] 前端完成 →', rendererOut)
}

async function main() {
  const t0 = Date.now()
  await buildServer()
  await buildRenderer()
  console.log(`[build-web] 全部完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error('[build-web] 失败：', e)
  process.exit(1)
})
