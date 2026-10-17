/**
 * 服务器文件选择器（Web 版 dialog.showOpenDialog 的浏览器端实现）。
 *
 * 服务端 dialog 钩子经 WS「请求/应答」到达这里（deva:server-request，kind='dialog'），
 * 弹出 UI 让用户浏览服务器文件系统（GET /api/browse），选中后把路径交回服务端。
 * 支持：openDirectory（选目录） / openFile（选文件，可多选）——覆盖 openFolder、
 * pickAttachments、skills import 三处调用。
 */
import { useEffect, useRef, useState } from 'react'
import { File, Folder, FolderUp, X, Check, Upload } from 'lucide-react'

interface BrowseEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

interface PickerState {
  id: string
  openDirectory: boolean
  multi: boolean
  filters: string[]
  respond: (payload: unknown) => void
}

export function FilePickerHost(): React.JSX.Element | null {
  const [state, setState] = useState<PickerState | null>(null)
  const [cwd, setCwd] = useState<string>('')
  const [parent, setParent] = useState<string>('')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const uploadRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onReq = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as {
        id: string
        kind: string
        payload: Record<string, unknown>
        respond: (p: unknown) => void
      }
      if (!detail || detail.kind !== 'dialog') return
      const props = Array.isArray(detail.payload?.properties)
        ? (detail.payload.properties as string[])
        : []
      const openDirectory = props.includes('openDirectory')
      const multi = props.includes('multiSelections')
      const filters: string[] = []
      const rawFilters = detail.payload?.filters
      if (Array.isArray(rawFilters)) {
        for (const f of rawFilters) {
          const exts = (f as { extensions?: unknown })?.extensions
          if (Array.isArray(exts)) for (const e of exts) if (e !== '*') filters.push(String(e).toLowerCase())
        }
      }
      setState({ id: detail.id, openDirectory, multi, filters, respond: detail.respond })
      setSelected(new Set())
      setError('')
      void load('')
    }
    window.addEventListener('deva:server-request', onReq)
    return () => window.removeEventListener('deva:server-request', onReq)
  }, [])

  async function load(path: string): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse'
      const r = await fetch(url, { credentials: 'same-origin' })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || '读取失败')
      setCwd(d.path)
      setParent(d.parent)
      setEntries(d.entries as BrowseEntry[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  function close(canceled: boolean, filePaths: string[] = []): void {
    if (state) state.respond(canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths })
    setState(null)
  }

  function toggle(path: string): void {
    if (!state) return
    const next = new Set(selected)
    if (state.multi) {
      if (next.has(path)) next.delete(path)
      else next.add(path)
    } else {
      next.clear()
      next.add(path)
    }
    setSelected(next)
  }

  function accept(): void {
    if (!state) return
    if (state.openDirectory) {
      // 选目录：未选中任何目录时选当前目录，选中则取选中项
      const picked = [...selected]
      close(false, picked.length > 0 ? picked : [cwd])
      return
    }
    const picked = [...selected]
    if (picked.length === 0) return
    close(false, picked)
  }

  if (!state) return null

  /** 从本机（浏览器所在设备）上传文件到服务器：上传完成即以该服务器路径作为选择结果。 */
  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const paths: string[] = []
      for (const f of Array.from(files).slice(0, state!.multi ? 20 : 1)) {
        const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          credentials: 'same-origin',
          body: f
        })
        const d = await r.json()
        if (!d.ok) throw new Error(d.error || '上传失败')
        paths.push(d.path as string)
      }
      close(false, paths)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const shown = entries.filter((e) => {
    if (state.openDirectory) return true
    if (e.type === 'dir') return true
    if (state.filters.length === 0) return true
    const ext = e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() : ''
    return state.filters.includes(ext)
  })

  const canAccept = state.openDirectory || selected.size > 0

  return (
    <div className="deva-picker" role="dialog" aria-modal="true">
      <div className="deva-picker__panel">
        <div className="deva-picker__head">
          <span className="deva-picker__title">{state.openDirectory ? '选择服务器文件夹' : '选择服务器文件'}</span>
          <button className="deva-picker__btn" style={{ height: 28, padding: '0 10px' }} onClick={() => close(true)} title="取消">
            <X size={14} />
          </button>
        </div>
        <div className="deva-picker__crumb" title={cwd}>
          {cwd || '…'}
        </div>
        <div className="deva-picker__list">
          {error ? (
            <div className="deva-picker__empty">无法读取目录：{error}</div>
          ) : loading ? (
            <div className="deva-picker__loading">加载中…</div>
          ) : (
            <>
              {parent && parent !== cwd && (
                <button className="deva-picker__row" onClick={() => void load(parent)}>
                  <FolderUp size={16} />
                  <span className="deva-picker__name">..</span>
                </button>
              )}
              {shown.length === 0 && <div className="deva-picker__empty">（空目录）</div>}
              {shown.map((e) => (
                <button
                  key={e.path}
                  className={`deva-picker__row${selected.has(e.path) ? ' is-selected' : ''}`}
                  onClick={() => {
                    if (e.type === 'dir') {
                      if (state.openDirectory) toggle(e.path)
                      else if (state.multi) toggle(e.path)
                    } else {
                      toggle(e.path)
                    }
                  }}
                  onDoubleClick={() => {
                    if (e.type === 'dir') void load(e.path)
                    else if (!state.openDirectory) {
                      toggle(e.path)
                      setTimeout(() => close(false, [e.path]), 0)
                    }
                  }}
                  title={e.path}
                >
                  {e.type === 'dir' ? <Folder size={16} /> : <File size={16} />}
                  <span className="deva-picker__name">{e.name}</span>
                  {selected.has(e.path) && <Check size={14} style={{ color: 'var(--accent)' }} />}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="deva-picker__foot">
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {uploading
              ? '上传中…'
              : state.openDirectory
                ? selected.size > 0
                  ? `已选 ${selected.size} 个目录`
                  : '双击进入 · 选中或直接确认当前目录'
                : `已选 ${selected.size} 项 · 双击文件直接打开`}
          </span>
          <div className="deva-picker__spacer" />
          {/* 从本机上传（手机/第三方电脑常用：服务器上并没有这个文件） */}
          {!state.openDirectory && (
            <>
              <input
                ref={uploadRef}
                type="file"
                multiple={state.multi}
                style={{ display: 'none' }}
                onChange={(e) => void uploadFiles(e.target.files)}
              />
              <button
                className="deva-picker__btn"
                disabled={uploading}
                onClick={() => uploadRef.current?.click()}
                title="从本机上传到服务器"
              >
                <Upload size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
                本机上传
              </button>
            </>
          )}
          <button className="deva-picker__btn" onClick={() => close(true)}>
            取消
          </button>
          <button className="deva-picker__btn is-primary" disabled={!canAccept || uploading} onClick={accept}>
            {state.openDirectory ? '选择此文件夹' : '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
