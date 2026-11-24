import type { LensEvent } from '@thruppence/core'

// Numeric values of the SDK's OsEventTypeList, kept local so this module stays pure and testable.
const CLICK = 0
const SCROLL_TOP = 1
const SCROLL_BOTTOM = 2
const DOUBLE = 3
const FG_ENTER = 4
const FG_EXIT = 5
const ABNORMAL_EXIT = 6
const SYSTEM_EXIT = 7
const LONG_PRESS = 9
const LONG_RELEASE = 10

export interface RawEnvelope {
  eventType?: number
  currentSelectItemIndex?: number
  eventSource?: number
}

export interface RawEvent {
  listEvent?: RawEnvelope
  textEvent?: RawEnvelope
  sysEvent?: RawEnvelope
  audioEvent?: { audioPcm?: Uint8Array }
}

export type Lifecycle = 'foreground' | 'background' | 'exit'

export interface Normalized {
  lens: LensEvent[]
  lifecycle?: Lifecycle
  pcm?: Uint8Array
}

/**
 * Turns one Even Hub event into lens events.
 * A tap arrives with `eventType` undefined (protobuf drops the zero), so the
 * default is resolved inside each envelope; double-tap is checked first.
 */
export function normalize(e: RawEvent): Normalized {
  const out: Normalized = { lens: [] }
  if (e.audioEvent?.audioPcm) out.pcm = e.audioEvent.audioPcm

  if (e.listEvent) {
    const t = e.listEvent.eventType ?? CLICK
    if (t === DOUBLE) out.lens.push({ k: 'input', g: 'back' })
    else if (t === CLICK) out.lens.push({ k: 'select', index: e.listEvent.currentSelectItemIndex ?? 0 })
    else if (t === LONG_PRESS) out.lens.push({ k: 'input', g: 'hold' })
    else if (t === LONG_RELEASE) out.lens.push({ k: 'input', g: 'release' })
    return out
  }

  const env = e.textEvent ?? e.sysEvent
  if (!env) return out
  const t = env.eventType ?? CLICK
  switch (t) {
    case DOUBLE:
      out.lens.push({ k: 'input', g: 'back' })
      break
    case CLICK:
      out.lens.push({ k: 'input', g: 'tap' })
      break
    case SCROLL_TOP:
      out.lens.push({ k: 'input', g: 'up' })
      break
    case SCROLL_BOTTOM:
      out.lens.push({ k: 'input', g: 'down' })
      break
    case LONG_PRESS:
      out.lens.push({ k: 'input', g: 'hold' })
      break
    case LONG_RELEASE:
      out.lens.push({ k: 'input', g: 'release' })
      break
    case FG_ENTER:
      out.lifecycle = 'foreground'
      break
    case FG_EXIT:
      out.lifecycle = 'background'
      break
    case ABNORMAL_EXIT:
    case SYSTEM_EXIT:
      out.lifecycle = 'exit'
      break
  }
  return out
}

/** Swipes come in bursts on the touch strip; one step per 300 ms is what a person means. */
export class SwipeThrottle {
  private last = 0
  constructor(private readonly gapMs = 300) {}
  pass(ev: LensEvent, now: number): boolean {
    if (ev.k !== 'input' || (ev.g !== 'up' && ev.g !== 'down')) return true
    if (now - this.last < this.gapMs) return false
    this.last = now
    return true
  }
}
