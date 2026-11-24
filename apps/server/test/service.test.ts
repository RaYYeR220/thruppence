import { Address } from '@ton/core'
import type { ServerToLens, VoiceIntent } from '@thruppence/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RawIntent } from '../src/intent/schema'
import type { ChainPort, ExtInfo, LensPort, LlmPort, SttPort, TelegramPort } from '../src/ports'
import { Service, type ServiceConfig } from '../src/service'
import { Store } from '../src/store'

const addr = (b: number) => new Address(0, Buffer.alloc(32, b)).toString({ bounceable: false })
const MIA = addr(1)
const PAYER = '777'

class FakeChain implements ChainPort {
  info: ExtInfo = { seqno: 3, perTxNano: 2_000_000_000n, dailyNano: 5_000_000_000n, spentNano: 0n, paused: false }
  sent: string[] = []
  landed = new Map<string, string>()
  async extInfo() {
    return { ...this.info }
  }
  async balance() {
    return 18_000_000_000n
  }
  async isActive() {
    return true
  }
  async sendExternal(boc: string) {
    this.sent.push(boc)
  }
  async findPayment(_w: string, comment: string) {
    const h = this.landed.get(comment)
    return h ? { txHash: h } : null
  }
}

class FakeTg implements TelegramPort {
  sent: { chat_id: number; text: string; business_connection_id?: string; reply_to_message_id?: number }[] = []
  cards = new Map<number, string>()
  async getChat(id: number) {
    const a = this.cards.get(id)
    return { id, type: 'private' as const, ...(a ? { ton_wallet_card: { address: a, amount: '0' } } : {}) }
  }
  async sendMessage(p: { chat_id: number; text: string }) {
    this.sent.push(p)
    return { message_id: 1, chat: { id: p.chat_id, type: 'private' as const }, date: 0 }
  }
  async downloadFile() {
    return new Uint8Array([1, 2, 3])
  }
}

class FakeLlm implements LlmPort {
  next: RawIntent | null = null
  voiceNext: VoiceIntent = { kind: 'unknown', heard: '' }
  async extract() {
    return this.next
  }
  async voice() {
    return this.voiceNext
  }
}

class FakeStt implements SttPort {
  text: string | null = 'pay one and say enjoy'
  async transcribe() {
    return this.text
  }
}

class FakeLens implements LensPort {
  msgs: { tgId: string; m: ServerToLens }[] = []
  push(tgId: string, m: ServerToLens) {
    this.msgs.push({ tgId, m })
  }
  connected() {
    return true
  }
  of<T extends ServerToLens['t']>(t: T) {
    return this.msgs.map(x => x.m).filter((m): m is Extract<ServerToLens, { t: T }> => m.t === t)
  }
}

const raw = (over: Partial<RawIntent> = {}): RawIntent => ({
  is_request: true,
  kind: 'pay_request',
  amount: '1.5',
  currency: 'GRAM',
  memo: 'taxi home',
  urgency: false,
  addresses_assistant: false,
  ...over,
})

const tick = () => new Promise(r => setTimeout(r, 5))

let store: Store, chain: FakeChain, tg: FakeTg, llm: FakeLlm, stt: FakeStt, lens: FakeLens, svc: Service
let verifyOk = true

beforeEach(() => {
  store = new Store()
  chain = new FakeChain()
  tg = new FakeTg()
  llm = new FakeLlm()
  stt = new FakeStt()
  lens = new FakeLens()
  verifyOk = true
  const cfg: ServiceConfig = {
    networkId: -3,
    explorerTx: h => `https://testnet.tonviewer.com/transaction/${h}`,
    payWindowSec: 120,
    confirmPollMs: 1,
    confirmTimeoutMs: 200,
    usdPerGram: () => 1.05,
    verifySigned: () => verifyOk,
  }
  svc = new Service(store, tg, chain, llm, stt, lens, { now: () => Date.now() }, cfg)
  store.upsertUser({ tg_id: PAYER, name: 'Yehor', business_connection_id: 'bc1' })
  store.setWallets(PAYER, { owner: addr(5), wallet: addr(6), ext: addr(7) })
  tg.cards.set(42, MIA)
  llm.next = raw()
})

const incoming = () =>
  svc.handleMessage({
    payerTgId: PAYER,
    chat: { id: 42, kind: 'dm' },
    from: { tgId: 42, name: 'Mia' },
    text: 'can you send me 1.5 for the taxi home?',
    messageId: 900,
    businessConnectionId: 'bc1',
  })

describe('service', () => {
  it('a money ask in a DM becomes a card on the paired lens, paid to the profile wallet', async () => {
    const r = await incoming()
    expect(r.askId).toBeTruthy()
    const [ask] = lens.of('ask')
    expect(ask!.ask).toMatchObject({ amountNano: '1500000000', memo: 'taxi home', recipient: { address: MIA, source: 'profile_card' } })
  })

  it('an ordinary message never reaches the lens', async () => {
    llm.next = raw({ is_request: false, kind: 'none', amount: null })
    expect((await incoming()).dropped).toBe('not_a_request')
    expect(lens.msgs).toHaveLength(0)
  })

  it('second pay for same askId is ignored', async () => {
    const { askId } = await incoming()
    await Promise.all([svc.decision(PAYER, { askId: askId!, action: 'pay' }), svc.decision(PAYER, { askId: askId!, action: 'pay' })])
    expect(lens.of('pay_params')).toHaveLength(1)
    const p = lens.of('pay_params')[0]!.params
    expect(p).toMatchObject({ seqno: 3, dest: MIA, amountNano: '1500000000', networkId: -3, comment: 'Thruppence #41 · taxi home' })
  })

  it('signed → relayed once → paid → receipt in the original chat, as the payer', async () => {
    const { askId } = await incoming()
    await svc.decision(PAYER, { askId: askId!, action: 'pay' })
    const p = lens.of('pay_params')[0]!.params
    chain.landed.set(p.comment, 'abc123')
    await svc.signed(PAYER, askId!, 'boc==')
    await svc.signed(PAYER, askId!, 'boc==')
    for (let i = 0; i < 20 && !lens.of('paid').length; i++) await tick()
    expect(chain.sent).toEqual(['boc=='])
    expect(lens.of('paid')[0]).toMatchObject({ askId, txHash: 'abc123', receiptSent: true })
    expect(tg.sent[0]).toMatchObject({ chat_id: 42, business_connection_id: 'bc1', reply_to_message_id: 900 })
    expect(tg.sent[0]!.text).toContain('Sent 1.5 GRAM ✓ · taxi home')
    expect(tg.sent[0]!.text).toContain('testnet.tonviewer.com/transaction/abc123')
    expect(store.ask(askId!)!.status).toBe('paid')
  })

  it('pending pay survives lens reconnect: the receipt still lands in the chat', async () => {
    const { askId } = await incoming()
    await svc.decision(PAYER, { askId: askId!, action: 'pay' })
    await svc.signed(PAYER, askId!, 'boc==')
    lens.msgs = [] // the lens dropped
    chain.landed.set(`Thruppence #41 · taxi home`, 'h2')
    for (let i = 0; i < 20 && store.ask(askId!)!.status !== 'paid'; i++) await tick()
    expect(store.ask(askId!)!.status).toBe('paid')
    expect(tg.sent).toHaveLength(1)
    await svc.lensHello(PAYER, 'Yehor')
    expect(lens.of('ask')).toHaveLength(0)
  })

  it('a signature that does not match the ask is refused and nothing is relayed', async () => {
    const { askId } = await incoming()
    await svc.decision(PAYER, { askId: askId!, action: 'pay' })
    verifyOk = false
    await svc.signed(PAYER, askId!, 'evil==')
    expect(chain.sent).toEqual([])
    expect(lens.of('pay_failed')).toHaveLength(1)
    expect(store.ask(askId!)!.status).toBe('open')
  })

  it('limits are re-checked at pay time against the chain', async () => {
    const { askId } = await incoming()
    chain.info.spentNano = 4_000_000_000n
    await svc.decision(PAYER, { askId: askId!, action: 'pay' })
    expect(lens.of('pay_params')).toHaveLength(0)
    expect(lens.of('pay_failed')[0]!.reason).toContain('1 GRAM left today')
  })

  it('a blocked ask cannot be paid even if the lens asks', async () => {
    const { askId } = await svc.handleMessage({
      payerTgId: PAYER,
      chat: { id: 42, kind: 'dm' },
      from: { tgId: 42, name: 'Mia' },
      text: `send me 1.5 to ${addr(9)}`,
      messageId: 901,
    })
    expect(lens.of('ask')[0]!.ask.risk.level).toBe('block')
    await svc.decision(PAYER, { askId: askId!, action: 'pay' })
    expect(lens.of('pay_params')).toHaveLength(0)
  })

  it('decline with a reply answers in the chat as the payer', async () => {
    const { askId } = await incoming()
    await svc.decision(PAYER, { askId: askId!, action: 'decline', reply: 'next week!' })
    expect(tg.sent[0]).toMatchObject({ chat_id: 42, text: 'next week!', business_connection_id: 'bc1' })
    expect(store.ask(askId!)!.status).toBe('declined')
  })

  it('voice: an amount the wearer did not say is not accepted', async () => {
    svc.pttStart(PAYER, 'x')
    svc.pttAudio(PAYER, Buffer.alloc(8000).toString('base64'))
    stt.text = 'pay her back please'
    llm.voiceNext = { kind: 'pay', amountNano: '1500000000' }
    await svc.pttStop(PAYER)
    expect(lens.of('voice_intent')[0]!.intent.kind).toBe('unknown')
  })

  it('voice: "pay one and say enjoy" becomes a pay intent with a reply', async () => {
    svc.pttStart(PAYER, 'x')
    svc.pttAudio(PAYER, Buffer.alloc(8000).toString('base64'))
    stt.text = 'pay 1 and say enjoy'
    llm.voiceNext = { kind: 'pay', amountNano: '1000000000', reply: 'enjoy!' }
    await svc.pttStop(PAYER)
    expect(lens.of('voice_intent')[0]!.intent).toEqual({ kind: 'pay', amountNano: '1000000000', reply: 'enjoy!' })
  })
})
