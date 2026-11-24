import { Address } from '@ton/core'
import { parseGram, type Ask, type Risk, type RiskReason } from '@thruppence/core'
import type { RawIntent } from './schema'
import { spokenToDigits } from './spoken'

export interface ValidateCtx {
  /** The original message text, or the voice-note transcript. */
  text: string
  /** Wallet address shown on the requester's own Telegram profile (Bot API `ton_wallet_card`). */
  requesterCard: string | null
  /** Wallet the payer saved for this requester earlier. */
  book: string | null
  /** Addresses the payer has paid before (any format). */
  paidBefore: string[]
  caps: { perTxNano: bigint; remainingNano: bigint; paused: boolean }
  /** USD price of one GRAM, used only when the ask is in dollars. */
  usdPerGram: number | null
}

export interface AskDraft {
  amountNano: string
  memo: string
  recipient: Ask['recipient']
}

export interface Verdict {
  draft: AskDraft | null
  risk: Risk
  /** Why there is no card (for logs and the eval), when `draft` is null. */
  dropped?: 'not_a_request' | 'no_amount' | 'ungrounded_amount' | 'unsupported_currency'
}

const NANO = 1_000_000_000n

const TON_ADDR = /\b(?:[EUk0]Q[A-Za-z0-9_-]{46}|-?[01]:[0-9a-fA-F]{64})\b/g

const SCAM_PHRASES = [
  /seed\s*phrase/i,
  /recovery\s*phrase/i,
  /private\s*key/i,
  /verify\s+your\s+wallet/i,
  /claim\s+(your\s+)?(airdrop|reward)/i,
  /double\s+your/i,
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /\bsystem\s*:/i,
]

function parseAddr(a: string): Address | null {
  try {
    return Address.parse(a)
  } catch {
    return null
  }
}

export function sameAddress(a: string, b: string): boolean {
  const x = parseAddr(a)
  const y = parseAddr(b)
  return !!x && !!y && x.equals(y)
}

/** Every TON address written in the text, parsed by us (never by the model). */
export function addressesIn(text: string): string[] {
  return [...text.matchAll(TON_ADDR)].map(m => m[0]).filter(a => parseAddr(a) !== null)
}

/** Decimal numbers written in the text: "1 250", "12,5", "$20", "1,250.75". */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  const stripped = text.replace(TON_ADDR, ' ')
  for (const m of stripped.matchAll(/\d{1,3}(?:[ ,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)) {
    let s = m[0]
    if (/^\d{1,3}([ ,]\d{3})+([.,]\d+)?$/.test(s) && !/^\d+,\d{1,2}$/.test(s)) s = s.replace(/[ ,](?=\d{3})/g, '')
    s = s.replace(',', '.')
    const n = Number(s)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

function asNumber(amount: string): number | null {
  const n = numbersIn(amount)
  return n.length === 1 ? n[0]! : null
}

/** The amount must be written in the message, or be a fair share of two numbers in it ("120 … 4 of us"). */
export function isGrounded(amount: number, text: string): boolean {
  const nums = numbersIn(spokenToDigits(text))
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.005
  if (nums.some(n => eq(n, amount))) return true
  for (const a of nums) for (const b of nums) if (b >= 2 && b <= 50 && eq(a / b, amount)) return true
  return false
}

function toNano(amount: number, currency: RawIntent['currency'], usdPerGram: number | null): string | null {
  if (currency === 'GRAM' || currency === 'TON' || currency === null) return parseGram(amount.toFixed(9).replace(/\.?0+$/, ''))
  if ((currency === 'USD' || currency === 'USDT') && usdPerGram && usdPerGram > 0) {
    const nano = BigInt(Math.floor((amount / usdPerGram) * 1e9))
    return nano > 0n ? nano.toString() : null
  }
  return null
}

function level(reasons: RiskReason[]): Risk['level'] {
  const blocking: RiskReason['code'][] = ['over_tx_cap', 'over_daily_cap', 'address_mismatch', 'no_wallet', 'paused']
  if (reasons.some(r => blocking.includes(r.code))) return 'block'
  return reasons.length ? 'warn' : 'ok'
}

/**
 * Turns the model's description into a payable ask, or nothing.
 * Deterministic: the same inputs always give the same verdict.
 */
export function validate(raw: RawIntent | null, ctx: ValidateCtx): Verdict {
  const none = (dropped: Verdict['dropped']): Verdict => ({ draft: null, risk: { level: 'ok', reasons: [] }, dropped })
  if (!raw || !raw.is_request || raw.kind === 'none' || raw.kind === 'repaid_notice') return none('not_a_request')
  if (!raw.amount) return none('no_amount')
  const amount = asNumber(raw.amount)
  if (amount === null || amount <= 0) return none('no_amount')
  if (!isGrounded(amount, ctx.text)) return none('ungrounded_amount')
  const amountNano = toNano(amount, raw.currency, ctx.usdPerGram)
  if (!amountNano) return none('unsupported_currency')

  const reasons: RiskReason[] = []
  const inText = addressesIn(ctx.text)
  const scammy = raw.addresses_assistant || SCAM_PHRASES.some(r => r.test(ctx.text))

  let recipient: Ask['recipient'] = null
  if (ctx.requesterCard) {
    recipient = { address: ctx.requesterCard, source: 'profile_card' }
  } else if (ctx.book) {
    recipient = { address: ctx.book, source: 'address_book' }
  } else if (inText.length === 1 && !scammy) {
    recipient = { address: inText[0]!, source: 'message_entity' }
  }

  if (!recipient) {
    reasons.push(inText.length ? { code: 'address_mismatch' } : { code: 'no_wallet' })
  } else if (inText.some(a => !sameAddress(a, recipient!.address))) {
    // Someone wrote an address that is not the one on the requester's profile.
    reasons.push({ code: 'address_mismatch' })
  }
  if (recipient && !ctx.paidBefore.some(a => sameAddress(a, recipient!.address))) reasons.push({ code: 'new_recipient' })

  const amt = BigInt(amountNano)
  if (ctx.caps.paused) reasons.push({ code: 'paused' })
  if (amt > ctx.caps.perTxNano) reasons.push({ code: 'over_tx_cap', capNano: ctx.caps.perTxNano.toString() })
  else if (amt > ctx.caps.remainingNano) reasons.push({ code: 'over_daily_cap', remainingNano: (ctx.caps.remainingNano > 0n ? ctx.caps.remainingNano : 0n).toString() })
  if (raw.urgency) reasons.push({ code: 'urgency' })
  if (scammy) reasons.push({ code: 'scam_pattern' })

  const order: RiskReason['code'][] = ['paused', 'address_mismatch', 'no_wallet', 'over_tx_cap', 'over_daily_cap', 'scam_pattern', 'urgency', 'new_recipient']
  reasons.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))

  const memo = (raw.memo ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const quoted = raw.currency === 'USD' || raw.currency === 'USDT' ? `$${raw.amount}` : ''
  return {
    draft: { amountNano, memo: [memo, quoted].filter(Boolean).join(' · ') || 'no reason given', recipient },
    risk: { level: level(reasons), reasons },
  }
}

export const NANO_PER_GRAM = NANO
