/** 构建时由 electron.vite.config.ts 的 define 注入，值取自 apps/desktop/package.json。 */
declare const __APP_VERSION__: string

/**
 * 以下仅在 Web 构建（scripts/build-web.mjs）中注入：
 *  - __WEB_VERSION__   Web 改版自身的版本号（apps/desktop/web-version.json）
 *  - __UPSTREAM_REPO__ 上游 Deva 源码仓库地址
 *  - __WEB_REPO__      本改版仓库地址
 * 桌面构建没有这些常量，引用处必须先做 typeof 判断。
 */
declare const __WEB_VERSION__: string | undefined
declare const __UPSTREAM_REPO__: string | undefined
declare const __WEB_REPO__: string | undefined

/** 静态资源（vite 构建为带哈希的 URL）。 */
declare module '*.svg' {
  const src: string
  export default src
}
