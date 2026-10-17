/**
 * 登录页（服务端渲染，独立于 React 应用——未认证时永不渲染应用内容，杜绝闪现）。
 *
 * 视觉与主应用同源：复用 tokens.css 的设计变量（明暗主题、accent #5b5bd6）、
 * 同一个应用图标（build/icon.svg 的 D 标志）、同字体栈。
 * 主题：读取 localStorage 的 deva.theme（由主应用写入）或 prefers-color-scheme，
 * 在首帧前由内联脚本应用到 <html data-theme>，避免主题闪烁。
 */

/** 应用图标（与 build/icon.svg 一致的内联圆角渐变 D 标志）。 */
export const DEVA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4F46E5"/>
      <stop offset="1" stop-color="#7C3AED"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <g fill="#FFFFFF" transform="translate(-27 -26)">
    <rect x="312" y="272" width="96" height="380" rx="48"/>
    <circle cx="360" cy="756" r="48"/>
    <path d="M468 320 H500 A218 218 0 0 1 500 756 H468"
          fill="none" stroke="#FFFFFF" stroke-width="96" stroke-linejoin="round"/>
  </g>
</svg>`

export function loginPageHtml(prefetchUrls: string[] = []): string {
  const preface = prefetchUrls.filter((u) => /^\/assets\/[A-Za-z0-9._@()-]+\.(js|css)$/.test(u))
  // 登录页在后台预热应用构建产物（登录后首屏直接命中 HTTP 缓存，避免「登录后干等」）。
  // 纯 fetch() 实现（全浏览器可用）：load 后或 700ms 起步，低优先级、尊重省流模式、静默失败。
  const prefetchJs = preface.length === 0
    ? ''
    : `<script>(function(){var urls=${JSON.stringify(preface)};if(navigator.connection&&navigator.connection.saveData)return;var done=false;function kick(){if(done)return;done=true;for(var i=0;i<urls.length;i++){try{fetch(urls[i],{credentials:'same-origin',priority:'low'}).catch(function(){})}catch(e){}}}window.addEventListener('load',kick);setTimeout(kick,700);})();</script>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#1e1e20" />
<title>登录 · Deva</title>
<style>
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif;
  --bg: #ffffff; --bg-panel: #f7f7f8; --bg-elevated: #ffffff; --bg-inset: #f0f0f2;
  --fg: #1f1f24; --fg-muted: #5c5c66; --fg-subtle: #8a8a94;
  --border: #e6e6ea; --border-strong: #d5d5db;
  --accent: #5b5bd6; --accent-hover: #4c4cc4; --accent-fg: #ffffff; --accent-tint: rgba(91, 91, 214, 0.1);
  --danger: #e5484d;
  --radius: 8px; --radius-lg: 12px; --radius-full: 999px;
  --shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  color-scheme: light;
}
:root[data-theme='dark'] {
  --bg: #1e1e20; --bg-panel: #252528; --bg-elevated: #2a2a2e; --bg-inset: #191919;
  --fg: #e4e4e7; --fg-muted: #a1a1aa; --fg-subtle: #71717a;
  --border: #2f2f33; --border-strong: #3d3d42;
  --accent: #7c7cf0; --accent-hover: #9090f5; --accent-fg: #14141a; --accent-tint: rgba(124, 124, 240, 0.16);
  --danger: #ff6b6b;
  --shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--fg);
  display: grid;
  place-items: center;
  padding: 24px;
  -webkit-font-smoothing: antialiased;
  background-image:
    radial-gradient(1200px 600px at 70% -10%, var(--accent-tint), transparent 60%),
    radial-gradient(800px 500px at 0% 110%, var(--accent-tint), transparent 55%);
}
.card {
  width: 100%;
  max-width: 400px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 36px 32px 30px;
  animation: card-in 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes card-in { from { opacity: 0; transform: translateY(10px) scale(0.985); } }
.logo { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-bottom: 26px; }
.logo svg { width: 64px; height: 64px; border-radius: 15px; box-shadow: 0 8px 24px rgba(91, 91, 214, 0.35); }
.logo h1 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: 0.01em; }
.logo p { margin: 0; font-size: 13px; color: var(--fg-subtle); }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.field label { font-size: 12px; font-weight: 600; color: var(--fg-muted); }
.field input {
  height: 40px;
  padding: 0 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--fg);
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  outline: none;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-tint); }
.btn {
  width: 100%;
  height: 40px;
  margin-top: 6px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.12s ease, opacity 0.12s ease;
}
.btn:hover { background: var(--accent-hover); }
.btn:disabled { opacity: 0.65; cursor: default; }
.spinner {
  width: 16px; height: 16px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.error {
  margin-top: 14px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  border-radius: var(--radius);
  display: none;
}
.error.show { display: block; animation: shake 0.35s; }
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}
.foot { margin-top: 22px; text-align: center; font-size: 12px; color: var(--fg-subtle); }
@media (max-width: 480px) {
  body { padding: 16px; align-items: start; padding-top: max(9vh, 24px); }
  .card { padding: 28px 22px 24px; border-radius: 14px; }
}
</style>
<script>
(function () {
  try {
    var m = localStorage.getItem('deva.theme');
    var dark = m === 'dark' || ((m === 'system' || !m) && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
})();
</script>
</head>
<body>
<form class="card" id="form" autocomplete="on">
  <div class="logo">
    ${DEVA_ICON_SVG}
    <h1>Deva</h1>
    <p id="sub">登录以继续</p>
  </div>
  <div class="field">
    <label for="u">用户名</label>
    <input id="u" name="username" type="text" autocomplete="username" autofocus required />
  </div>
  <div class="field">
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required />
  </div>
  <button class="btn" id="go" type="submit"><span id="goText">登 录</span></button>
  <div class="error" id="err"></div>
  <div class="foot">Deva · 私人工作台</div>
</form>
<script>
(function () {
  var form = document.getElementById('form');
  var btn = document.getElementById('go');
  var goText = document.getElementById('goText');
  var err = document.getElementById('err');
  var busy = false;
  function showErr(msg) {
    err.textContent = msg || '登录失败，请稍后重试';
    err.classList.remove('show');
    void err.offsetWidth;
    err.classList.add('show');
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    err.classList.remove('show');
    var u = document.getElementById('u').value;
    var p = document.getElementById('p').value;
    btn.disabled = true;
    goText.innerHTML = '<span class="spinner"></span>';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: u, password: p })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (r) {
        if (r.status === 200 && r.d.ok) {
          goText.textContent = '正在进入…';
          location.replace('/');
          return;
        }
        busy = false;
        btn.disabled = false;
        goText.textContent = '登 录';
        if (r.status === 429) showErr('尝试次数过多，请 ' + Math.ceil((r.d.retryAfterSec || 600) / 60) + ' 分钟后再试');
        else showErr('用户名或密码错误');
      })
      .catch(function () {
        busy = false;
        btn.disabled = false;
        goText.textContent = '登 录';
        showErr('网络错误，请重试');
      });
  });
})();
</script>
${prefetchJs}
</body>
</html>`
}
