import { Address, beginCell, Cell, external, storeMessage } from '@ton/core'
import { keyPairFromSeed, sign, signVerify } from '@ton/crypto'
import type { PayParams } from './types'

/**
 * The PayRequest a device signs for the limits extension. Field order is the
 * on-chain wire format (see contracts/tests/fixtures/payrequest.json):
 * op · networkId · extAddress · seqno · validUntil · dest · amount · bounce ·
 * requestId · ^comment. The signature covers the request cell's hash.
 */
export const OP_PAY_REQUEST = 0x50415952

export function commentCell(text: string): Cell {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > 123) throw new Error('comment longer than one cell')
  return beginCell().storeUint(0, 32).storeBuffer(bytes).endCell()
}

export function payRequestCell(p: PayParams): Cell {
  return beginCell()
    .storeUint(OP_PAY_REQUEST, 32)
    .storeInt(p.networkId, 32)
    .storeAddress(Address.parse(p.extAddress))
    .storeUint(p.seqno, 32)
    .storeUint(p.validUntil, 32)
    .storeAddress(Address.parse(p.dest))
    .storeCoins(BigInt(p.amountNano))
    .storeBit(p.bounce)
    .storeUint(BigInt(p.requestId), 64)
    .storeRef(commentCell(p.comment))
    .endCell()
}

export function devicePublicKey(seed: Uint8Array): Uint8Array {
  return new Uint8Array(keyPairFromSeed(Buffer.from(seed)).publicKey)
}

export function signedBody(p: PayParams, seed: Uint8Array): Cell {
  const req = payRequestCell(p)
  const sig = sign(req.hash(), keyPairFromSeed(Buffer.from(seed)).secretKey)
  return beginCell().storeBuffer(sig).storeRef(req).endCell()
}

/** The full external message, base64 BOC, ready for sendBoc. */
export function signPayExternal(p: PayParams, seed: Uint8Array): string {
  const msg = external({ to: Address.parse(p.extAddress), body: signedBody(p, seed) })
  return beginCell().store(storeMessage(msg)).endCell().toBoc().toString('base64')
}

export interface DecodedPay {
  networkId: number
  extAddress: Address
  seqno: number
  validUntil: number
  dest: Address
  amountNano: bigint
  bounce: boolean
  requestId: bigint
  comment: string
  signature: Buffer
  requestHash: Buffer
}

/** Reads a signed external message back. Throws on anything that is not a PayRequest. */
export function decodePayExternal(boc: string): DecodedPay {
  const root = Cell.fromBoc(Buffer.from(boc, 'base64'))[0]!
  const s = root.beginParse()
  // ext_in_msg_info$10 src:MsgAddressExt dest:MsgAddressInt import_fee:Grams
  if (s.loadUint(2) !== 2) throw new Error('not an external message')
  s.loadMaybeAddress()
  s.loadAddress()
  s.loadCoins()
  if (s.loadBit()) throw new Error('unexpected state init')
  const body = s.loadBit() ? s.loadRef().beginParse() : s
  const signature = body.loadBuffer(64)
  const reqCell = body.loadRef()
  const r = reqCell.beginParse()
  if (r.loadUint(32) !== OP_PAY_REQUEST) throw new Error('not a pay request')
  const networkId = r.loadInt(32)
  const extAddress = r.loadAddress()
  const seqno = r.loadUint(32)
  const validUntil = r.loadUint(32)
  const dest = r.loadAddress()
  const amountNano = r.loadCoins()
  const bounce = r.loadBit()
  const requestId = r.loadUintBig(64)
  const c = r.loadRef().beginParse()
  if (c.loadUint(32) !== 0) throw new Error('comment is not text')
  const comment = c.loadStringTail()
  return { networkId, extAddress, seqno, validUntil, dest, amountNano, bounce, requestId, comment, signature, requestHash: reqCell.hash() }
}

/**
 * Server-side check before relaying: the signed message pays exactly what
 * the params say. The signature itself is checked on-chain by the extension;
 * here it is checked too when the device key is known.
 */
export function verifySignedPay(boc: string, p: PayParams, devicePubKey?: Uint8Array): boolean {
  try {
    const d = decodePayExternal(boc)
    const ok =
      d.networkId === p.networkId &&
      d.extAddress.equals(Address.parse(p.extAddress)) &&
      d.seqno === p.seqno &&
      d.validUntil === p.validUntil &&
      d.dest.equals(Address.parse(p.dest)) &&
      d.amountNano === BigInt(p.amountNano) &&
      d.bounce === p.bounce &&
      d.requestId === BigInt(p.requestId) &&
      d.comment === p.comment
    if (!ok) return false
    return devicePubKey ? signVerify(d.requestHash, d.signature, Buffer.from(devicePubKey)) : true
  } catch {
    return false
  }
}
