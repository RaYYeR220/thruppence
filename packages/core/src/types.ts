/** Amounts travel as decimal nanoton strings (1 GRAM = 1e9 nano). */
export type Nano = string

export type RiskLevel = 'ok' | 'warn' | 'block'

export type RiskReason =
  | { code: 'over_tx_cap'; capNano: Nano }
  | { code: 'over_daily_cap'; remainingNano: Nano }
  /** An address in the message text differs from the wallet on the requester's own Telegram profile. */
  | { code: 'address_mismatch' }
  /** First payment to this address. */
  | { code: 'new_recipient' }
  /** Requester has no wallet on their profile and is not in the address book. */
  | { code: 'no_wallet' }
  | { code: 'urgency' }
  | { code: 'paused' }

export interface Risk {
  level: RiskLevel
  reasons: RiskReason[]
}

export type RecipientSource = 'profile_card' | 'address_book' | 'message_entity' | 'ton_dns'

export interface Ask {
  askId: string
  chat: { id: string; kind: 'dm' | 'group' | 'bot'; title?: string }
  from: { tgId: string; name: string; username?: string }
  amountNano: Nano
  /** Short reason, max ~40 chars ("concert tickets"). */
  memo: string
  recipient: { address: string; source: RecipientSource } | null
  risk: Risk
  via: 'text' | 'voice' | 'split' | 'request_card'
  /** Group bill split: the total and how many people share it. */
  split?: { totalNano: Nano; people: number }
  receivedAt: number
}

export interface Limits {
  perTxNano: Nano
  dailyNano: Nano
  spentNano: Nano
  /** Balance of the capped wallet. */
  spendableNano: Nano
  paused: boolean
}

/** Everything the device needs to sign one PayRequest. Sent by the server after the user taps "pay". */
export interface PayParams {
  askId: string
  networkId: number
  extAddress: string
  seqno: number
  validUntil: number
  dest: string
  amountNano: Nano
  bounce: boolean
  requestId: string
  comment: string
}

export type VoiceIntent =
  | { kind: 'pay'; amountNano: Nano; reply?: string }
  | { kind: 'reply'; text: string }
  | { kind: 'decline'; reply?: string }
  | { kind: 'unknown'; heard: string }

export type ServerToLens =
  | { t: 'hello_ok'; name: string; limits: Limits; demo?: boolean }
  | { t: 'ask'; ask: Ask }
  | { t: 'cancel'; askId: string }
  | { t: 'pay_params'; params: PayParams }
  | { t: 'paid'; askId: string; txHash: string; ms: number; receiptSent: boolean }
  | { t: 'pay_failed'; askId: string; reason: string }
  | { t: 'incoming'; fromName: string; amountNano: Nano; memo?: string }
  | { t: 'limits'; limits: Limits }
  | { t: 'transcript'; text: string; final: boolean }
  | { t: 'voice_intent'; askId?: string; intent: VoiceIntent }

export type LensDecision = 'pay' | 'decline' | 'later' | 'reply'

export type LensToServer =
  | { t: 'hello'; deviceId: string; token: string }
  | { t: 'decision'; askId: string; action: LensDecision; amountNano?: Nano; reply?: string }
  | { t: 'signed'; askId: string; boc: string }
  | { t: 'ptt'; state: 'start' | 'stop'; askId?: string }
  | { t: 'audio'; seq: number; pcm: string }
