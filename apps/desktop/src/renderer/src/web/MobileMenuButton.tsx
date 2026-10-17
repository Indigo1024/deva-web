/**
 * 手机端抽屉唤起键（顶栏菜单图标）。
 *
 * 独立组件：不穿 props，点击只派发 `deva:mobmenu` 事件，由 ChatFirstShell 统一
 * 开关 .cf-shell.is-mobdrawer。
 * 仅在 Web 环境渲染（window.deva.platform === 'web'）——Electron 桌面构建不下发
 * 移动样式（mobile.css 仅 web 入口引入），此键在桌面会退化成无样式按钮，故直接不渲染。
 */
import { Menu } from 'lucide-react'

function isWebEnv(): boolean {
  try {
    return (window as { deva?: { platform?: string } }).deva?.platform === 'web'
  } catch {
    return false
  }
}

export function MobileMenuButton({ className }: { className?: string }): React.JSX.Element | null {
  if (!isWebEnv()) return null
  return (
    <button
      type="button"
      className={className ? `cf-mobmenu ${className}` : 'cf-mobmenu'}
      aria-label="会话列表"
      title="会话列表"
      onClick={() => window.dispatchEvent(new CustomEvent('deva:mobmenu'))}
    >
      <Menu size={19} />
    </button>
  )
}
