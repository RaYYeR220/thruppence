import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { drawImageSpec, type Box, type ImageBox, type LensPage } from '@thruppence/core'

const borderLevel = (b: number) => Math.min(15, b * 3 + 3)

function structureKey(page: LensPage): string {
  return page.layout + '|' + page.boxes.map(b => `${b.type}:${b.name}:${b.x},${b.y},${b.w},${b.h}:${b.capture ? 1 : 0}`).join(';')
}

function toContainers(page: LensPage) {
  const textObject: TextContainerProperty[] = []
  const listObject: ListContainerProperty[] = []
  const imageObject: ImageContainerProperty[] = []
  page.boxes.forEach((b, i) => {
    const common = { xPosition: b.x, yPosition: b.y, width: b.w, height: b.h, containerID: i + 1, containerName: b.name }
    if (b.type === 'text') {
      textObject.push(
        new TextContainerProperty({
          ...common,
          content: b.content,
          textColor: b.brightness,
          borderWidth: b.border?.width ?? 0,
          borderColor: b.border ? borderLevel(b.border.brightness) : 0,
          borderRadius: b.border?.radius ?? 0,
          paddingLength: b.padding ?? 0,
          isEventCapture: b.capture ? 1 : 0,
        }),
      )
    } else if (b.type === 'list') {
      listObject.push(
        new ListContainerProperty({
          ...common,
          borderWidth: 0,
          paddingLength: 0,
          isEventCapture: b.capture ? 1 : 0,
          itemContainer: new ListItemContainerProperty({ itemCount: b.items.length, itemWidth: b.w, isItemSelectBorderEn: 1, itemName: b.items }),
        }),
      )
    } else {
      imageObject.push(new ImageContainerProperty(common))
    }
  })
  return { containerTotalNum: page.boxes.length, textObject, listObject, imageObject }
}

async function pngFor(b: ImageBox): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(b.w, b.h)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, b.w, b.h)
  drawImageSpec(ctx, b.spec, 0, 0, b.w, b.h, '#fff')
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Pushes lens pages to G2 with as little Bluetooth traffic as possible:
 * same layout → only changed text is upgraded in place (flicker-free);
 * new layout → one rebuild; images are sent one at a time, never in parallel.
 */
export class LensRenderer {
  private shown: LensPage | null = null
  private key = ''
  private started = false
  private queue: Promise<void> = Promise.resolve()
  private wanted: LensPage | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly debounceMs = 120,
  ) {}

  /** Must run before anything else touches the glasses (including the microphone). */
  async start(first: LensPage) {
    const c = toContainers(first)
    await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(c))
    this.started = true
    this.shown = first
    this.key = structureKey(first)
    await this.sendImages(first, null)
  }

  render(page: LensPage) {
    this.wanted = page
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.wanted!
      this.queue = this.queue.then(() => this.apply(next)).catch(err => console.warn('render failed', err))
    }, this.debounceMs)
  }

  private async apply(page: LensPage) {
    if (!this.started) return
    const prev = this.shown
    const key = structureKey(page)
    if (key !== this.key) {
      await this.bridge.rebuildPageContainer(new RebuildPageContainer(toContainers(page)))
      this.key = key
      this.shown = page
      await this.sendImages(page, null)
      return
    }
    const listChanged = page.boxes.some((b, i) => b.type === 'list' && JSON.stringify(b.items) !== JSON.stringify((prev!.boxes[i] as Box & { items?: string[] }).items))
    if (listChanged) {
      await this.bridge.rebuildPageContainer(new RebuildPageContainer(toContainers(page)))
      this.shown = page
      await this.sendImages(page, null)
      return
    }
    for (let i = 0; i < page.boxes.length; i++) {
      const b = page.boxes[i]!
      const old = prev!.boxes[i]!
      if (b.type === 'text' && old.type === 'text' && (b.content !== old.content || b.brightness !== old.brightness)) {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: i + 1, containerName: b.name, content: b.content, ...(b.brightness !== old.brightness ? { textColor: b.brightness } : {}) }),
        )
      }
    }
    await this.sendImages(page, prev)
    this.shown = page
  }

  private async sendImages(page: LensPage, prev: LensPage | null) {
    for (let i = 0; i < page.boxes.length; i++) {
      const b = page.boxes[i]!
      if (b.type !== 'image') continue
      const old = prev?.boxes[i]
      if (old && old.type === 'image' && JSON.stringify(old.spec) === JSON.stringify(b.spec)) continue
      await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: i + 1, containerName: b.name, imageData: await pngFor(b) }))
    }
  }
}
