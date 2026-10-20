# Deva Web Port

Run the [Deva](https://github.com/sqfcyily/deva) desktop client in a browser.

> **This is an unofficial third-party port, not the Deva project.**
> The author is not affiliated with the upstream developers, has no authorization from them,
> and nothing here represents upstream's position.
>
> - Upstream project: **[sqfcyily/deva](https://github.com/sqfcyily/deva)**
> - Upstream site: **https://sqfcyily.github.io/deva/**
> - Upstream license: MIT
>
> If you want the desktop app, get it from upstream. **This repository ships no Electron installers.**

---

## What this port does

Upstream Deva is an Electron desktop app — one install per machine. This port turns it into
**a single Node process on a Linux server with a browser front end**: install the service once,
then use it from a phone, tablet, or any other computer by opening a URL. No client install needed.

The approach is to **shim the Electron boundary** rather than rewrite upstream logic:

- At build time, an esbuild alias swaps `'electron'` for a pure-Node shim module, so the main-process
  service code runs unchanged inside a Node process
- The `window.deva` surface exposed by preload is bridged to the browser 1:1 over WebSocket;
  that bridge is generated from the preload source by a script, never hand-written
- The React renderer is reused from upstream, with a Web stylesheet and mobile layout layered on top

**The features themselves are upstream's work.** This repository does not document or claim them.
To learn what Deva can do, see the [upstream project](https://github.com/sqfcyily/deva).

---

## What this port adds

Everything below is implemented in this repository; upstream has none of it.

### Authentication and access control

- Username + strong password, scrypt with per-user salt, stored in `$DEVA_HOME/web-auth.json`
- Stateless signed session token (`<exp>.<hmac>`), HttpOnly + SameSite=Lax cookie, 30 days by default
- 5 failed attempts from one IP locks it out for 10 minutes
- Unauthenticated requests to `/` and `/index.html` get a **server-side 302 to `/login`** —
  the app shell is never rendered first and then yanked away
- The login page reuses the app's own CSS variables and component classes, so it matches the UI

### Mobile layout

Not a squeezed desktop layout — a different structure via pure CSS (`@media (max-width: 719px)`):

- Sidebar becomes a drawer (`min(78vw, 330px)`) with a translucent scrim
- The bottom icon rail becomes a tab bar
- Modal backdrop is raised to `z-index: 120` so the drawer can't cover dialogs
- The model picker goes full-width on narrow screens (anchored right, it used to run off-screen)

### Connection reliability

WebSocket drops are normal on mobile (backgrounding, screen lock, network switch). Four layers:

| Mechanism | Purpose |
| --- | --- |
| 8s upgrade watchdog | Closes a socket stuck in CONNECTING and retries |
| 4s ping/pong probe | No pong within 4s means a zombie connection — force reconnect |
| 25s keepalive | Only while the document is visible, to save battery |
| Lifecycle kick | `visibilitychange` / `pageshow` / `online` trigger an immediate reconnect |

The boot splash is a **resettable state machine**: `showSplash()` clears the pending hide timer and
resets the "already hidden" flag. This bit us once — a one-shot latch meant that after the first
successful load, any later disconnect left the overlay permanently covering a perfectly healthy UI.

### Desktop-only actions, degraded for the browser

| Desktop | This port |
| --- | --- |
| Native file dialog | Server-side directory browser |
| Open delivered file in default app | Download via `/api/deliverable` |
| Reveal in file manager | Copies the path instead |
| System notifications | Browser notifications / in-page toasts |
| Thumbnails | Returns `null`; the UI falls back to a type icon |
| Window fullscreen / macOS traffic lights | No-ops |
| electron-updater | Not applicable — upgrade by rebuilding |

### Site icon and PWA

The icon is derived from the app's own boot splash mark, producing `favicon.ico` (7 sizes), `svg`,
`192`, `512`, `apple-touch-icon`, and `site.webmanifest`. Android can add it to the home screen as a
standalone app. Icon paths are individually exempted from the auth wall so anonymous browser
requests don't get 401s.

---

## Quick start

Requires Node.js 20+, pnpm, and Linux (x64 / arm64).

```bash
git clone https://github.com/Indigo1024/deva-web.git
cd deva-web
pnpm install

cd apps/desktop
node scripts/gen-web-api.mjs     # generate the window.deva bridge
node scripts/build-web.mjs       # build server bundle + front end

DEVA_HOME=$HOME/.deva \
DEVA_WEB_PORT=8790 \
DEVA_WEB_HOST=127.0.0.1 \
DEVA_WEB_STATIC=$PWD/out/web/renderer \
node out/web/index.cjs
```

First start generates credentials at `$DEVA_HOME/web-login.txt` (mode 0600):

```bash
cat ~/.deva/web-login.txt
```

Then open `http://127.0.0.1:8790`.

Change the password:

```bash
node out/web/ctl.cjs passwd     # also invalidates all existing sessions
```

**Full deployment guide** (env vars, systemd, Cloudflare Tunnel / nginx, architecture,
upstream-merge checklist, known limitations) lives in **[docs/WEB.md](docs/WEB.md)**.

---

## ⚠️ Security boundary

This port puts the desktop app's full power behind a browser:

- The agent's file tools have **no path restrictions**
- The terminal has **no command allowlist**
- The login wall is the only boundary

**Do not expose this publicly with a weak password**, and don't run it on a shared machine.
The server's PTY and filesystem are fully available to anyone who logs in.

---

## Tracking upstream

This repo follows upstream releases. Every merge needs a Web-adaptation pass — new IPC channels,
new `BrowserWindow` methods, or new `e.sender` usage can crash the Web build at runtime.
The full checklist is in [docs/WEB.md](docs/WEB.md).

---

## Credits and license

Upstream [sqfcyily/deva](https://github.com/sqfcyily/deva) is MIT licensed; copyright belongs to its
authors. This port would not exist without it.

The web adaptation layer here is likewise released under [MIT](LICENSE) — deploy it or fork it freely.
