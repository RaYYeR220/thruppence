import { readFileSync } from 'node:fs'
import { Address, Cell } from '@ton/core'
import { describe, expect, it } from 'vitest'
import { agenticWalletAddress, agenticWalletCode, allowanceAddresses, limitsExtensionAddress, limitsExtensionCode, setupMessages } from '../src/setup'

const fx = JSON.parse(readFileSync(new URL('../../../contracts/tests/fixtures/payrequest.json', import.meta.url), 'utf8'))
const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))

describe('setup matches the contract vectors', () => {
  it('ships the official agentic wallet bytecode', () => {
    expect(agenticWalletCode().hash().toString('hex')).toBe(fx.agenticWallet.codeHashHex)
  })
  it('ships the tested limits extension bytecode', () => {
    expect(limitsExtensionCode().hash().toString('hex')).toBe(fx.extension.codeHashHex)
  })
  it('derives the agentic wallet address', () => {
    const a = agenticWalletAddress(fx.inputs.owner, hex(fx.agenticWallet.operatorPublicKeyHex))
    expect(a.equals(Address.parse(fx.agenticWallet.address))).toBe(true)
  })
  it('derives the extension address', () => {
    const a = limitsExtensionAddress(Address.parse(fx.extension.wallet), {
      owner: fx.inputs.owner,
      devicePublicKey: hex(fx.extension.deviceKeyHex),
      networkId: -3,
      perTxNano: BigInt(fx.extension.perTxCap),
      dailyNano: BigInt(fx.extension.dailyCap),
    }, fx.extension.seqno)
    expect(a.equals(Address.parse(fx.extension.address))).toBe(true)
  })
})

describe('setupMessages', () => {
  const plan = { owner: fx.inputs.owner, devicePublicKey: hex(fx.devicePublicKeyHex), networkId: -3, perTxNano: 2_000_000_000n, dailyNano: 5_000_000_000n }
  const msgs = setupMessages(plan, 1_500_000_000n, 300_000_000n)
  const { wallet, ext } = allowanceAddresses(plan)
  it('deploys wallet and extension, then wires them, in that order', () => {
    expect(msgs).toHaveLength(3)
    expect(Address.parse(msgs[0]!.address).equals(wallet)).toBe(true)
    expect(Address.parse(msgs[1]!.address).equals(ext)).toBe(true)
    expect(Address.parse(msgs[2]!.address).equals(wallet)).toBe(true)
    expect(msgs[0]!.stateInit && msgs[1]!.stateInit).toBeTruthy()
  })
  it('the wiring message adds the extension and disables the operator signature', () => {
    const s = Cell.fromBoc(Buffer.from(msgs[2]!.payload!, 'base64'))[0]!.beginParse()
    expect(s.loadUint(32)).toBe(0xed84cbf0)
    s.loadUintBig(64)
    expect(s.loadMaybeRef()).toBeNull()
    expect(s.loadBit()).toBe(true)
    expect(s.loadUint(8)).toBe(0x02)
    expect(s.loadAddress().equals(ext)).toBe(true)
    const next = s.loadRef().beginParse()
    expect(next.loadUint(8)).toBe(0x04)
    expect(next.loadBit()).toBe(false)
  })
})
