/**
 * 从 src/preload/index.ts 生成浏览器端 window.deva 桥接（deva-api.gen.ts）。
 *
 * preload 的 api 对象是「白名单 + 类型」的唯一定义处（1209 行、175 个通道）。
 * 浏览器端不重写一遍，而是机械变换：
 *   1. `import { contextBridge, ipcRenderer } from 'electron'` → `import { webIpc as ipcRenderer } from './web-ipc'`
 *   2. 共享类型的相对路径 '../shared/…' → '../../../shared/…'（目录变了）
 *   3. `platform: process.platform` → `platform: 'web'`
 *   4. 末尾 contextBridge 暴露块 → `export const devaApi = api`
 *
 * 运行：node scripts/gen-web-api.mjs
 * 生成产物已提交（deva-api.gen.ts），preload 变更后重跑本脚本即可。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = join(root, 'src', 'preload', 'index.ts')
const dst = join(root, 'src', 'renderer', 'src', 'web', 'deva-api.gen.ts')

let code = readFileSync(src, 'utf8')

const ELECTRON_IMPORT = "import { contextBridge, ipcRenderer } from 'electron'"
if (!code.includes(ELECTRON_IMPORT)) {
  console.error('preload 结构变了：找不到 electron import，请更新生成脚本')
  process.exit(1)
}
code = code.replace(
  ELECTRON_IMPORT,
  [
    '/* eslint-disable */',
    '// 本文件由 scripts/gen-web-api.mjs 从 src/preload/index.ts 自动生成——勿手改。',
    "import { webIpc as ipcRenderer } from './web-ipc'"
  ].join('\n')
)

// 共享类型相对路径加深一层
code = code.replaceAll("from '../shared/", "from '../../../shared/")

// 浏览器平台标识：渲染层据此隐藏 win32/mac 专属 UI
code = code.replace('platform: process.platform,', "platform: 'web' as const,")

// 末尾暴露块 → 导出
const TAIL_MARK = 'if (process.contextIsolated) {'
const tailIdx = code.indexOf(TAIL_MARK)
if (tailIdx < 0) {
  console.error('preload 结构变了：找不到 contextBridge 暴露块，请更新生成脚本')
  process.exit(1)
}
code = code.slice(0, tailIdx) + 'export const devaApi = api\nexport type DevaApi = typeof api\n'

writeFileSync(dst, code, 'utf8')
console.log(`生成完成：${dst}（${code.length} 字节）`)
