import { readFileSync } from 'node:fs'
import { Address, Cell } from '@ton/core'
import { describe, expect, it } from 'vitest'
import { commentCell, decodePayExternal, devicePublicKey, payRequestCell, signedBody, signPayExternal, verifySignedPay } from '../src/payRequest'
import type { PayParams } from '../src/types'

const fx = JSON.parse(readFileSync(new URL('../../../contracts/tests/fixtures/payrequest.json', import.meta.url), 'utf8'))
const seed = Buffer.from(fx.inputs.deviceSeedHex, 'hex')
const params: PayParams = {
  askId: 'x',
  networkId: fx.inputs.networkId,
  extAddress: fx.extension.address,
  seqno: fx.inputs.seqno,
  validUntil: fx.inputs.validUntil,
  dest: fx.inputs.dest,
  amountNano: fx.inputs.amount,
  bounce: fx.inputs.bounce,
  requestId: fx.inputs.requestId,
  comment: fx.inputs.comment,
}
const hashOf = (hex: string) => Cell.fromBoc(Buffer.from(hex, 'hex'))[0]!.hash().toString('hex')

describe('PayRequest matches the contract reference vector', () => {
  it('device public key', () => expect(Buffer.from(devicePublicKey(seed)).toString('hex')).toBe(fx.devicePublicKeyHex))
  it('comment cell', () => expect(commentCell(params.comment).hash().toString('hex')).toBe(hashOf(fx.expected.commentCellBocHex)))
  it('request cell hash', () => expect(payRequestCell(params).hash().toString('hex')).toBe(fx.expected.requestHashHex))
  it('signed body', () => expect(signedBody(params, seed).hash().toString('hex')).toBe(fx.expected.externalBodyHashHex))
  it('external message', () => {
    const boc = signPayExternal(params, seed)
    expect(Cell.fromBoc(Buffer.from(boc, 'base64'))[0]!.hash().toString('hex')).toBe(hashOf(fx.expected.externalMessageBocHex))
  })
})

describe('decode and verify', () => {
  const boc = signPayExternal(params, seed)
  it('round-trips every field', () => {
    const d = decodePayExternal(boc)
    expect(d.dest.equals(Address.parse(params.dest))).toBe(true)
    expect(d.amountNano).toBe(2_500_000_000n)
    expect(d.comment).toBe('Thruppence #42 · concert tickets')
    expect(d.requestId).toBe(42n)
  })
  it('accepts the exact params with the right key', () => expect(verifySignedPay(boc, params, devicePublicKey(seed))).toBe(true))
  it('rejects a different destination', () => expect(verifySignedPay(boc, { ...params, dest: fx.inputs.owner })).toBe(false))
  it('rejects a different amount', () => expect(verifySignedPay(boc, { ...params, amountNano: '2500000001' })).toBe(false))
  it('rejects a signature by another key', () => {
    const other = signPayExternal(params, Buffer.alloc(32, 7))
    expect(verifySignedPay(other, params, devicePublicKey(seed))).toBe(false)
  })
  it('rejects garbage', () => expect(verifySignedPay('aGVsbG8=', params)).toBe(false))
})
