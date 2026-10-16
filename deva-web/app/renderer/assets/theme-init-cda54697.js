/**
 * 首帧主题应用（外部脚本，满足 CSP script-src 'self'）。
 * 在内联样式之后、应用模块之前同步执行：
 * 读应用页内联的 deva-boot JSON 数据块（服务端注入，替代曾经的 /api/boot.js 请求），
 * 把配置暴露为 window.__DEVA_BOOT__（web-ipc 的 sendSync('config:get-sync') 依赖它），
 * 取 config.theme → 回落 localStorage → 再回落 prefers-color-scheme，落到 <html data-theme>。
 */
;(function () {
  try {
    var el = document.getElementById('deva-boot')
    if (el && el.textContent) {
      try {
        window.__DEVA_BOOT__ = JSON.parse(el.textContent)
      } catch (e) {
        /* 数据块损坏 → 走本地回退 */
      }
    }
    var b = window.__DEVA_BOOT__ || {}
    var m = (b.config || {}).theme
    if (!m) m = localStorage.getItem('deva.theme')
    var dark = m === 'dark' || ((m === 'system' || !m) && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  } catch (e) {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
})()
