import type { Ask, Limits, LensToServer, Nano, PayParams, ServerToLens, VoiceIntent } from '../types'
import { formatGram } from '../format'

/**
 * The lens state machine. Pure: (state, event) → { state, effects }.
 * The glasses app and the web lens both run this exact reducer, so what a
 * judge clicks on the website is what the wearer gets on G2.
 */

export type Gesture = 'tap' | 'up' | 'down' | 'hold' | 'release' | 'back'

export type OptionId = 'pay' | 'decline' | 'later' | 'amount' | 'reply'

export type Screen =
  | { s: 'boot'; until: number }
  | { s: 'idle' }
  | { s: 'ask' }
  | { s: 'options'; index: number }
  | { s: 'listening'; askId?: string; transcript: string; released: boolean }
  | { s: 'confirm_voice'; askId?: string; intent: VoiceIntent }
  | { s: 'paying'; askId: string; amountNano: Nano; dest: string; since: number; signed: boolean }
  | { s: 'paid'; name: string; amountNano: Nano; ms: number; receiptSent: boolean; until: number }
  | { s: 'notice'; title: string; detail: string; until: number }
  | { s: 'incoming'; fromName: string; amountNano: Nano; memo?: string; until: number }
  | { s: 'balance'; until: number }

export interface LensState {
  screen: Screen
  queue: Ask[]
  limits: Limits | null
  /** null when the device reports nothing (simulator, web lens). */
  wearing: boolean | null
  name: string
  demo: boolean
  now: number
}

export type LensEvent =
  | { k: 'server'; m: ServerToLens }
  | { k: 'input'; g: Gesture }
  /** Native list selection (Even Hub list containers report the index on tap). */
  | { k: 'select'; index: number }
  | { k: 'tick'; now: number }
  | { k: 'wearing'; on: boolean }

export type Effect =
  | { k: 'send'; m: LensToServer }
  | { k: 'sign'; params: PayParams }
  | { k: 'mic'; on: boolean }
  | { k: 'exit' }

export const FLASH_MS = { boot: 2500, paid: 4500, notice: 3500, incoming: 4500, balance: 4000 } as const
/** If TON has not confirmed within this window the lens says so (the payment may still land). */
export const PAY_TIMEOUT_MS = 60_000

export function initialState(now: number): LensState {
  return { screen: { s: 'idle' }, queue: [], limits: null, wearing: null, name: '', demo: false, now }
}

export function currentAsk(st: LensState): Ask | undefined {
  return st.queue[0]
}

export function optionsFor(ask: Ask): { id: OptionId; label: string }[] {
  if (ask.risk.level === 'block') {
    return [
      { id: 'decline', label: 'Not now' },
      { id: 'later', label: 'Later' },
    ]
  }
  return [
    { id: 'pay', label: `Pay ${formatGram(ask.amountNano)} GRAM` },
    { id: 'decline', label: 'Not now' },
    { id: 'later', label: 'Later' },
    { id: 'amount', label: 'Say another amount' },
    { id: 'reply', label: 'Reply by voice' },
  ]
}

interface Out {
  state: LensState
  effects: Effect[]
}

const send = (m: LensToServer): Effect => ({ k: 'send', m })

/** Where the lens goes when a flash ends or an ask is resolved. */
function rest(st: LensState): LensState {
  return { ...st, screen: st.queue.length ? { s: 'ask' } : { s: 'idle' } }
}

function notice(st: LensState, title: string, detail: string): LensState {
  return { ...st, screen: { s: 'notice', title, detail, until: st.now + FLASH_MS.notice } }
}

function dropAsk(st: LensState, askId: string): LensState {
  return { ...st, queue: st.queue.filter(a => a.askId !== askId) }
}

function startPay(st: LensState, ask: Ask, amountNano: Nano, reply?: string): Out {
  if (ask.risk.level === 'block') {
    return { state: { ...st, screen: { s: 'options', index: 0 } }, effects: [] }
  }
  if (st.wearing === false) {
    return { state: notice(st, 'Put your glasses on', 'Payments need the glasses on your face.'), effects: [] }
  }
  if (!ask.recipient) {
    return { state: notice(st, 'No wallet to pay', `${ask.from.name} has no TON wallet on their profile.`), effects: [] }
  }
  const screen: Screen = {
    s: 'paying',
    askId: ask.askId,
    amountNano,
    dest: ask.recipient.address,
    since: st.now,
    signed: false,
  }
  return {
    state: { ...st, screen },
    effects: [send({ t: 'decision', askId: ask.askId, action: 'pay', amountNano, ...(reply ? { reply } : {}) })],
  }
}

function chooseOption(st: LensState, id: OptionId): Out {
  const ask = currentAsk(st)
  if (!ask) return { state: rest(st), effects: [] }
  switch (id) {
    case 'pay':
      return startPay(st, ask, ask.amountNano)
    case 'decline': {
      const next = dropAsk(st, ask.askId)
      return {
        state: notice(next, 'Declined', `${ask.from.name} won't be paid.`),
        effects: [send({ t: 'decision', askId: ask.askId, action: 'decline' })],
      }
    }
    case 'later': {
      const queue = [...st.queue.slice(1), ask]
      return {
        state: { ...st, queue, screen: { s: 'idle' } },
        effects: [send({ t: 'decision', askId: ask.askId, action: 'later' })],
      }
    }
    case 'amount':
    case 'reply':
      return listen(st, ask.askId)
  }
}

function listen(st: LensState, askId?: string): Out {
  return {
    state: { ...st, screen: { s: 'listening', askId, transcript: '', released: false } },
    effects: [{ k: 'mic', on: true }, send({ t: 'ptt', state: 'start', ...(askId ? { askId } : {}) })],
  }
}

function onServer(st: LensState, m: ServerToLens): Out {
  switch (m.t) {
    case 'hello_ok': {
      const next: LensState = { ...st, name: m.name, limits: m.limits, demo: !!m.demo }
      if (next.screen.s === 'idle') next.screen = { s: 'boot', until: st.now + FLASH_MS.boot }
      return { state: next, effects: [] }
    }
    case 'ask': {
      if (st.queue.some(a => a.askId === m.ask.askId)) return { state: st, effects: [] }
      const queue = [...st.queue, m.ask]
      const calm = ['idle', 'boot', 'balance', 'incoming'].includes(st.screen.s)
      return { state: { ...st, queue, screen: calm ? { s: 'ask' } : st.screen }, effects: [] }
    }
    case 'cancel': {
      const wasCurrent = currentAsk(st)?.askId === m.askId
      const next = dropAsk(st, m.askId)
      if (wasCurrent && (st.screen.s === 'ask' || st.screen.s === 'options')) return { state: rest(next), effects: [] }
      return { state: next, effects: [] }
    }
    case 'pay_params': {
      const sc = st.screen
      if (sc.s !== 'paying' || sc.askId !== m.params.askId || sc.signed) return { state: st, effects: [] }
      // The device signs only what the wearer saw: same recipient, same amount.
      if (m.params.dest !== sc.dest || m.params.amountNano !== sc.amountNano) {
        return {
          state: notice(st, 'Not paid', 'The request changed after you saw it.'),
          effects: [send({ t: 'decision', askId: sc.askId, action: 'later' })],
        }
      }
      return { state: { ...st, screen: { ...sc, signed: true } }, effects: [{ k: 'sign', params: m.params }] }
    }
    case 'paid': {
      const ask = st.queue.find(a => a.askId === m.askId)
      const sc = st.screen
      const amountNano = sc.s === 'paying' && sc.askId === m.askId ? sc.amountNano : ask?.amountNano ?? '0'
      const next = dropAsk(st, m.askId)
      return {
        state: {
          ...next,
          screen: {
            s: 'paid',
            name: ask?.from.name ?? 'them',
            amountNano,
            ms: m.ms,
            receiptSent: m.receiptSent,
            until: st.now + FLASH_MS.paid,
          },
        },
        effects: [],
      }
    }
    case 'pay_failed': {
      if (st.screen.s !== 'paying' || st.screen.askId !== m.askId) return { state: st, effects: [] }
      return { state: notice(st, 'Not paid', m.reason), effects: [] }
    }
    case 'incoming': {
      if (!['idle', 'boot', 'balance'].includes(st.screen.s)) return { state: st, effects: [] }
      return {
        state: {
          ...st,
          screen: { s: 'incoming', fromName: m.fromName, amountNano: m.amountNano, memo: m.memo, until: st.now + FLASH_MS.incoming },
        },
        effects: [],
      }
    }
    case 'limits':
      return { state: { ...st, limits: m.limits }, effects: [] }
    case 'transcript': {
      if (st.screen.s !== 'listening') return { state: st, effects: [] }
      return { state: { ...st, screen: { ...st.screen, transcript: m.text } }, effects: [] }
    }
    case 'voice_intent': {
      if (st.screen.s !== 'listening') return { state: st, effects: [] }
      return { state: { ...st, screen: { s: 'confirm_voice', askId: m.askId, intent: m.intent } }, effects: [] }
    }
  }
}

function onGesture(st: LensState, g: Gesture): Out {
  const sc = st.screen
  const ask = currentAsk(st)
  switch (sc.s) {
    case 'boot':
    case 'idle':
      if (g === 'back') return { state: st, effects: [{ k: 'exit' }] }
      if (g === 'tap') {
        if (ask) return { state: { ...st, screen: { s: 'ask' } }, effects: [] }
        return { state: { ...st, screen: { s: 'balance', until: st.now + FLASH_MS.balance } }, effects: [] }
      }
      return { state: st, effects: [] }
    case 'ask':
      if (!ask) return { state: rest(st), effects: [] }
      if (g === 'tap') return startPay(st, ask, ask.amountNano)
      if (g === 'up' || g === 'down') return { state: { ...st, screen: { s: 'options', index: 0 } }, effects: [] }
      if (g === 'hold') return listen(st, ask.askId)
      if (g === 'back') return { state: { ...st, screen: { s: 'idle' } }, effects: [] }
      return { state: st, effects: [] }
    case 'options': {
      if (!ask) return { state: rest(st), effects: [] }
      const opts = optionsFor(ask)
      if (g === 'up') return { state: { ...st, screen: { s: 'options', index: (sc.index - 1 + opts.length) % opts.length } }, effects: [] }
      if (g === 'down') return { state: { ...st, screen: { s: 'options', index: (sc.index + 1) % opts.length } }, effects: [] }
      if (g === 'tap') return chooseOption(st, opts[sc.index]!.id)
      if (g === 'back') return { state: { ...st, screen: { s: 'ask' } }, effects: [] }
      return { state: st, effects: [] }
    }
    case 'listening':
      if (g === 'release' && !sc.released) {
        return {
          state: { ...st, screen: { ...sc, released: true } },
          effects: [{ k: 'mic', on: false }, send({ t: 'ptt', state: 'stop', ...(sc.askId ? { askId: sc.askId } : {}) })],
        }
      }
      if (g === 'back') {
        const effects: Effect[] = sc.released ? [] : [{ k: 'mic', on: false }, send({ t: 'ptt', state: 'stop' })]
        return { state: rest(st), effects }
      }
      return { state: st, effects: [] }
    case 'confirm_voice': {
      if (g === 'back') return { state: rest(st), effects: [] }
      if (g === 'hold') return listen(st, sc.askId)
      if (g !== 'tap') return { state: st, effects: [] }
      const target = st.queue.find(a => a.askId === sc.askId)
      const it = sc.intent
      if (it.kind === 'pay' && target) return startPay(st, target, it.amountNano, it.reply)
      if (it.kind === 'reply' && target) {
        return {
          state: notice(st, 'Reply sent', `“${it.text}”`),
          effects: [send({ t: 'decision', askId: target.askId, action: 'reply', reply: it.text })],
        }
      }
      if (it.kind === 'decline' && target) {
        const next = dropAsk(st, target.askId)
        return {
          state: notice(next, 'Declined', it.reply ? `“${it.reply}”` : `${target.from.name} won't be paid.`),
          effects: [send({ t: 'decision', askId: target.askId, action: 'decline', ...(it.reply ? { reply: it.reply } : {}) })],
        }
      }
      return { state: rest(st), effects: [] }
    }
    case 'paying':
      return { state: st, effects: [] }
    case 'paid':
    case 'notice':
    case 'incoming':
    case 'balance':
      if (g === 'tap' || g === 'back') return { state: rest(st), effects: [] }
      return { state: st, effects: [] }
  }
}

function onTick(st: LensState, now: number): Out {
  const next = { ...st, now }
  const sc = next.screen
  if ('until' in sc && now >= sc.until) return { state: rest(next), effects: [] }
  if (sc.s === 'paying' && now - sc.since > PAY_TIMEOUT_MS) {
    return { state: notice(next, 'Still confirming', 'TON is slow right now. The receipt will follow in the chat.'), effects: [] }
  }
  return { state: next, effects: [] }
}

export function reduce(st: LensState, ev: LensEvent): Out {
  switch (ev.k) {
    case 'server':
      return onServer(st, ev.m)
    case 'input':
      return onGesture(st, ev.g)
    case 'select': {
      const ask = currentAsk(st)
      if (st.screen.s !== 'options' || !ask) return { state: st, effects: [] }
      const opt = optionsFor(ask)[ev.index]
      return opt ? chooseOption(st, opt.id) : { state: st, effects: [] }
    }
    case 'tick':
      return onTick(st, ev.now)
    case 'wearing':
      return { state: { ...st, wearing: ev.on }, effects: [] }
  }
}
