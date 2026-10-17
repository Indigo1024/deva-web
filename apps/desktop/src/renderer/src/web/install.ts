/**
 * Web 桥接安装（模块副作用）：在任何应用代码之前求值。
 * 幂等：Electron 环境（preload 已装 window.deva）下原样跳过。
 */
import { installWebBridge } from './boot'

installWebBridge()
