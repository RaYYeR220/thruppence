import { devicePublicKey, signPayExternal, type PayParams } from '@thruppence/core'
import type { DemoSigner } from '../ports'

/**
 * Stands in for a phone on the public "try it" page, which has no glasses and
 * no phone. It holds a testnet-only key for the shared demo wallet, whose
 * limits extension caps what it can ever move. Real users' keys never leave
 * their phones.
 */
export class DemoDevice implements DemoSigner {
  private readonly seed: Uint8Array
  constructor(seedHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('DEMO_DEVICE_SEED must be 32 bytes hex')
    this.seed = Buffer.from(seedHex, 'hex')
  }
  get publicKeyHex(): string {
    return Buffer.from(devicePublicKey(this.seed)).toString('hex')
  }
  async sign(params: PayParams): Promise<string> {
    return signPayExternal(params, this.seed)
  }
}
