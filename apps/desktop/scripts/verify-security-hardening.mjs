/**
 * 安全加固一次性验收脚本（零新增依赖，完全在临时 DEVA_HOME 隔离运行，不触碰真实数据目录）。
 *
 * 覆盖验收项：
 *  1) resolveClientIp 全部场景
 *  2) checkWsOrigin 全部场景（含单次告警与 Cookie/token 零泄露）
 *  3) secrets.ts 写入权限 0600、无 .tmp 残留、冷启动 5 并发 setSecret 键完整性
 *  4) 删除 web-secret.key（保留非空 secrets.json）后启动真实 out/web/index.cjs：告警日志 + 正常提供服务 + WS 403 拦截 + decryptString 单次告警
 *
 * 运行（在 apps/desktop 目录下）：
 *   node scripts/verify-security-hardening.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build as esbuild } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const require_ = createRequire(import.meta.url)

const workDir = mkdtempSync(join(tmpdir(), 'deva-sec-verify-'))

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? rej(err) : res(port)))
    })
    srv.on('error', rej)
  })
}

function httpGetStatus(port, path) {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', timeout: 3000 }, (r) => {
      r.resume()
      res(r.statusCode ?? 0)
    })
    req.on('error', rej)
    req.end()
  })
}

function rawWsUpgradeStatus(port, headers) {
  return new Promise((res, rej) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/ws',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers
      },
      timeout: 3000
    })
    req.on('response', (r) => {
      r.resume()
      res(r.statusCode ?? 0)
    })
    req.on('upgrade', (_r, socket) => {
      socket.destroy()
      res(101)
    })
    req.on('error', rej)
    req.end()
  })
}

try {
  // 先用 esbuild 编译待测模块到临时目录
  const guardOut = join(workDir, 'net-guard.cjs')
  await esbuild({
    entryPoints: [join(desktopRoot, 'src', 'web-server', 'net-guard.ts')],
    outfile: guardOut,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'silent'
  })

  const secretsHarnessOut = join(workDir, 'secrets-harness.cjs')
  await esbuild({
    entryPoints: [join(desktopRoot, 'src', 'main', 'services', 'secrets.ts')],
    outfile: secretsHarnessOut,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [
      {
        name: 'shim-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({
            path: join(desktopRoot, 'src', 'web-server', 'electron-shim.ts')
          }))
        }
      }
    ]
  })

  // ── 验收 2：resolveClientIp ────────────────────────────────────────────────
  console.log('=== [验收 2] resolveClientIp ===')
  const { resolveClientIp, checkWsOrigin } = require_(guardOut)

  const mkReq = (remoteAddress, headers = {}) => ({
    headers: { cookie: 'deva_sid=TOP_SECRET_TOKEN_999', ...headers },
    socket: { remoteAddress }
  })

  const ip1 = resolveClientIp(
    mkReq('203.0.113.50', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'cf-connecting-ip': '9.9.9.9' }),
    'auto'
  )
  assert.equal(ip1, '203.0.113.50')
  console.log('  PASS 公网对端 + 伪造 XFF/CF 头 →', ip1)

  const ip2 = resolveClientIp(mkReq('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), 'auto')
  assert.equal(ip2, '2.2.2.2')
  console.log('  PASS 127.0.0.1 + XFF "1.1.1.1, 2.2.2.2" →', ip2)

  const ip3 = resolveClientIp(mkReq('172.18.0.2', { 'x-forwarded-for': '10.0.0.1, 198.51.100.8' }), 'auto')
  assert.equal(ip3, '198.51.100.8')
  console.log('  PASS 172.18.0.2 (Docker) + XFF →', ip3)

  const ip4 = resolveClientIp(
    mkReq('127.0.0.1', { 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '172.68.1.2' }),
    'cloudflare'
  )
  assert.equal(ip4, '198.51.100.77')
  const ip4Auto = resolveClientIp(
    mkReq('127.0.0.1', { 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '172.68.1.2' }),
    'auto'
  )
  assert.equal(ip4Auto, '172.68.1.2')
  console.log('  PASS mode=cloudflare + 回环 + CF-Connecting-IP →', ip4, '(auto 下不信 CF 头 →', ip4Auto + ')')

  const ip5 = resolveClientIp(
    mkReq('127.0.0.1', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }),
    'none'
  )
  assert.equal(ip5, '127.0.0.1')
  console.log('  PASS mode=none →', ip5)

  const ip6 = resolveClientIp(mkReq('::ffff:127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.88' }), 'auto')
  assert.equal(ip6, '203.0.113.88')
  console.log('  PASS ::ffff:127.0.0.1 按回环处理 →', ip6)

  const ipBad = resolveClientIp(mkReq('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, not-an-ip' }), 'auto')
  assert.equal(ipBad, '127.0.0.1')
  console.log('  PASS 非法 IP 值退回对端地址 →', ipBad)

  // ── 验收 3：checkWsOrigin ──────────────────────────────────────────────────
  console.log('\n=== [验收 3] checkWsOrigin ===')
  const capturedWarns = []
  const origWarn = console.warn
  console.warn = (...args) => {
    capturedWarns.push(args.join(' '))
  }
  try {
    delete process.env.DEVA_WEB_ORIGIN_CHECK
    delete process.env.DEVA_WEB_ALLOWED_ORIGINS

    // 3.1 无 Origin → allow
    const o1 = checkWsOrigin(mkReq('203.0.113.50', { host: 'deva.example.com' }))
    assert.deepEqual(o1, { action: 'allow' })
    console.log('  PASS 无 Origin →', JSON.stringify(o1))

    // 3.2 Origin 与 Host 一致（含默认端口 443/80 归一与大小写忽略）→ allow
    const o2a = checkWsOrigin(
      mkReq('203.0.113.50', { origin: 'https://Deva.Example.com:443', host: 'deva.example.com' })
    )
    const o2b = checkWsOrigin(
      mkReq('203.0.113.50', { origin: 'http://deva.example.com', host: 'deva.example.com:80' })
    )
    assert.deepEqual(o2a, { action: 'allow' })
    assert.deepEqual(o2b, { action: 'allow' })
    console.log('  PASS Origin 与 Host 一致（含 80/443 归一）→', JSON.stringify(o2a))

    // 3.3 对端回环、Host=127.0.0.1:8790、Origin=https://deva.example.com → allow + warn（只警告一次）
    const beforeWarnCount = capturedWarns.length
    const o3First = checkWsOrigin(
      mkReq('127.0.0.1', { host: '127.0.0.1:8790', origin: 'https://deva.example.com' })
    )
    const afterFirstCount = capturedWarns.length
    const o3Second = checkWsOrigin(
      mkReq('127.0.0.1', { host: '127.0.0.1:8790', origin: 'https://deva.example.com' })
    )
    const afterSecondCount = capturedWarns.length
    assert.equal(o3First.action, 'allow')
    assert.ok(o3First.warn && o3First.warn.includes('反代未透传 Host'))
    assert.equal(o3Second.action, 'allow')
    assert.equal(afterFirstCount - beforeWarnCount, 1, '首次应打印 1 条 console.warn')
    assert.equal(afterSecondCount - afterFirstCount, 0, '第二次不应重复打印 console.warn')
    console.log(
      '  PASS 回环 + Host=127.0.0.1:8790 + Origin=https://deva.example.com →',
      `action=${o3First.action}, warnPrinted=${afterSecondCount - beforeWarnCount}次（调用2次）`
    )

    // 3.4 对端公网、Host=deva.example.com、Origin=https://evil.example → deny
    const o4 = checkWsOrigin(
      mkReq('203.0.113.50', { host: 'deva.example.com', origin: 'https://evil.example' })
    )
    assert.deepEqual(o4, { action: 'deny' })
    console.log('  PASS 公网 + Host=deva.example.com + Origin=https://evil.example →', JSON.stringify(o4))

    // 3.5 同上但 DEVA_WEB_ORIGIN_CHECK=warn → allow + warn
    process.env.DEVA_WEB_ORIGIN_CHECK = 'warn'
    const o5 = checkWsOrigin(
      mkReq('203.0.113.50', { host: 'deva.example.com', origin: 'https://evil.example' })
    )
    assert.equal(o5.action, 'allow')
    assert.ok(o5.warn)
    console.log('  PASS 同上 + DEVA_WEB_ORIGIN_CHECK=warn →', `action=${o5.action}, warn="${o5.warn}"`)
    delete process.env.DEVA_WEB_ORIGIN_CHECK

    // 3.6 命中 DEVA_WEB_ALLOWED_ORIGINS → allow
    process.env.DEVA_WEB_ALLOWED_ORIGINS = 'https://other.example.com, https://EVIL.EXAMPLE/'
    const o6 = checkWsOrigin(
      mkReq('203.0.113.50', { host: 'deva.example.com', origin: 'https://evil.example' })
    )
    assert.deepEqual(o6, { action: 'allow' })
    console.log('  PASS 命中 DEVA_WEB_ALLOWED_ORIGINS →', JSON.stringify(o6))
    delete process.env.DEVA_WEB_ALLOWED_ORIGINS

    // 确认所有日志均未泄露 Cookie/token，且均含提示字段
    for (const line of capturedWarns) {
      assert.ok(!line.includes('TOP_SECRET_TOKEN_999'), '日志绝不能包含 Cookie/token')
      assert.ok(!line.includes('\n'), '单次告警应为单行')
      assert.ok(line.includes('DEVA_WEB_ALLOWED_ORIGINS'), '日志应包含 DEVA_WEB_ALLOWED_ORIGINS 提示')
    }
    console.log('  PASS 告警日志核验：共', capturedWarns.length, '条，全部单行且零 Cookie/token 泄露')
  } finally {
    console.warn = origWarn
  }

  // ── 验收 4：secrets.json 权限 0600、无 .tmp、5 并发 setSecret ──────────────
  console.log('\n=== [验收 4] secrets.ts 原子权限与 5 并发写入 ===')
  const fakeHome = join(workDir, 'deva-home')
  const childScript = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { setSecret, getSecret } = require(${JSON.stringify(secretsHarnessOut)});
    (async () => {
      const results = await Promise.all([
        setSecret('prov_1', 'sk-secret-1'),
        setSecret('prov_2', 'sk-secret-2'),
        setSecret('prov_3', 'sk-secret-3'),
        setSecret('prov_4', 'sk-secret-4'),
        setSecret('prov_5', 'sk-secret-5')
      ]);
      for (const r of results) assert.equal(r.ok, true);
      const files = fs.readdirSync(process.env.DEVA_HOME);
      const tmps = files.filter((f) => f.includes('.tmp'));
      const secretsPath = path.join(process.env.DEVA_HOME, 'secrets.json');
      const mode = (fs.statSync(secretsPath).mode & 0o777).toString(8);
      const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      const keys = Object.keys(parsed).sort();
      for (let i = 1; i <= 5; i++) {
        const plain = await getSecret('prov_' + i);
        assert.equal(plain, 'sk-secret-' + i);
      }
      console.log(JSON.stringify({ mode, tmpCount: tmps.length, keys }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `
  const secRes = await new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', childScript], {
      env: { ...process.env, DEVA_HOME: fakeHome }
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? res(JSON.parse(out.trim())) : rej(new Error(err || `exit ${code}`))))
  })
  assert.equal(secRes.mode, '600')
  assert.equal(secRes.tmpCount, 0)
  assert.deepEqual(secRes.keys, ['prov_1', 'prov_2', 'prov_3', 'prov_4', 'prov_5'])
  console.log(
    `  PASS secrets.json 权限=${secRes.mode}, 残留.tmp=${secRes.tmpCount}, 并发5键=${JSON.stringify(secRes.keys)}`
  )

  // ── 验收 5：删掉 web-secret.key（保留 secrets.json）后启动服务 ─────────────
  console.log('\n=== [验收 5] 删掉 web-secret.key 后启动服务与 decryptString 单次告警 ===')
  rmSync(join(fakeHome, 'web-secret.key'))
  assert.equal(readdirSync(fakeHome).includes('secrets.json'), true)

  // 5.1 启动真实的构建产物 out/web/index.cjs
  const serverEntry = join(desktopRoot, 'out', 'web', 'index.cjs')
  const freePort = await getFreePort()
  const srvProc = spawn(process.execPath, [serverEntry], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      DEVA_HOME: fakeHome,
      DEVA_WEB_HOST: '127.0.0.1',
      DEVA_WEB_PORT: String(freePort),
      DEVA_WEB_STATIC: join(desktopRoot, 'out', 'web', 'renderer')
    }
  })

  let srvStdout = ''
  let srvStderr = ''
  srvProc.stdout.on('data', (d) => (srvStdout += d.toString('utf8')))
  srvProc.stderr.on('data', (d) => (srvStderr += d.toString('utf8')))

  try {
    // 等待监听就绪（最长 8s）
    const deadline = Date.now() + 8000
    while (!srvStdout.includes('listening on http://') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(srvStdout.includes('listening on http://'), `服务未正常监听: stdout=${srvStdout} stderr=${srvStderr}`)
    assert.ok(
      srvStderr.includes('已有密文但密钥文件缺失') && srvStderr.includes('web-secret.key'),
      `stderr 未见到缺 key 警告: ${srvStderr}`
    )
    const loginStatus = await httpGetStatus(freePort, '/login')
    assert.equal(loginStatus, 200)
    const wsDenyStatus = await rawWsUpgradeStatus(freePort, {
      Host: `deva.example.com`,
      Origin: 'https://evil.example'
    })
    assert.equal(wsDenyStatus, 403)
    console.log('  PASS 启动告警 stderr →', srvStderr.trim().split('\n')[0])
    console.log(`  PASS 服务正常启动监听 :${freePort}，GET /login → ${loginStatus}，跨站 WS /ws → ${wsDenyStatus}`)
  } finally {
    srvProc.kill('SIGTERM')
    await new Promise((r) => srvProc.once('close', r))
  }

  // 5.2 验证新 key 下读取旧密文：返回 null，且 decryptString 的 console.error 只打印 1 次
  const decryptCheckScript = `
    const assert = require('node:assert/strict');
    const { getSecret } = require(${JSON.stringify(secretsHarnessOut)});
    (async () => {
      const v1 = await getSecret('prov_1');
      const v2 = await getSecret('prov_2');
      const v3 = await getSecret('prov_3');
      assert.equal(v1, null);
      assert.equal(v2, null);
      assert.equal(v3, null);
      console.log('NULL_OK');
    })().catch((e) => { console.error(e); process.exit(1); });
  `
  const decOut = await new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', decryptCheckScript], {
      env: { ...process.env, DEVA_HOME: fakeHome }
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? res({ out: out.trim(), err: err.trim() }) : rej(new Error(err))))
  })
  const errLines = decOut.err.split('\n').filter(Boolean)
  assert.equal(decOut.out, 'NULL_OK')
  assert.equal(errLines.length, 1, `连续 3 次解密失败应只打印 1 次 console.error，实际: ${decOut.err}`)
  console.log('  PASS 旧密文连续解密 3 次均返回 null，console.error 仅打印 1 次 →', errLines[0])

  console.log('\nALL SECURITY HARDENING CHECKS PASSED')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
