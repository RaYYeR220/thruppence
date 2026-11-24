import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { devicePublicKey, signPayExternal, type PayParams } from '@thruppence/core'

const toHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16)))

/**
 * The device key lives only on this phone, inside the Even app's storage for
 * this plugin. It can sign pay requests to the limits extension and nothing
 * else: the extension caps what any signature can move.
 */
export class DeviceKey {
  private constructor(
    private readonly seed: Uint8Array,
    readonly publicHex: string,
  ) {}

  static async loadOrCreate(bridge: EvenAppBridge): Promise<DeviceKey> {
    let hex = await bridge.getLocalStorage('thruppence.device-seed').catch(() => '')
    if (!hex || hex.length !== 64) {
      const seed = crypto.getRandomValues(new Uint8Array(32))
      hex = toHex(seed)
      await bridge.setLocalStorage('thruppence.device-seed', hex)
    }
    const seed = fromHex(hex)
    return new DeviceKey(seed, toHex(devicePublicKey(seed)))
  }

  signPay(params: PayParams): Promise<string> {
    return Promise.resolve(signPayExternal(params, this.seed))
  }
}
