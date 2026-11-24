import { describe, expect, it } from 'vitest'
import { initialState, reduce, type LensEvent, type LensState } from '../src/lens/machine'
import type { PayParams } from '../src/types'
import { ask, LIMITS } from './fixtures'

function run(st: LensState, ...evs: LensEvent[]) {
  let state = st
  const effects = []
  for (const ev of evs) {
    const out = reduce(state, ev)
    state = out.state
    effects.push(...out.effects)
  }
  return { state, effects }
}

const s0 = () => run(initialState(0), { k: 'server', m: { t: 'hello_ok', name: 'Yehor', limits: LIMITS } }).state
const params = (over: Partial<PayParams> = {}): PayParams => ({
  askId: 'a1',
  networkId: -3,
  extAddress: 'EQext',
  seqno: 7,
  validUntil: 1000,
  dest: ask().recipient!.address,
  amountNano: ask().amountNano,
  bounce: false,
  requestId: '42',
  comment: 'Thruppence #42 · concert tickets',
  ...over,
})

describe('lens machine', () => {
  it('stays dark until an ask arrives, then shows it', () => {
    const st = run(s0(), { k: 'tick', now: 10_000 }).state
    expect(st.screen.s).toBe('idle')
    expect(run(st, { k: 'server', m: { t: 'ask', ask: ask() } }).state.screen.s).toBe('ask')
  })

  it('ignores a duplicate ask', () => {
    const { state } = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'server', m: { t: 'ask', ask: ask() } })
    expect(state.queue).toHaveLength(1)
  })

  it('tap on an ask sends one pay decision and moves to paying', () => {
    const { state, effects } = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'input', g: 'tap' }, { k: 'input', g: 'tap' })
    expect(state.screen.s).toBe('paying')
    expect(effects.filter(e => e.k === 'send')).toEqual([
      { k: 'send', m: { t: 'decision', askId: 'a1', action: 'pay', amountNano: '1500000000' } },
    ])
  })

  it('signs only when the params match what the wearer saw', () => {
    const paying = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'input', g: 'tap' }).state
    const ok = reduce(paying, { k: 'server', m: { t: 'pay_params', params: params() } })
    expect(ok.effects).toEqual([{ k: 'sign', params: params() }])
    const swapped = reduce(paying, { k: 'server', m: { t: 'pay_params', params: params({ dest: 'UQattacker' }) } })
    expect(swapped.effects.some(e => e.k === 'sign')).toBe(false)
    expect(swapped.state.screen.s).toBe('notice')
    const bigger = reduce(paying, { k: 'server', m: { t: 'pay_params', params: params({ amountNano: '1900000000' }) } })
    expect(bigger.effects.some(e => e.k === 'sign')).toBe(false)
  })

  it('signs at most once per ask', () => {
    const paying = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'input', g: 'tap' }).state
    const { effects } = run(paying, { k: 'server', m: { t: 'pay_params', params: params() } }, { k: 'server', m: { t: 'pay_params', params: params() } })
    expect(effects.filter(e => e.k === 'sign')).toHaveLength(1)
  })

  it('paid flash, then back to dark', () => {
    let st = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'input', g: 'tap' }).state
    st = run(st, { k: 'server', m: { t: 'paid', askId: 'a1', txHash: 'h', ms: 2800, receiptSent: true } }).state
    expect(st.screen).toMatchObject({ s: 'paid', name: 'Dima', amountNano: '1500000000' })
    expect(st.queue).toHaveLength(0)
    st = run(st, { k: 'tick', now: 60_000 }).state
    expect(st.screen.s).toBe('idle')
  })

  it('a blocked ask cannot be paid; tap opens decline/later only', () => {
    const blocked = ask({ risk: { level: 'block', reasons: [{ code: 'address_mismatch' }] } })
    const { state, effects } = run(s0(), { k: 'server', m: { t: 'ask', ask: blocked } }, { k: 'input', g: 'tap' })
    expect(state.screen).toEqual({ s: 'options', index: 0 })
    expect(effects).toEqual([])
    const sel = reduce(state, { k: 'select', index: 0 })
    expect(sel.effects).toEqual([{ k: 'send', m: { t: 'decision', askId: 'a1', action: 'decline' } }])
  })

  it('refuses to pay when the glasses are off', () => {
    const { state, effects } = run(s0(), { k: 'wearing', on: false }, { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'input', g: 'tap' })
    expect(state.screen.s).toBe('notice')
    expect(effects).toEqual([])
  })

  it('later moves the ask to the back and goes dark', () => {
    const { state } = run(
      s0(),
      { k: 'server', m: { t: 'ask', ask: ask() } },
      { k: 'server', m: { t: 'ask', ask: ask({ askId: 'a2', from: { tgId: '2', name: 'Mia' } }) } },
      { k: 'input', g: 'down' },
      { k: 'select', index: 2 },
    )
    expect(state.queue.map(a => a.askId)).toEqual(['a2', 'a1'])
    expect(state.screen.s).toBe('idle')
  })

  it('hold to talk: mic on, release: mic off, intent → confirm → pay other amount', () => {
    let out = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'input', g: 'hold' }, { k: 'input', g: 'release' })
    expect(out.effects).toContainEqual({ k: 'mic', on: true })
    expect(out.effects).toContainEqual({ k: 'mic', on: false })
    out = run(out.state, { k: 'server', m: { t: 'voice_intent', askId: 'a1', intent: { kind: 'pay', amountNano: '1000000000', reply: 'enjoy!' } } }, { k: 'input', g: 'tap' })
    expect(out.state.screen).toMatchObject({ s: 'paying', amountNano: '1000000000' })
    expect(out.effects).toContainEqual({ k: 'send', m: { t: 'decision', askId: 'a1', action: 'pay', amountNano: '1000000000', reply: 'enjoy!' } })
  })

  it('double tap at the root exits the app', () => {
    expect(run(s0(), { k: 'tick', now: 10_000 }, { k: 'input', g: 'back' }).effects).toEqual([{ k: 'exit' }])
  })

  it('cancel removes the current ask', () => {
    const { state } = run(s0(), { k: 'server', m: { t: 'ask', ask: ask() } }, { k: 'server', m: { t: 'cancel', askId: 'a1' } })
    expect(state.queue).toHaveLength(0)
    expect(state.screen.s).toBe('idle')
  })
})
