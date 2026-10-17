/**
 * nativeImage 的纯 JS 替代（Deva Web 版）。
 *
 * Electron 的 nativeImage 只可靠解码 PNG / JPEG —— 这里用 pngjs + jpeg-js 对齐同一语义：
 *   createFromBuffer：PNG/JPEG 解得出就给像素；其它格式（GIF/WebP）解不出 → 空图（原字节照发，与服务端行为一致）
 *   resize：双线性重采样；toPNG / toJPEG(q)：重新编码
 *
 * image-read.ts 与 tray-icon.ts 的调用面（isEmpty/getSize/resize/toPNG/toJPEG/createEmpty）由此覆盖。
 */
import { PNG } from 'pngjs'
import * as jpegCodec from 'jpeg-js'

export class NativeImage {
  private w: number
  private h: number
  private data: Buffer | null // RGBA，宽度*高度*4

  constructor(w = 0, h = 0, data: Buffer | null = null) {
    this.w = w
    this.h = h
    this.data = data
  }

  /** 从字节解图：先按 PNG 试，再按 JPEG 试，都失败给空图。 */
  static createFromBuffer(buf: Buffer): NativeImage {
    try {
      const png = PNG.sync.read(buf)
      return new NativeImage(png.width, png.height, Buffer.from(png.data))
    } catch {
      /* 非 PNG */
    }
    try {
      const img = jpegCodec.decode(buf, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: 512
      })
      return new NativeImage(img.width, img.height, Buffer.from(img.data))
    } catch {
      /* 非 JPEG */
    }
    return new NativeImage()
  }

  static createEmpty(): NativeImage {
    return new NativeImage()
  }

  isEmpty(): boolean {
    return !this.data || this.w <= 0 || this.h <= 0
  }

  getSize(): { width: number; height: number } {
    return { width: this.w, height: this.h }
  }

  /** 仅支持尺寸变换（Electron 同 api 的 quality 参数被忽略——本替代只用于图像整形缩放）。 */
  resize(opts: { width: number; height: number }): NativeImage {
    if (this.isEmpty() || !this.data) return NativeImage.createEmpty()
    const tw = Math.max(1, Math.round(opts.width))
    const th = Math.max(1, Math.round(opts.height))
    if (tw === this.w && th === this.h) return new NativeImage(this.w, this.h, Buffer.from(this.data))
    return bilinear(this.data, this.w, this.h, tw, th)
  }

  toPNG(): Buffer {
    if (this.isEmpty() || !this.data) return Buffer.alloc(0)
    const png = new PNG({ width: this.w, height: this.h })
    this.data.copy(png.data)
    return PNG.sync.write(png)
  }

  toJPEG(quality: number): Buffer {
    if (this.isEmpty() || !this.data) return Buffer.alloc(0)
    const q = Math.max(1, Math.min(100, Math.round(quality)))
    const out = jpegCodec.encode(
      { data: this.data, width: this.w, height: this.h },
      q
    )
    return Buffer.from(out.data)
  }
}

/** 双线性重采样（RGBA）。 */
function bilinear(src: Buffer, sw: number, sh: number, dw: number, dh: number): NativeImage {
  const out = Buffer.alloc(dw * dh * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, y * yRatio)
    const y0 = Math.floor(sy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, x * xRatio)
      const x0 = Math.floor(sx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = sx - x0
      const o = (y * dw + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c]
        const p10 = src[(y0 * sw + x1) * 4 + c]
        const p01 = src[(y1 * sw + x0) * 4 + c]
        const p11 = src[(y1 * sw + x1) * 4 + c]
        const top = p00 + (p10 - p00) * fx
        const bottom = p01 + (p11 - p01) * fx
        out[o + c] = Math.round(top + (bottom - top) * fy)
      }
    }
  }
  return new NativeImage(dw, dh, out)
}
