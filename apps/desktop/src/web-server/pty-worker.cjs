/**
 * pty Worker 引导（CJS）：以 worker_threads 方式运行 pty-host（原 Electron UtilityProcess 宿主）。
 *
 * worker_threads 没有 process.parentPort —— 此处补齐 MessagePort 语义：
 *   process.parentPort.postMessage(m)            → parentPort.postMessage(m)
 *   process.parentPort.on('message', cb)         → parentPort.on('message', d => cb({ data: d }))
 * 然后 require 目标宿主模块（构建产物 pty-host.cjs）。
 */
const { parentPort, workerData } = require('node:worker_threads')

process.parentPort = {
  postMessage: (m) => parentPort.postMessage(m),
  on: (_evt, cb) => {
    parentPort.on('message', (data) => cb({ data }))
  },
  start: () => {},
  close: () => {}
}

try {
  require(workerData.modulePath)
} catch (err) {
  console.error('[deva-web pty worker] 载入失败:', err)
  process.exit(1)
}
