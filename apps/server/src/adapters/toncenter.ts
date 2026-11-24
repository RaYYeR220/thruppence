import { Address, Cell } from '@ton/core'
import { TonClient } from '@ton/ton'
import type { ChainPort, ExtInfo } from '../ports'

/** Spaces out calls so a keyless toncenter endpoint (1 rps) never rate-limits us. */
class Pacer {
  private last = 0
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly gapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.gapMs - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      this.last = Date.now()
      return fn()
    })
    this.chain = next.catch(() => undefined)
    return next
  }
}

function commentOf(body: Cell): string | null {
  try {
    const s = body.beginParse()
    if (s.remainingBits < 32 || s.loadUint(32) !== 0) return null
    return s.loadStringTail()
  } catch {
    return null
  }
}

export class ToncenterChain implements ChainPort {
  private readonly client: TonClient
  private readonly pacer: Pacer
  private cache = new Map<string, { at: number; v: ExtInfo }>()

  constructor(endpoint: string, apiKey?: string) {
    this.client = new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) })
    this.pacer = new Pacer(apiKey ? 120 : 1100)
  }

  async extInfo(ext: string): Promise<ExtInfo> {
    const hit = this.cache.get(ext)
    if (hit && Date.now() - hit.at < 2500) return hit.v
    const a = Address.parse(ext)
    const limits = await this.pacer.run(() => this.client.runMethod(a, 'get_limits'))
    const spent = await this.pacer.run(() => this.client.runMethod(a, 'get_spent'))
    const seqno = await this.pacer.run(() => this.client.runMethod(a, 'seqno'))
    const v: ExtInfo = {
      perTxNano: limits.stack.readBigNumber(),
      dailyNano: limits.stack.readBigNumber(),
      paused: limits.stack.readBoolean(),
      spentNano: spent.stack.readBigNumber(),
      seqno: seqno.stack.readNumber(),
    }
    this.cache.set(ext, { at: Date.now(), v })
    return v
  }

  balance(addr: string): Promise<bigint> {
    return this.pacer.run(() => this.client.getBalance(Address.parse(addr)))
  }

  async isActive(addr: string): Promise<boolean> {
    const st = await this.pacer.run(() => this.client.getContractState(Address.parse(addr)))
    return st.state === 'active'
  }

  async sendExternal(boc: string): Promise<void> {
    this.cache.clear()
    await this.pacer.run(() => this.client.sendFile(Buffer.from(boc, 'base64')))
  }

  async findPayment(wallet: string, comment: string, sinceSec: number): Promise<{ txHash: string } | null> {
    const txs = await this.pacer.run(() => this.client.getTransactions(Address.parse(wallet), { limit: 20, archival: true }))
    for (const tx of txs) {
      if (tx.now < sinceSec) continue
      for (const m of tx.outMessages.values()) {
        if (m.info.type === 'internal' && commentOf(m.body) === comment) return { txHash: tx.hash().toString('hex') }
      }
    }
    return null
  }
}
