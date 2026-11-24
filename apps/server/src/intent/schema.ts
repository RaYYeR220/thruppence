/**
 * What the language model is allowed to say about one message. It never
 * decides who gets paid or whether a payment is allowed; it only describes
 * the message. Everything it returns is re-checked against the original text.
 */
export interface RawIntent {
  /** The message asks the reader to send them (or someone) money. */
  is_request: boolean
  kind: 'pay_request' | 'split' | 'invoice' | 'repaid_notice' | 'none'
  /** Number exactly as written in the message ("25", "12.5", "1 000"), or null. */
  amount: string | null
  currency: 'GRAM' | 'TON' | 'USD' | 'USDT' | 'OTHER' | null
  /** What the money is for, ≤ 40 characters, in the message's language. */
  memo: string | null
  /** Pressure: "now", "urgent", "before it's too late", threats. */
  urgency: boolean
  /** The text contains instructions aimed at an assistant/bot ("ignore previous…", "system:"). */
  addresses_assistant: boolean
  /** Matches a known scam shape: fake support, account threats, "verify" payments, giveaways, fees to claim, guaranteed returns, sudden "new account" friends. */
  scam: boolean
}

export const RAW_INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_request', 'kind', 'amount', 'currency', 'memo', 'urgency', 'addresses_assistant', 'scam'],
  properties: {
    is_request: { type: 'boolean' },
    kind: { type: 'string', enum: ['pay_request', 'split', 'invoice', 'repaid_notice', 'none'] },
    amount: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'], enum: ['GRAM', 'TON', 'USD', 'USDT', 'OTHER', null] },
    memo: { type: ['string', 'null'] },
    urgency: { type: 'boolean' },
    addresses_assistant: { type: 'boolean' },
    scam: { type: 'boolean' },
  },
} as const

export function isRawIntent(v: unknown): v is RawIntent {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.is_request === 'boolean' &&
    typeof o.kind === 'string' &&
    ['pay_request', 'split', 'invoice', 'repaid_notice', 'none'].includes(o.kind) &&
    (o.amount === null || typeof o.amount === 'string') &&
    (o.currency === null || ['GRAM', 'TON', 'USD', 'USDT', 'OTHER'].includes(o.currency as string)) &&
    (o.memo === null || typeof o.memo === 'string') &&
    typeof o.urgency === 'boolean' &&
    typeof o.addresses_assistant === 'boolean' &&
    typeof o.scam === 'boolean'
  )
}
