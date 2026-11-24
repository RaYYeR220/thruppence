import { describe, expect, it } from 'vitest'
import { normalize, SwipeThrottle } from '../src/input'

describe('normalize', () => {
  it('a tap arrives with eventType undefined and still counts as a tap', () => {
    expect(normalize({ sysEvent: { eventSource: 2 } }).lens).toEqual([{ k: 'input', g: 'tap' }])
  })
  it('double tap is back, in any envelope', () => {
    expect(normalize({ sysEvent: { eventType: 3 } }).lens).toEqual([{ k: 'input', g: 'back' }])
    expect(normalize({ textEvent: { eventType: 3 } }).lens).toEqual([{ k: 'input', g: 'back' }])
    expect(normalize({ listEvent: { eventType: 3 } }).lens).toEqual([{ k: 'input', g: 'back' }])
  })
  it('swipes come through the text envelope', () => {
    expect(normalize({ textEvent: { eventType: 1 } }).lens).toEqual([{ k: 'input', g: 'up' }])
    expect(normalize({ textEvent: { eventType: 2 } }).lens).toEqual([{ k: 'input', g: 'down' }])
  })
  it('a list tap selects the index; index 0 arrives undefined too', () => {
    expect(normalize({ listEvent: { currentSelectItemIndex: 2 } }).lens).toEqual([{ k: 'select', index: 2 }])
    expect(normalize({ listEvent: {} }).lens).toEqual([{ k: 'select', index: 0 }])
  })
  it('long press and release drive push-to-talk', () => {
    expect(normalize({ sysEvent: { eventType: 9 } }).lens).toEqual([{ k: 'input', g: 'hold' }])
    expect(normalize({ sysEvent: { eventType: 10 } }).lens).toEqual([{ k: 'input', g: 'release' }])
  })
  it('lifecycle and audio are reported separately', () => {
    expect(normalize({ sysEvent: { eventType: 4 } }).lifecycle).toBe('foreground')
    expect(normalize({ sysEvent: { eventType: 7 } }).lifecycle).toBe('exit')
    const pcm = new Uint8Array([1, 2])
    const n = normalize({ audioEvent: { audioPcm: pcm } })
    expect(n.pcm).toBe(pcm)
    expect(n.lens).toEqual([])
  })
})

describe('SwipeThrottle', () => {
  it('lets one swipe through per 300 ms, never throttles taps', () => {
    const t = new SwipeThrottle()
    expect(t.pass({ k: 'input', g: 'down' }, 1000)).toBe(true)
    expect(t.pass({ k: 'input', g: 'down' }, 1100)).toBe(false)
    expect(t.pass({ k: 'input', g: 'tap' }, 1150)).toBe(true)
    expect(t.pass({ k: 'input', g: 'up' }, 1400)).toBe(true)
  })
})
