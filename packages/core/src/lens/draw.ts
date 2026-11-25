import type { Brightness, ImageSpec, LensPage } from './model'
import { LENS_H, LENS_W, LINE_H } from './model'

/** G2 waveguide green at full brightness. Lower levels are darker steps of it. */
export const LENS_GREEN: [number, number, number] = [0x3c, 0xfa, 0x44]

export function levelColor(b: Brightness, [r, g, bl] = LENS_GREEN): string {
  const k = [0, 0.32, 0.55, 0.78, 1][b]!
  return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(bl * k)})`
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * Draws an image box spec into (x, y, w, h). Used by the glasses app (into an
 * offscreen canvas that becomes the PNG sent to G2) and by the web lens.
 */
export function drawImageSpec(ctx: Ctx, spec: ImageSpec, x: number, y: number, w: number, h: number, color = levelColor(4)) {
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  if (spec.kind === 'amount') {
    let size = Math.floor(h * 0.86)
    ctx.textBaseline = 'alphabetic'
    const unitSize = Math.max(16, Math.floor(h * 0.24))
    const fits = () => {
      ctx.font = `600 ${size}px "Inter", "Helvetica Neue", Arial, sans-serif`
      const vw = ctx.measureText(spec.value).width
      ctx.font = `500 ${unitSize}px "Inter", "Helvetica Neue", Arial, sans-serif`
      return vw + 10 + ctx.measureText(spec.unit).width <= w
    }
    while (size > 24 && !fits()) size -= 4
    ctx.font = `600 ${size}px "Inter", "Helvetica Neue", Arial, sans-serif`
    const base = y + Math.floor(h * 0.82)
    ctx.fillText(spec.value, x, base)
    const vw = ctx.measureText(spec.value).width
    ctx.font = `500 ${unitSize}px "Inter", "Helvetica Neue", Arial, sans-serif`
    ctx.fillText(spec.unit, x + vw + 10, base)
  } else {
    const s = Math.min(w, h)
    const cx = x + s / 2
    const cy = y + s / 2
    ctx.lineWidth = Math.max(4, s * 0.07)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.arc(cx, cy, s * 0.44, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    if (spec.mark === 'check') {
      ctx.moveTo(cx - s * 0.2, cy + s * 0.01)
      ctx.lineTo(cx - s * 0.05, cy + s * 0.16)
      ctx.lineTo(cx + s * 0.22, cy - s * 0.14)
    } else {
      ctx.moveTo(cx - s * 0.15, cy - s * 0.15)
      ctx.lineTo(cx + s * 0.15, cy + s * 0.15)
      ctx.moveTo(cx + s * 0.15, cy - s * 0.15)
      ctx.lineTo(cx - s * 0.15, cy + s * 0.15)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** Wraps text into lines that fit `maxW` with the current font. */
function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word
      if (ctx.measureText(t).width <= maxW || !line) line = t
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Paints a whole lens page the way the waveguide shows it: black is clear
 * glass, only lit pixels carry colour. Used by the web lens and the docs.
 */
export function drawPage(ctx: Ctx, page: LensPage, opts: { scale?: number; listIndex?: number } = {}) {
  const s = opts.scale ?? 1
  ctx.save()
  ctx.scale(s, s)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, LENS_W, LENS_H)
  for (const b of page.boxes) {
    if (b.type === 'image') {
      drawImageSpec(ctx, b.spec, b.x, b.y, b.w, b.h)
      continue
    }
    ctx.font = '400 21px "Inter", "Helvetica Neue", Arial, sans-serif'
    ctx.textBaseline = 'top'
    if (b.type === 'text') {
      const pad = b.padding ?? 0
      const bw = b.border?.width ?? 0
      if (bw > 0 && b.border) {
        ctx.strokeStyle = levelColor(b.border.brightness)
        ctx.lineWidth = bw
        const r = b.border.radius
        ctx.beginPath()
        ctx.roundRect(b.x + bw / 2, b.y + bw / 2, b.w - bw, b.h - bw, r)
        ctx.stroke()
      }
      ctx.fillStyle = levelColor(b.brightness)
      const maxW = b.w - 2 * (pad + bw)
      const lines = wrap(ctx, b.content, maxW)
      const maxLines = Math.max(1, Math.floor((b.h - 2 * (pad + bw)) / LINE_H))
      const shown = lines.slice(0, maxLines)
      // The web font runs wider than the firmware font: never draw past the box, end with an ellipsis instead.
      shown.forEach((ln, i) => {
        const last = i === shown.length - 1 && lines.length > maxLines
        let t = last ? ln + '…' : ln
        while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…'
        ctx.fillText(t, b.x + pad + bw, b.y + pad + bw + 3 + i * LINE_H)
      })
    } else {
      const sel = opts.listIndex ?? b.selected
      b.items.forEach((it, i) => {
        const y = b.y + i * 40
        if (y + 40 > b.y + b.h) return
        if (i === sel) {
          ctx.strokeStyle = levelColor(4)
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.roundRect(b.x + 1, y + 2, b.w - 2, 36, 6)
          ctx.stroke()
        }
        ctx.fillStyle = levelColor(i === sel ? 4 : 3)
        ctx.fillText(it, b.x + 12, y + 9)
      })
    }
  }
  ctx.restore()
}
