import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { RELEASES_URL, type UpdateState } from '../../../shared/update'

const PLATFORM = window.deva?.platform ?? (navigator.userAgent.includes('Mac') ? 'darwin' : '')
const IS_MAC = PLATFORM === 'darwin'
const IS_LINUX = PLATFORM === 'linux'
/** Web 构建才有（桌面构建里是 undefined）。 */
const IS_WEB = typeof __WEB_VERSION__ === 'string'

/** 手动更新时的说明文案：各平台（Linux 再分 deb / AppImage）的「下载之后怎么装」不一样。 */
function manualHintKey(file: string | null): string {
  if (IS_MAC) return 'settings.update.manualHintMac'
  if (IS_LINUX)
    return file?.endsWith('.deb') ? 'settings.update.manualHintDeb' : 'settings.update.manualHintLinux'
  return 'settings.update.manualHint'
}

/**
 * 关于页的「检查更新」：只在点按钮时检查。状态由主进程持有，这里只展示与触发——
 * 下载途中离开关于页再回来，进度照样接得上。
 *
 * Web 版走 web-server/web-updater.ts：数据源是改版仓库，「安装」= 服务器拉取源码重建并重启。
 * 因为重启会杀掉当前进程，安装后前端进入「等待服务回来」的轮询态，而不是等 IPC 返回。
 */
export function UpdateSection(): React.JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState<UpdateState>({ phase: 'idle' })
  const [installing, setInstalling] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [waitNote, setWaitNote] = useState('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let pushed = false
    const off = window.deva.update.onState((s) => {
      pushed = true
      setState(s)
    })
    // 先订阅再取快照；取回之前已收到推送就以推送为准（快照可能更旧）
    void window.deva.update.getState().then((s) => {
      if (!pushed) setState(s)
    })
    return () => {
      off()
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [])

  const check = (): void => void window.deva.update.check()
  const download = (): void => void window.deva.update.download()

  /**
   * Web 安装：服务会重启，不能等 IPC 返回（连接会断）。
   * 进入等待态后轮询 /api/health，服务回来后自动刷新页面。
   */
  const installWeb = (): void => {
    setInstalling(true)
    setWaiting(true)
    setWaitNote('正在服务器上构建新版本，这可能需要几分钟…')
    void window.deva.update.install().catch(() => {
      /* 进程被重启时请求中断，属正常 */
    })

    let tries = 0
    timer.current = window.setInterval(async () => {
      tries += 1
      try {
        const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
        if (r.ok) {
          window.clearInterval(timer.current!)
          timer.current = null
          setWaitNote('新版本已就绪，正在刷新…')
          window.setTimeout(() => window.location.reload(), 800)
          return
        }
      } catch {
        /* 服务重启中，继续等 */
      }
      if (tries === 20) setWaitNote('构建仍在进行（已等约 1 分钟），请耐心等待…')
      if (tries === 100) {
        window.clearInterval(timer.current!)
        timer.current = null
        setWaiting(false)
        setInstalling(false)
        setWaitNote('等待超时：请查看安装日志或手动重启服务。')
      }
    }, 3000)
  }

  const install = (): void => {
    setInstalling(true)
    if (IS_WEB) {
      installWeb()
      return
    }
    void window.deva.update.install()
  }

  const link = (href: string, label: string): React.JSX.Element => (
    <a className="cf-update__link" href={href} target="_blank" rel="noreferrer">
      {label}
      <ExternalLink size={11} />
    </a>
  )

  if (waiting) {
    return (
      <div className="cf-update">
        <div className="cf-update__status">
          <Loader2 size={13} className="spin" />
          {waitNote}
        </div>
        <p className="cf-update__hint">
          服务重启期间连接会短暂中断，页面会自动刷新。若长时间无响应，可查看{' '}
          <a className="cf-update__link" href="/api/update-log" target="_blank" rel="noreferrer">
            安装日志
          </a>
          。
        </p>
      </div>
    )
  }

  if (state.phase === 'available') {
    const { release, mode, file } = state
    return (
      <div className="cf-update">
        <div className="cf-update__status">
          {t('settings.update.available').replace('{version}', `v${release.version}`)}
          {link(release.pageUrl, t('settings.update.notes'))}
        </div>
        <button className="btn btn--primary btn--sm" onClick={download}>
          <Download size={13} />
          {mode === 'auto'
            ? IS_WEB
              ? '准备更新'
              : t('settings.update.download')
            : mode === 'portable'
              ? t('settings.update.downloadPortable')
              : t('settings.update.downloadInstaller')}
        </button>
        {mode === 'manual' && (
          <p className="cf-update__hint">
            {t(manualHintKey(file)).replace('{file}', file ?? '')}
          </p>
        )}
        {mode === 'portable' && (
          <p className="cf-update__hint">{t('settings.update.portableHint')}</p>
        )}
      </div>
    )
  }

  if (state.phase === 'downloading') {
    return (
      <div className="cf-update">
        <div className="cf-update__status">
          {IS_WEB
            ? `正在获取新版本… ${state.percent}%`
            : t('settings.update.downloading').replace('{percent}', String(state.percent))}
        </div>
        <div className="cf-update__bar">
          <div className="cf-update__fill" style={{ width: `${state.percent}%` }} />
        </div>
      </div>
    )
  }

  if (state.phase === 'downloaded') {
    return (
      <div className="cf-update">
        <div className="cf-update__status is-ok">
          <CheckCircle2 size={13} />
          {t('settings.update.downloaded').replace('{version}', `v${state.release.version}`)}
        </div>
        <button className="btn btn--primary btn--sm" onClick={install} disabled={installing}>
          {installing ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />}
          {IS_WEB ? '立即安装并重启' : t('settings.update.install')}
        </button>
        <p className="cf-update__hint">
          {IS_WEB
            ? '将在服务器上拉取源码、重新构建并重启服务，期间连接会短暂中断。'
            : t('settings.update.installHint')}
        </p>
      </div>
    )
  }

  if (state.phase === 'error') {
    const failedDownload = state.stage === 'download'
    return (
      <div className="cf-update">
        <div className="cf-update__status is-error">
          <AlertTriangle size={13} />
          {failedDownload ? t('settings.update.downloadFailed') : t('settings.update.checkFailed')}
        </div>
        <p className="cf-update__hint cf-update__hint--mono">{state.message}</p>
        <div className="cf-update__actions">
          <button className="btn btn--sm" onClick={failedDownload ? download : check}>
            <RefreshCw size={13} />
            {t('settings.update.retry')}
          </button>
          {link(state.release?.pageUrl ?? RELEASES_URL, t('settings.update.openReleases'))}
        </div>
      </div>
    )
  }

  const checking = state.phase === 'checking'
  return (
    <div className="cf-update">
      <button className="btn btn--sm" onClick={check} disabled={checking}>
        {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        {checking ? t('settings.update.checking') : t('settings.update.check')}
      </button>
      {state.phase === 'latest' && (
        <div className="cf-update__status is-ok">
          <CheckCircle2 size={13} />
          {t('settings.update.latest')}
        </div>
      )}
    </div>
  )
}
