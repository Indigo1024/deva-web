/**
 * electron-updater 替身（Web 构建专用）。
 *
 * Web 无需桌面端自动更新（Windows exe 就地覆盖安装的那条链路不存在）：
 * updater.ts 里只有 canAutoInstall() 为真（win32 + 打包安装）时才会真正取用
 * autoUpdater —— linux web 恒为 manual 模式（打开 Releases 页面），自动更新调用面永不触达。
 * 此替身保住模块可加载性与类型形状。
 */
export type AppUpdater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on: (evt: string, cb: (...args: unknown[]) => void) => void
  checkForUpdates: () => Promise<null>
  downloadUpdate: () => Promise<void>
  quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void
}

export const autoUpdater: AppUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: () => {},
  checkForUpdates: async () => null,
  downloadUpdate: async () => {},
  quitAndInstall: () => {}
}
