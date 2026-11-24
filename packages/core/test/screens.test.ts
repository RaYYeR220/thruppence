import { describe, expect, it } from 'vitest'
import { initialState, type LensState } from '../src/lens/machine'
import { validatePage } from '../src/lens/model'
import { renderScreen } from '../src/lens/screens'
import { ask, LIMITS } from './fixtures'

const base = (): LensState => ({ ...initialState(0), limits: LIMITS, name: 'Yehor', queue: [ask()] })

const states: [string, LensState][] = [
  ['idle', { ...base(), queue: [], screen: { s: 'idle' } }],
  ['boot', { ...base(), screen: { s: 'boot', until: 1 } }],
  ['ask', { ...base(), screen: { s: 'ask' } }],
  ['ask warn', { ...base(), queue: [ask({ risk: { level: 'warn', reasons: [{ code: 'new_recipient' }] } })], screen: { s: 'ask' } }],
  ['ask block', { ...base(), queue: [ask({ risk: { level: 'block', reasons: [{ code: 'address_mismatch' }] } })], screen: { s: 'ask' } }],
  ['ask split', { ...base(), queue: [ask({ chat: { id: 'g', kind: 'group', title: 'Friday dinner' }, split: { totalNano: '6000000000', people: 4 } })], screen: { s: 'ask' } }],
  ['options', { ...base(), screen: { s: 'options', index: 1 } }],
  ['listening', { ...base(), screen: { s: 'listening', askId: 'a1', transcript: 'pay one and say enjoy', released: false } }],
  ['confirm', { ...base(), screen: { s: 'confirm_voice', askId: 'a1', intent: { kind: 'pay', amountNano: '1000000000', reply: 'enjoy!' } } }],
  ['paying', { ...base(), now: 1200, screen: { s: 'paying', askId: 'a1', amountNano: '1500000000', dest: 'x', since: 0, signed: true } }],
  ['paid', { ...base(), screen: { s: 'paid', name: 'Dima', amountNano: '1500000000', ms: 2800, receiptSent: true, until: 9 } }],
  ['notice', { ...base(), screen: { s: 'notice', title: 'Not paid', detail: 'The request changed after you saw it.', until: 9 } }],
  ['incoming', { ...base(), screen: { s: 'incoming', fromName: 'Dima', amountNano: '25000000000', memo: 'paid back', until: 9 } }],
  ['balance', { ...base(), screen: { s: 'balance', until: 9 } }],
]

describe('lens screens', () => {
  it.each(states)('%s renders a valid Even Hub page', (_, st) => {
    expect(validatePage(renderScreen(st))).toEqual([])
  })

  it('idle is dark: one empty capture box', () => {
    const page = renderScreen(states[0]![1])
    expect(page.boxes).toHaveLength(1)
    expect(page.boxes[0]).toMatchObject({ type: 'text', content: '', capture: true })
  })

  it('ask shows who, why, how much and to which wallet', () => {
    const page = renderScreen(states[2]![1])
    const all = JSON.stringify(page)
    expect(all).toContain('Dima asks')
    expect(all).toContain('concert tickets')
    expect(all).toContain('"value":"1.5"')
    expect(all).toContain('wallet on their profile')
  })

  it('blocked ask says why and never says "tap to pay"', () => {
    const all = JSON.stringify(renderScreen(states[4]![1]))
    expect(all).toContain("Can't pay")
    expect(all).not.toContain('tap to pay')
    expect(all).not.toContain('Tap ring to pay')
  })
})
