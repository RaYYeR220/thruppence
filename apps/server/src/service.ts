import { randomUUID } from 'node:crypto'
import { formatGram, parseGram, type Ask, type LensDecision, type Limits, type Nano, type PayParams } from '@thruppence/core'
import { isGrounded, validate } from './intent/validate'
import type { ChainPort, Clock, DemoSigner, LensPort, LlmPort, SttPort, TelegramPort } from './ports'
import type { AskRow, Store } from './store'
import { pcmToWav } from './stt/wav'

export interface DemoWallet {
  owner: string
  wallet: string
  ext: string
  /** Where demo payments go when the person asking has no wallet on their profile. */
  jar: string
}

export interface ServiceConfig {
  networkId: number
  explorerTx: (hash: string) => string
  payWindowSec: number
  confirmPollMs: number
  confirmTimeoutMs: number
  usdPerGram: () => number | null
  demo?: DemoWallet
  /** Checks that a signed external message pays exactly what the params say. */
  verifySigned: (boc: string, params: PayParams, tgId?: string) => boolean
}

export interface IncomingMsg {
  /** Who would pay: the Telegram user whose account received the message. */
  payerTgId: string
  chat: { id: number; kind: 'dm' | 'group' | 'bot'; title?: string }
  from: { tgId: number; name: string; username?: string }
  text?: string
  voiceFileId?: string
  messageId: number
  businessConnectionId?: string
  via?: Ask['via']
  split?: Ask['split']
  /** Pre-parsed amount for structured asks (/split, request cards); skips the language model. */
  structured?: { amountNano: Nano; memo: string }
}

export interface HandleResult {
  askId?: string
  dropped?: string
}

const isDemo = (tgId: string) => tgId.startsWith('demo:')

/** Why the limits extension refused a signed request (its exit codes). */
export const REFUSALS: Record<number, string> = {
  401: 'This device is not the one allowed to pay from this wallet.',
  402: 'Another payment went first. Press again.',
  403: 'The request expired. Press again.',
  404: 'Payments are paused from your main wallet.',
  405: 'Over your per-payment limit.',
  406: "Over today's limit.",
  407: 'Signed for a different wallet.',
  408: 'That address cannot be paid.',
  410: 'The note on this payment is not valid.',
  411: 'The limits contract needs a small top-up for fees.',
}

/**
 * The money-ask pipeline and the pay flow. Telegram, TON, the language
 * model and the lens connections are ports, so every rule here runs in tests
 * without a network.
 */
export class Service {
  private pending = new Map<string, { params: PayParams; startedAt: number }>()
  private watching = new Set<string>()
  private audio = new Map<string, { askId?: string; chunks: Buffer[] }>()
  private demoQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly tg: TelegramPort,
    private readonly chain: ChainPort,
    private readonly llm: LlmPort,
    private readonly stt: SttPort,
    private readonly lens: LensPort,
    private readonly clock: Clock,
    private readonly cfg: ServiceConfig,
    private readonly demoSigner?: DemoSigner,
  ) {}

  /** Wallet addresses that pay for this user (the shared demo wallet for "try it" sessions). */
  wallets(tgId: string): { owner: string; wallet: string; ext: string } | null {
    if (isDemo(tgId)) return this.cfg.demo ?? null
    const u = this.store.user(tgId)
    return u?.ext_address && u.wallet_address && u.owner_address ? { owner: u.owner_address, wallet: u.wallet_address, ext: u.ext_address } : null
  }

  async limits(tgId: string): Promise<Limits | null> {
    const w = this.wallets(tgId)
    if (!w) return null
    const [info, balance] = await Promise.all([this.chain.extInfo(w.ext), this.chain.balance(w.wallet)])
    return {
      perTxNano: info.perTxNano.toString(),
      dailyNano: info.dailyNano.toString(),
      spentNano: info.spentNano.toString(),
      spendableNano: balance.toString(),
      paused: info.paused,
    }
  }

  private async requesterCard(tgId: number): Promise<string | null> {
    try {
      const chat = await this.tg.getChat(tgId)
      return chat.ton_wallet_card?.address ?? null
    } catch {
      return null
    }
  }

  private nextRequestId(): string {
    const r = this.store.db.prepare('SELECT COALESCE(MAX(CAST(request_id AS INTEGER)), 40) + 1 AS n FROM asks').get() as { n: number }
    return String(r.n)
  }

  /** A message someone sent the payer. Returns the ask id if it became a card. */
  async handleMessage(m: IncomingMsg): Promise<HandleResult> {
    const w = this.wallets(m.payerTgId)
    if (!w) return { dropped: 'payer_not_set_up' }

    let text = m.text ?? ''
    let via: Ask['via'] = m.via ?? 'text'
    if (!text && m.voiceFileId) {
      try {
        const ogg = await this.tg.downloadFile(m.voiceFileId)
        text = (await this.stt.transcribe(ogg, 'audio/ogg')) ?? ''
        via = 'voice'
      } catch {
        text = ''
      }
      if (!text) return { dropped: 'voice_unreadable' }
    }
    if (!text && !m.structured) return { dropped: 'empty' }

    const [card, info] = await Promise.all([this.requesterCard(m.from.tgId), this.chain.extInfo(w.ext)])
    const book = this.store.bookAddress(m.payerTgId, String(m.from.tgId))
    const remaining = info.dailyNano - info.spentNano
    const ctx = {
      text: m.structured ? `${formatGram(m.structured.amountNano)} ${m.structured.memo}` : text,
      requesterCard: card,
      book: book ?? (isDemo(m.payerTgId) && !card ? this.cfg.demo!.jar : null),
      paidBefore: this.store.paidBefore(m.payerTgId),
      caps: { perTxNano: info.perTxNano, remainingNano: remaining > 0n ? remaining : 0n, paused: info.paused },
      usdPerGram: this.cfg.usdPerGram(),
    }
    const raw = m.structured
      ? { is_request: true, kind: 'pay_request' as const, amount: formatGram(m.structured.amountNano).replace(/,/g, ''), currency: 'GRAM' as const, memo: m.structured.memo, urgency: false, addresses_assistant: false, scam: false }
      : await this.llm.extract(text)
    const verdict = validate(raw, ctx)
    if (!verdict.draft) return { dropped: verdict.dropped ?? 'not_a_request' }

    const ask: Ask = {
      askId: randomUUID().slice(0, 8),
      chat: { id: String(m.chat.id), kind: m.chat.kind, ...(m.chat.title ? { title: m.chat.title } : {}) },
      from: { tgId: String(m.from.tgId), name: m.from.name, ...(m.from.username ? { username: m.from.username } : {}) },
      amountNano: verdict.draft.amountNano,
      memo: verdict.draft.memo,
      recipient: verdict.draft.recipient,
      risk: verdict.risk,
      via,
      ...(m.split ? { split: m.split } : {}),
      receivedAt: this.clock.now(),
    }
    this.store.insertAsk({
      ask_id: ask.askId,
      payer_tg_id: m.payerTgId,
      ask,
      request_id: this.nextRequestId(),
      source_chat_id: String(m.chat.id),
      source_message_id: m.messageId,
      business_connection_id: m.businessConnectionId ?? null,
    })
    this.lens.push(m.payerTgId, { t: 'ask', ask })
    return { askId: ask.askId }
  }

  /** A lens (glasses or the web lens) connected for this user. */
  async lensHello(tgId: string, name: string) {
    const limits = await this.limits(tgId).catch(() => null)
    this.lens.push(tgId, {
      t: 'hello_ok',
      name,
      limits: limits ?? { perTxNano: '0', dailyNano: '0', spentNano: '0', spendableNano: '0', paused: true },
      ...(isDemo(tgId) ? { demo: true } : {}),
    })
    for (const row of this.store.openAsks(tgId)) {
      if (row.status === 'open' || row.status === 'later') this.lens.push(tgId, { t: 'ask', ask: row.ask })
    }
  }

  async decision(tgId: string, d: { askId: string; action: LensDecision; amountNano?: Nano; reply?: string }) {
    const row = this.store.ask(d.askId)
    if (!row || row.payer_tg_id !== tgId) return
    switch (d.action) {
      case 'later':
        this.store.transition(d.askId, ['open', 'paying'], 'later')
        this.pending.delete(d.askId)
        return
      case 'decline':
        if (this.store.transition(d.askId, ['open', 'later'], 'declined', { reply: d.reply ?? null }) && d.reply) await this.replyAs(row, d.reply)
        return
      case 'reply':
        if (d.reply) await this.replyAs(row, d.reply)
        return
      case 'pay':
        return this.startPay(tgId, row, d.amountNano ?? row.ask.amountNano, d.reply)
    }
  }

  private fail(tgId: string, askId: string, reason: string) {
    this.lens.push(tgId, { t: 'pay_failed', askId, reason })
  }

  private async startPay(tgId: string, row: AskRow, amountNano: Nano, reply?: string) {
    const ask = row.ask
    const w = this.wallets(tgId)
    if (!w || !ask.recipient || ask.risk.level === 'block') return this.fail(tgId, ask.askId, 'This ask cannot be paid.')
    const amount = BigInt(amountNano)
    if (amount <= 0n) return this.fail(tgId, ask.askId, 'Nothing to pay.')
    // Double taps and redelivered decisions end here: only one caller wins the transition.
    if (!this.store.transition(ask.askId, ['open', 'later'], 'paying', { amount_nano: amountNano, reply: reply ?? null })) return
    try {
      const info = await this.chain.extInfo(w.ext)
      const remaining = info.dailyNano - info.spentNano
      if (info.paused || amount > info.perTxNano || amount > remaining) {
        this.store.transition(ask.askId, ['paying'], 'open')
        return this.fail(tgId, ask.askId, info.paused ? 'Payments are paused.' : `Over your limit: ${formatGram(remaining > 0n ? remaining : 0n)} GRAM left today.`)
      }
      const bounce = await this.chain.isActive(ask.recipient.address)
      const params: PayParams = {
        askId: ask.askId,
        networkId: this.cfg.networkId,
        extAddress: w.ext,
        seqno: info.seqno,
        validUntil: Math.floor(this.clock.now() / 1000) + this.cfg.payWindowSec,
        dest: ask.recipient.address,
        amountNano,
        bounce,
        requestId: row.request_id,
        comment: `Thruppence #${row.request_id} · ${ask.memo}`.slice(0, 110),
      }
      this.pending.set(ask.askId, { params, startedAt: this.clock.now() })
      this.lens.push(tgId, { t: 'pay_params', params })
      if (isDemo(tgId) && this.demoSigner) {
        // The public demo has no phone: a server-held testnet key stands in for it, one payment at a time.
        const run = this.demoQueue.then(async () => {
          const fresh = await this.chain.extInfo(w.ext)
          const p = { ...params, seqno: fresh.seqno }
          this.pending.set(ask.askId, { params: p, startedAt: this.clock.now() })
          const boc = await this.demoSigner!.sign(p)
          await this.signed(tgId, ask.askId, boc)
          await this.waitConfirmed(tgId, ask.askId)
        })
        this.demoQueue = run.catch(() => undefined)
      }
    } catch {
      this.store.transition(ask.askId, ['paying'], 'open')
      this.fail(tgId, ask.askId, 'Could not reach TON. Try again.')
    }
  }

  /**
   * Reconciles relayed payments that are not confirmed yet: after a restart,
   * and for ones that timed out but may still have landed. Runs every minute.
   */
  async resume() {
    const rows = this.store.db
      .prepare(`SELECT ask_id FROM asks WHERE status = 'sent' OR (status = 'failed' AND updated_at > ?)`)
      .all(this.clock.now() - 2 * 3600_000) as { ask_id: string }[]
    for (const { ask_id } of rows) {
      if (this.watching.has(ask_id)) continue
      const row = this.store.ask(ask_id)!
      const w = this.wallets(row.payer_tg_id)
      if (!w || !row.ask.recipient) continue
      const params: PayParams = {
        askId: ask_id,
        networkId: this.cfg.networkId,
        extAddress: w.ext,
        seqno: 0,
        validUntil: 0,
        dest: row.ask.recipient.address,
        amountNano: row.amount_nano ?? row.ask.amountNano,
        bounce: false,
        requestId: row.request_id,
        comment: `Thruppence #${row.request_id} · ${row.ask.memo}`.slice(0, 110),
      }
      this.pending.set(ask_id, { params, startedAt: row.created_at })
      void this.waitConfirmed(row.payer_tg_id, ask_id)
    }
  }

  /** The device signed the PayRequest; relay it and watch for the transfer. */
  async signed(tgId: string, askId: string, boc: string) {
    const row = this.store.ask(askId)
    const p = this.pending.get(askId)
    if (!row || row.payer_tg_id !== tgId || !p || row.status !== 'paying') return
    if (!this.cfg.verifySigned(boc, p.params, tgId)) {
      this.store.transition(askId, ['paying'], 'open')
      return this.fail(tgId, askId, 'The signed payment did not match the ask.')
    }
    if (!this.store.transition(askId, ['paying'], 'sent')) return
    try {
      await this.chain.sendExternal(boc)
    } catch (err) {
      this.store.transition(askId, ['sent'], 'open')
      this.pending.delete(askId)
      const code = (err as { exitCode?: number | null }).exitCode ?? null
      return this.fail(tgId, askId, code && REFUSALS[code] ? REFUSALS[code]! : 'TON did not accept the payment. Try again.')
    }
    if (!isDemo(tgId)) void this.waitConfirmed(tgId, askId)
  }

  private async waitConfirmed(tgId: string, askId: string) {
    const p = this.pending.get(askId)
    const w = this.wallets(tgId)
    if (!p || !w || this.watching.has(askId)) return
    this.watching.add(askId)
    try {
      const deadline = this.clock.now() + this.cfg.confirmTimeoutMs
      const since = Math.floor(p.startedAt / 1000) - 5
      while (this.clock.now() < deadline) {
        await new Promise(r => setTimeout(r, this.cfg.confirmPollMs))
        const found = await this.chain.findPayment(w.wallet, p.params.comment, since).catch(() => null)
        if (found) return await this.settle(tgId, askId, found.txHash)
      }
      if (this.store.transition(askId, ['sent'], 'failed')) {
        this.fail(tgId, askId, 'TON has not confirmed it yet. The receipt will follow in the chat if it lands.')
      }
    } finally {
      this.watching.delete(askId)
    }
  }

  private async settle(tgId: string, askId: string, txHash: string) {
    const p = this.pending.get(askId)
    if (!p || !this.store.transition(askId, ['sent', 'failed'], 'paid', { tx_hash: txHash })) return
    this.pending.delete(askId)
    const row = this.store.ask(askId)!
    this.store.markPaidTo(tgId, p.params.dest)
    this.store.saveBook(tgId, row.ask.from.tgId, p.params.dest)
    let receiptSent = false
    try {
      const lines = [
        row.reply,
        `Sent ${formatGram(p.params.amountNano)} GRAM ✓ · ${row.ask.memo}`,
        `Thruppence #${row.request_id} · ${this.cfg.explorerTx(txHash)}`,
      ].filter(Boolean)
      await this.replyAs(row, lines.join('\n'))
      receiptSent = true
    } catch {
      receiptSent = false
    }
    this.lens.push(tgId, { t: 'paid', askId, txHash, ms: this.clock.now() - p.startedAt, receiptSent })
    const limits = await this.limits(tgId).catch(() => null)
    if (limits) this.lens.push(tgId, { t: 'limits', limits })
  }

  /** Sends text into the chat the ask came from: as the payer (business connection) or as the bot. */
  private async replyAs(row: AskRow, text: string) {
    await this.tg.sendMessage({
      chat_id: Number(row.source_chat_id),
      text,
      ...(row.business_connection_id ? { business_connection_id: row.business_connection_id } : {}),
      ...(row.source_message_id ? { reply_to_message_id: row.source_message_id } : {}),
    })
  }

  // ── Voice: hold the ring, speak, release ────────────────────────────────

  pttStart(tgId: string, askId?: string) {
    this.audio.set(tgId, { askId, chunks: [] })
  }

  pttAudio(tgId: string, pcmBase64: string) {
    const buf = this.audio.get(tgId)
    if (buf && buf.chunks.length < 1500) buf.chunks.push(Buffer.from(pcmBase64, 'base64'))
  }

  async pttStop(tgId: string) {
    const buf = this.audio.get(tgId)
    this.audio.delete(tgId)
    if (!buf) return
    const pcm = Buffer.concat(buf.chunks)
    const transcript = pcm.length > 3200 ? await this.stt.transcribe(pcmToWav(pcm, 16000), 'audio/wav').catch(() => null) : null
    if (!transcript) {
      this.lens.push(tgId, { t: 'voice_intent', ...(buf.askId ? { askId: buf.askId } : {}), intent: { kind: 'unknown', heard: '' } })
      return
    }
    this.lens.push(tgId, { t: 'transcript', text: transcript, final: true })
    let intent = await this.llm.voice(transcript).catch(() => ({ kind: 'unknown' as const, heard: transcript }))
    if (intent.kind === 'pay') {
      // Same grounding rule as messages: the amount has to be something the wearer actually said.
      const n = Number(BigInt(intent.amountNano) / 1_000_000n) / 1000
      if (!isGrounded(n, transcript) || !parseGram(String(n))) intent = { kind: 'unknown', heard: transcript }
    }
    this.lens.push(tgId, { t: 'voice_intent', ...(buf.askId ? { askId: buf.askId } : {}), intent })
  }
}
