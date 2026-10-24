import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import type { ContentPart } from '../providers/types'
import { prepareImage, sniffImageMime, formatBytes } from './image-read'

/**
 * 附加文件服务（主进程）。
 * 用户经原生选择框「亲手挑选」的文件才可读取——与项目根守卫（fs-guard）不同：
 * 附件常在项目目录之外（桌面的 PDF、文档里的图片），因此不走 assertInside，
 * 改用「本会话白名单」闸门：只有刚被 pick 选中且体积/类型合规的绝对路径才允许后续读取，
 * 防止渲染层伪造任意路径读盘。大文件 base64 只在主进程内产生，绝不回传渲染层。
 */

export type AttachmentKind = 'image' | 'document' | 'text' | 'archive' | 'unsupported'

export interface PickedAttachment {
  path: string
  name: string
  ext: string
  size: number
  kind: AttachmentKind
  /** 类型受支持且体积合规，可发给模型 */
  supported: boolean
  /** 不受支持时的原因（展示用） */
  reason?: string
}

/** 文本类附件注入模型时的前缀标记（供历史重建识别为「附件」而非提问正文）。 */
export const ATTACH_TEXT_PREFIX = '[附件文件] '

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

// 可作为纯文本注入的扩展名（代码 / 配置 / 文档源）。
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php',
  '.swift', '.m', '.mm', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.gradle', '.properties',
  '.env', '.r', '.dart', '.lua', '.pl', '.dockerfile', '.makefile', '.cmake'
])

/**
 * 压缩包：模型 API 不能直接吃二进制，这里解包后按文本读取（目录清单 + 文本文件内容）。
 * 只读文本类成员，跳过图片/二进制，避免把上下文撑爆。
 */
const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.tar.gz', '.bz2', '.xz', '.7z'])

/** 解包时最多读多少个文本成员、总共多少字节。 */
const MAX_ARCHIVE_MEMBERS = 60
const MAX_ARCHIVE_TEXT = 512 * 1024

/**
 * 附件策略：**接收不设限，发送时自适应**。
 *
 * 用户选中 / 粘贴什么就收什么，不在「添加」这一步拒绝——那会让用户觉得功能坏了。
 * 真正的约束放在发送时（buildAttachmentPart）按模型能力整形：
 *  - 图片：任意大小 → prepareImage 缩放/转码到 API 上限（3.75MB / 长边 1568）
 *  - PDF：超过 API 上限的部分无法发送，会明确告知
 *  - 文本：超长按预算截断并标注「已截断」
 *  - 压缩包：任意大小 → 解包抽取文本成员，总量限流
 *  - 未知二进制：不发送内容，给文件名/类型/大小，让模型知道有这么个文件
 *
 * 这里只保留一个「发送时」的软上限用于预算计算，不再用于拒绝。
 */
const MAX_PDF = 20 * 1024 * 1024 // PDF 发送上限（API 侧限制）
const MAX_TEXT = 512 * 1024 // 单个文本文件注入上限

/** 字节数转成「N MB」用于提示文案。 */
function formatMb(n: number): string {
  return `${Math.round(n / 1024 / 1024)}MB`
}

function classify(ext: string): AttachmentKind {
  const e = ext.toLowerCase()
  if (e in IMAGE_MIME) return 'image'
  if (e === '.pdf') return 'document'
  if (ARCHIVE_EXT.has(e)) return 'archive'
  if (TEXT_EXT.has(e)) return 'text'
  return 'unsupported'
}

// 本会话内被用户明确选中且合规的绝对路径白名单。
const allowed = new Set<string>()

/**
 * 粘贴附件的落盘目录。粘贴来的只有字节、没有路径（截图尤其如此），故由主进程写到这里再走同一套
 * 白名单——渲染层只交内容、从不交路径，「不能伪造任意路径读盘」的不变式不变。
 * 白名单是内存态、随重启清空，上次运行留下的文件已无用：注册 IPC 时整目录清掉。
 * 发送时内容即转成 base64 块进历史，文件只需活到发送前。
 */
const PASTE_DIR = join(tmpdir(), 'deva-paste')

/**
 * 粘贴去重：同一内容（sha256）重复粘贴返回同一条附件（同一路径），渲染层按路径过滤即只留一份。
 * 过大不读字节的，按「文件名 + 体积」认同一个。随进程存活，与白名单同寿命。
 */
const pasted = new Map<string, PickedAttachment>()

/**
 * 登记一个附件。
 *
 * **不在这里拒绝任何文件**——用户加进来什么就收什么，`supported` 恒为 true。
 * 类型和体积的处理全部推到发送时（buildAttachmentPart）按模型能力决定：
 * 图片压缩、文本截断、压缩包抽取、二进制给元信息。
 *
 * 这样「添加附件」这个动作永远成功，不会出现「点了没反应 / 提示太大」的挫败感；
 * 真发不出去的内容会在发送时以说明文字的形式告诉模型和用户。
 */
function inspect(abs: string, size: number): PickedAttachment {
  const name = basename(abs)
  const ext = extname(abs).toLowerCase()
  const kind = classify(ext)
  // 所有文件都登记进白名单（后续读取需要），包括未知类型
  allowed.add(abs)
  return { path: abs, name, ext, size, kind, supported: true }
}

/** 粘贴文件名：剥掉路径与 Windows 非法字符；截图等无名/通用名（image.png）按时间戳重命名。 */
function pasteName(raw: string, mime: string): string {
  const clean = basename(raw || '').replace(/[<>:"/|?*\x00-\x1f]/g, '_').trim()
  // 「.」「..」会让 join 退回上级目录：与无名同样处理。
  if (clean && !/^\.+$/.test(clean) && !/^image\.\w+$/i.test(clean)) return clean
  const ext = extname(clean) || (mime.startsWith('image/') ? `.${mime.slice(6).replace('jpeg', 'jpg')}` : '')
  // 本地时间（toISOString 是 UTC，文件名里的时刻会与用户所见差时区）。
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  return `粘贴-${ts}${ext}`
}

export function registerAttachmentsIpc(getWindow: () => BrowserWindow | null): void {
  void fs.rm(PASTE_DIR, { recursive: true, force: true }).catch(() => {})

  // 粘贴（截图 / 资源管理器里复制的文件）：渲染层交文件名 + 字节，超 PDF 上限的大文件渲染层不读、
  // 只交体积（data=null），由此处统一给出「过大」判定，免得几百 MB 过一遍 IPC。
  /**
   * 登记一个粘贴/上传的附件。
   *
   * 两种模式：
   *  - 内联字节（小文件）：`{name, mime, size, data: Uint8Array}`，落盘到 PASTE_DIR
   *  - 服务端已有文件（大文件分片上传后）：`{name, mime, size, serverPath}`，
   *    文件已由 /api/upload-chunk 写到磁盘，这里只登记白名单，不再复制。
   *
   * 大文件走第二种：HTTP 分片上传有原生进度、不受 WS 帧大小与超时限制。
   */
  ipcMain.handle(
    'fs:paste-attachment',
    async (
      _e,
      file: {
        name: string
        mime: string
        size: number
        data?: Uint8Array | null
        serverPath?: string
      }
    ): Promise<PickedAttachment> => {
      // 服务端已有文件：校验存在 + 大小，直接登记
      if (file.serverPath) {
        const abs = resolve(file.serverPath)
        let size = file.size
        try {
          size = (await fs.stat(abs)).size
        } catch {
          throw new Error('上传的文件不存在')
        }
        return inspect(abs, size)
      }
      const key = file.data
        ? createHash('sha256').update(file.data).digest('hex')
        : `big:${file.name}:${file.size}`
      const hit = pasted.get(key)
      if (hit) return hit
      const name = pasteName(file.name, file.mime || '')
      // 每份内容独占一个子目录：不同内容的同名文件（如两张 image.png）互不覆盖，名字仍保持原样展示。
      const abs = join(PASTE_DIR, randomUUID(), name)
      const pre = inspect(abs, file.data ? file.data.byteLength : file.size)
      // 先登记再落盘：同一批里的重复项（并发调用）也拿到同一条。
      pasted.set(key, pre)
      if (!file.data || !pre.supported) return pre
      try {
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, file.data)
      } catch (err) {
        pasted.delete(key)
        allowed.delete(abs)
        throw err
      }
      return pre
    }
  )

  ipcMain.handle('fs:pick-attachments', async (): Promise<PickedAttachment[]> => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择附加文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的文件',
          extensions: [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf',
            'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'csv', 'log',
            'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'html', 'css', 'scss', 'xml',
            'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql',
            'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z'
          ]
        },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: '压缩包', extensions: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled) return []

    const out: PickedAttachment[] = []
    for (const p of res.filePaths) {
      const abs = resolve(p)
      let size = 0
      try {
        size = (await fs.stat(abs)).size
      } catch {
        /* stat 失败：按 0 处理，读取阶段再兜底 */
      }
      out.push(inspect(abs, size))
    }
    return out
  })
}

/**
 * 把压缩包读成可注入模型的文本：目录清单 + 各文本成员内容。
 *
 * 模型 API 只吃文本/图片/PDF，二进制压缩包没法直接发。这里解包后：
 *  - 先列目录清单（含大小），让模型知道包里有什么；
 *  - 再挑文本类成员贴内容，总量受 MAX_ARCHIVE_TEXT 限制；
 *  - 图片等二进制成员只列名不贴内容。
 *
 * zip 用 fflate（已有依赖）在内存解；tar 系解到临时目录再读。
 */
async function readArchiveAsText(abs: string): Promise<string> {
  const lower = abs.toLowerCase()
  const lines: string[] = []
  /** 统一成「相对路径 + 大小 + 可选文本内容」。 */
  const files: Array<{ path: string; size: number; text?: string }> = []

  if (lower.endsWith('.zip')) {
    const { unzipSync } = await import('fflate')
    const buf = await fs.readFile(abs)
    const entries = unzipSync(new Uint8Array(buf))
    for (const [p, data] of Object.entries(entries)) {
      if (p.endsWith('/')) continue
      const e = extname(p).toLowerCase()
      const isText = TEXT_EXT.has(e) && data.length <= MAX_TEXT
      files.push({
        path: p,
        size: data.length,
        text: isText ? Buffer.from(data).toString('utf8') : undefined
      })
    }
  } else {
    // 7z 需要 p7zip，多数机器没装；直接给出可读提示，别让用户以为文件坏了
    if (lower.endsWith('.7z')) {
      throw new Error('暂不支持 7z，请解压后上传其中的文件（或改传 zip/tar.gz）')
    }
    // tar / tar.gz / tgz / bz2 / xz：交给系统 tar
    const tmp = join(tmpdir(), `deva-archive-${randomUUID()}`)
    await fs.mkdir(tmp, { recursive: true })
    try {
      await new Promise<void>((resolvePromise, reject) => {
        execFile('tar', ['-xf', abs, '-C', tmp], { timeout: 60_000 }, (err) =>
          err ? reject(new Error(`解压失败：${err.message}`)) : resolvePromise()
        )
      })
      const walk = async (dir: string, prefix = ''): Promise<void> => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          const full = join(dir, e.name)
          if (e.isDirectory()) {
            await walk(full, rel)
            continue
          }
          const st = await fs.stat(full)
          const fe = extname(rel).toLowerCase()
          let text: string | undefined
          if (TEXT_EXT.has(fe) && st.size <= MAX_TEXT) {
            text = await fs.readFile(full, 'utf8').catch(() => undefined)
          }
          files.push({ path: rel, size: st.size, text })
        }
      }
      await walk(tmp)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  const total = files.reduce((s, f) => s + f.size, 0)
  lines.push(`共 ${files.length} 个文件，解压后约 ${(total / 1024).toFixed(1)} KB`)
  lines.push('', '目录：')
  for (const f of files.slice(0, 200)) lines.push(`  ${f.path}  (${f.size} B)`)
  if (files.length > 200) lines.push(`  …还有 ${files.length - 200} 个文件`)

  const withText = files.filter((f) => typeof f.text === 'string')
  let used = 0
  const chunks: string[] = []
  for (const f of withText.slice(0, MAX_ARCHIVE_MEMBERS)) {
    if (used + f.size > MAX_ARCHIVE_TEXT) break
    used += f.size
    chunks.push(`--- ${f.path} ---\n${f.text}`)
  }
  if (chunks.length) {
    lines.push('', `文本文件内容（${chunks.length} 个，共 ${(used / 1024).toFixed(1)} KB）：`)
    lines.push(chunks.join('\n\n'))
  } else {
    lines.push('', '（包内没有可读的文本文件）')
  }
  return lines.join('\n')
}

/**
 * 把一个附件读成可发给模型的内容块。**这里不拒绝，只整形**。
 *
 * 处理策略按类型：
 *  - 图片 → prepareImage 自动缩放/转码到 API 上限；解不了的格式给元信息
 *  - PDF  → Anthropic / OpenAI Responses 原生读取；超上限或不支持的协议给说明
 *  - 文本 → 超长截断并标注；保留头尾，中间省略（比只留开头有用）
 *  - 压缩包 → 解包，目录清单 + 文本成员内容（总量限流）
 *  - 其它二进制 → 不发内容，给文件名 / 类型 / 大小
 *
 * 任何情况下都返回可用的内容（part 或 note），不会让整条消息发不出去。
 */
export async function buildAttachmentPart(
  path: string,
  adapter: 'anthropic' | 'openai' | 'responses'
): Promise<{ part?: ContentPart; note?: string }> {
  const abs = resolve(path)
  const name = basename(abs)
  if (!allowed.has(abs)) return { note: `已忽略未授权文件：${name}` }
  const ext = extname(abs).toLowerCase()
  const kind = classify(ext)
  try {
    const stat = await fs.stat(abs)
    const size = stat.size

    if (kind === 'image') {
      const buf = await fs.readFile(abs)
      const mime = sniffImageMime(buf)
      if (!mime) {
        return { note: `图片「${name}」（${formatBytes(size)}）格式无法识别，未发送内容` }
      }
      const prepared = prepareImage(buf, mime, name)
      if (!prepared.ok) {
        return { note: `图片「${name}」处理失败：${prepared.reason}` }
      }
      // 缩放/转码过就在正文里说明一句，用户知道发出去的不是原图
      if (prepared.resized && prepared.sentBytes !== undefined) {
        return {
          part: prepared.part,
          note: `图片「${name}」已自动压缩：${formatBytes(size)} → ${formatBytes(prepared.sentBytes)}`
        }
      }
      return { part: prepared.part }
    }

    if (kind === 'document') {
      if (adapter === 'openai') {
        return { note: `PDF「${name}」需使用 Anthropic 或 OpenAI Responses 协议的模型才能读取，本次已跳过` }
      }
      if (size > MAX_PDF) {
        return { note: `PDF「${name}」${formatBytes(size)} 超过接口上限 ${formatMb(MAX_PDF)}，未发送` }
      }
      const buf = await fs.readFile(abs)
      return {
        part: { type: 'document', mediaType: 'application/pdf', data: buf.toString('base64'), name }
      }
    }

    if (kind === 'text') {
      const buf = await fs.readFile(abs)
      if (size <= MAX_TEXT) {
        return {
          part: {
            type: 'text',
            text: `${ATTACH_TEXT_PREFIX}${name}\n\`\`\`\n${buf.toString('utf8')}\n\`\`\``
          }
        }
      }
      // 超长：保留头尾，中间标注省略了多少
      const text = buf.toString('utf8')
      const head = text.slice(0, MAX_TEXT * 0.7)
      const tail = text.slice(-MAX_TEXT * 0.25)
      const omitted = text.length - head.length - tail.length
      return {
        part: {
          type: 'text',
          text: `${ATTACH_TEXT_PREFIX}${name}（原文件 ${formatBytes(size)}，已截断）\n\`\`\`\n${head}\n\n…（中间省略 ${formatBytes(omitted)}）…\n\n${tail}\n\`\`\``
        }
      }
    }

    if (kind === 'archive') {
      const text = await readArchiveAsText(abs)
      return {
        part: { type: 'text', text: `${ATTACH_TEXT_PREFIX}${name}（压缩包内容）\n${text}` }
      }
    }

    // 未知二进制：不发内容，但告诉模型有这么一个文件
    return {
      note: `附件「${name}」（${ext || '无扩展名'}，${formatBytes(size)}）为二进制类型，未发送内容`
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { note: `读取附件「${name}」失败：${reason}` }
  }
}
