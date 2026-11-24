import { pxTruncate } from '@evenrealities/pretext'
import type { Ask, Limits, RiskReason } from '../types'
import { formatGram, seconds, shortAddr, toBig } from '../format'
import type { Box, LensPage, TextBox } from './model'
import { LENS_W } from './model'
import type { LensState } from './machine'
import { currentAsk, optionsFor } from './machine'

const M = 16 // outer margin
const INNER = LENS_W - 2 * M

function text(name: string, x: number, y: number, w: number, h: number, content: string, brightness: TextBox['brightness'], extra: Partial<TextBox> = {}): TextBox {
  return { type: 'text', name, x, y, w, h, content, brightness, padding: 0, ...extra }
}

/** A full-screen, empty capture box so taps register on otherwise image-only pages. */
function captureLayer(): TextBox {
  return text('cap', 0, 0, LENS_W, 288, '', 0, { capture: true })
}

const fit = (s: string, px: number) => pxTruncate(s, px)

function recipientLine(ask: Ask): string {
  if (!ask.recipient) return 'no wallet on their profile'
  const who = ask.recipient.source === 'profile_card' ? 'wallet on their profile' : ask.recipient.source === 'address_book' ? 'saved wallet' : 'wallet from the message'
  return `${who} · ${shortAddr(ask.recipient.address)}`
}

export function reasonText(r: RiskReason): string {
  switch (r.code) {
    case 'over_tx_cap':
      return `over your ${formatGram(r.capNano)} GRAM per-payment limit`
    case 'over_daily_cap':
      return `only ${formatGram(r.remainingNano)} GRAM left today`
    case 'address_mismatch':
      return 'address in the message is not on their profile'
    case 'new_recipient':
      return 'first payment to this wallet'
    case 'no_wallet':
      return 'no wallet on their profile'
    case 'urgency':
      return 'pushy wording, take a second look'
    case 'scam_pattern':
      return 'looks like a scam pattern'
    case 'paused':
      return 'payments are paused'
  }
}

function askPage(ask: Ask, queueLen: number): LensPage {
  const who = ask.chat.kind === 'group' && ask.chat.title ? `${ask.from.name} · ${ask.chat.title}` : ask.from.name
  const head = queueLen > 1 ? `${who} asks   1/${queueLen}` : `${who} asks`
  const memo = ask.split ? `${ask.memo} · your share of ${formatGram(ask.split.totalNano)}` : ask.memo
  const risk = ask.risk.reasons.length ? ask.risk.reasons.map(reasonText)[0]! : ''
  const blocked = ask.risk.level === 'block'
  const footer = blocked ? `■ Can't pay: ${risk}` : ask.risk.level === 'warn' ? `! ${risk}   ● tap to pay` : '● Tap ring to pay      ↕ more'
  const boxes: Box[] = [
    text('head', M, 10, INNER, 27, fit(head, INNER), 2),
    { type: 'image', name: 'amount', x: M, y: 46, w: 288, h: 96, spec: { kind: 'amount', value: formatGram(ask.amountNano), unit: 'GRAM' } },
    text('memo', 320, 66, 240, 81, fit(memo, 240 * 3), 4),
    text('to', M, 152, INNER, 27, fit(recipientLine(ask), INNER), 2),
    text('foot', M, 214, INNER, 58, fit(footer, INNER - 24), blocked ? 3 : 4, {
      capture: true,
      padding: 8,
      border: { width: 1, brightness: blocked ? 2 : 3, radius: 6 },
    }),
  ]
  return { layout: 'ask', boxes }
}

function limitsLine(l: Limits | null): string {
  if (!l) return ''
  const left = toBig(l.dailyNano) - toBig(l.spentNano)
  return `${formatGram(left > 0n ? left : 0n)} of ${formatGram(l.dailyNano)} GRAM left today`
}

export function renderScreen(st: LensState): LensPage {
  const sc = st.screen
  const ask = currentAsk(st)
  switch (sc.s) {
    case 'idle':
      // Dark until someone asks.
      return { layout: 'idle', boxes: [captureLayer()] }
    case 'boot':
      return {
        layout: 'boot',
        boxes: [
          text('title', M, 96, INNER, 27, 'Thruppence', 4, { capture: true }),
          text('sub', M, 128, INNER, 54, `Waiting for money asks${st.demo ? ' · demo' : ''}\n${limitsLine(st.limits)}`, 2),
        ],
      }
    case 'ask':
      return ask ? askPage(ask, st.queue.length) : { layout: 'idle', boxes: [captureLayer()] }
    case 'options': {
      if (!ask) return { layout: 'idle', boxes: [captureLayer()] }
      const opts = optionsFor(ask)
      return {
        layout: 'options',
        boxes: [
          text('head', M, 10, INNER, 27, fit(`${ask.from.name} · ${formatGram(ask.amountNano)} GRAM · ${ask.memo}`, INNER), 2),
          { type: 'list', name: 'opts', x: M, y: 46, w: INNER, h: 230, items: opts.map(o => o.label), selected: sc.index, capture: true },
        ],
      }
    }
    case 'listening':
      return {
        layout: 'listening',
        boxes: [
          text('head', M, 10, INNER, 27, sc.released ? 'Got it…' : '● Listening', sc.released ? 2 : 4),
          text('said', M, 50, INNER, 162, sc.transcript ? `“${sc.transcript}”` : 'Say an amount or a short reply', sc.transcript ? 4 : 2, { capture: true }),
          text('foot', M, 230, INNER, 27, sc.released ? '' : 'Release to finish', 2),
        ],
      }
    case 'confirm_voice': {
      const it = sc.intent
      const line =
        it.kind === 'pay'
          ? `Pay ${formatGram(it.amountNano)} GRAM${it.reply ? ` and say “${it.reply}”` : ''}?`
          : it.kind === 'reply'
            ? `Reply “${it.text}”?`
            : it.kind === 'decline'
              ? `Decline${it.reply ? ` with “${it.reply}”` : ''}?`
              : `Didn't catch that: “${it.heard}”`
      return {
        layout: 'confirm',
        boxes: [
          text('line', M, 60, INNER, 108, line, 4),
          text('foot', M, 214, INNER, 58, it.kind === 'unknown' ? '● tap to go back   hold to retry' : '● Tap to confirm   hold to retry', 3, {
            capture: true,
            padding: 8,
            border: { width: 1, brightness: 3, radius: 6 },
          }),
        ],
      }
    }
    case 'paying': {
      const name = ask?.askId === sc.askId ? ask.from.name : 'them'
      const elapsed = Math.max(0, st.now - sc.since)
      const bar = '━'.repeat(Math.min(16, 1 + Math.floor(elapsed / 500))).padEnd(16, '─')
      return {
        layout: 'paying',
        boxes: [
          { type: 'image', name: 'amount', x: M, y: 46, w: 288, h: 96, spec: { kind: 'amount', value: formatGram(sc.amountNano), unit: 'GRAM' } },
          text('to', 320, 60, 240, 54, fit(`to ${name}`, 240 * 2), 4),
          text('bar', M, 170, INNER, 27, `${bar}  ${sc.signed ? 'sending on TON' : 'signing'}`, 2, { capture: true }),
        ],
      }
    }
    case 'paid':
      return {
        layout: 'paid',
        boxes: [
          { type: 'image', name: 'mark', x: M, y: 60, w: 96, h: 96, spec: { kind: 'mark', mark: 'check' } },
          text('what', 128, 66, 432, 27, fit(`Paid ${formatGram(sc.amountNano)} GRAM to ${sc.name}`, 432), 4, { capture: true }),
          text('how', 128, 100, 432, 54, `${seconds(sc.ms)}${sc.receiptSent ? '\nreceipt sent in the chat' : ''}`, 2),
        ],
      }
    case 'notice':
      return {
        layout: 'notice',
        boxes: [
          { type: 'image', name: 'mark', x: M, y: 60, w: 96, h: 96, spec: { kind: 'mark', mark: 'cross' } },
          text('what', 128, 66, 432, 27, fit(sc.title, 432), 4, { capture: true }),
          text('how', 128, 100, 432, 81, sc.detail, 2),
        ],
      }
    case 'incoming':
      return {
        layout: 'incoming',
        boxes: [
          text('head', M, 10, INNER, 27, fit(`${sc.fromName} paid you`, INNER), 2, { capture: true }),
          { type: 'image', name: 'amount', x: M, y: 46, w: 288, h: 96, spec: { kind: 'amount', value: '+' + formatGram(sc.amountNano), unit: 'GRAM' } },
          text('memo', 320, 60, 240, 81, sc.memo ? fit(sc.memo, 240 * 3) : '', 4),
        ],
      }
    case 'balance': {
      const l = st.limits
      return {
        layout: 'balance',
        boxes: [
          text('head', M, 10, INNER, 27, 'Ready to pay', 2, { capture: true }),
          { type: 'image', name: 'amount', x: M, y: 46, w: 288, h: 96, spec: { kind: 'amount', value: l ? formatGram(l.spendableNano) : '–', unit: 'GRAM' } },
          text('lim', M, 160, INNER, 54, l ? `${limitsLine(l)}\nup to ${formatGram(l.perTxNano)} GRAM per payment${l.paused ? ' · paused' : ''}` : 'connecting…', 2),
        ],
      }
    }
  }
}
