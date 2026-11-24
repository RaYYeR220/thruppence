import { Address, beginCell, Cell, contractAddress, storeStateInit, type StateInit } from '@ton/core'
import { AGENTIC_WALLET_CODE_HEX, LIMITS_EXTENSION_CODE_HEX } from './codes'

/** TonTech's shared collection for agentic wallets (same address on testnet and mainnet). */
export const AGENTIC_COLLECTION = 'EQByQ19qvWxW7VibSbGEgZiYMqilHY5y1a_eeSL2VaXhfy07'
export const NETWORK = { mainnet: -239, testnet: -3 } as const

const OP_DEPLOY_WALLET = 0x0609e47b
const OP_EXTENSION_ACTION = 0xed84cbf0
const OP_SET_LIMITS = 0x4c494d54
const OP_SET_PAUSED = 0x50415553
const OP_SET_DEVICE = 0x44455643
const OP_WITHDRAW = 0x57445257
const EXTRA_ADD_EXTENSION = 0x02
const EXTRA_SET_SIGNATURE_ALLOWED = 0x04

const codeOf = (hex: string) => Cell.fromBoc(Buffer.from(hex, 'hex'))[0]!
export const agenticWalletCode = () => codeOf(AGENTIC_WALLET_CODE_HEX)
export const limitsExtensionCode = () => codeOf(LIMITS_EXTENSION_CODE_HEX)

const pubInt = (pub: Uint8Array) => BigInt('0x' + Buffer.from(pub).toString('hex'))

export interface AllowancePlan {
  /** The user's main wallet (Gram Wallet / any TON wallet). It owns everything below. */
  owner: string
  /** The phone's device key (32 bytes). */
  devicePublicKey: Uint8Array
  networkId: number
  perTxNano: bigint
  dailyNano: bigint
}

function walletInit(p: Pick<AllowancePlan, 'owner' | 'devicePublicKey'>): StateInit {
  const owner = Address.parse(p.owner)
  const index = BigInt('0x' + beginCell().storeAddress(owner).storeUint(pubInt(p.devicePublicKey), 256).storeBit(true).endCell().hash().toString('hex'))
  const data = beginCell()
    .storeUint(index, 256)
    .storeAddress(Address.parse(AGENTIC_COLLECTION))
    .storeBit(true)
    .storeUint(0, 32)
    .storeDict(null)
    .storeMaybeRef(null)
    .endCell()
  return { code: agenticWalletCode(), data }
}

function extInit(p: AllowancePlan, wallet: Address, seqno = 0): StateInit {
  const fixed = beginCell().storeAddress(wallet).storeAddress(Address.parse(p.owner)).storeInt(p.networkId, 32).endCell()
  const data = beginCell()
    .storeRef(fixed)
    .storeUint(pubInt(p.devicePublicKey), 256)
    .storeUint(seqno, 32)
    .storeCoins(p.perTxNano)
    .storeCoins(p.dailyNano)
    .storeUint(0, 32)
    .storeCoins(0n)
    .storeBit(false)
    .endCell()
  return { code: limitsExtensionCode(), data }
}

/** Address of the agentic wallet a user deploys with this operator key. */
export function agenticWalletAddress(owner: string, operatorPublicKey: Uint8Array): Address {
  return contractAddress(0, walletInit({ owner, devicePublicKey: operatorPublicKey }))
}

/** Address of a limits extension for this wallet, owner, device and caps. */
export function limitsExtensionAddress(wallet: Address, p: AllowancePlan, seqno = 0): Address {
  return contractAddress(0, extInit(p, wallet, seqno))
}

export function allowanceAddresses(p: AllowancePlan): { wallet: Address; ext: Address } {
  const wallet = contractAddress(0, walletInit(p))
  return { wallet, ext: contractAddress(0, extInit(p, wallet)) }
}

/** One message of a TON Connect `sendTransaction`, or of a wallet transfer. */
export interface SetupMessage {
  address: string
  amount: string
  stateInit?: string
  payload?: string
  /** What this message does, for the confirmation screen. */
  purpose: string
}

const b64 = (c: Cell) => c.toBoc().toString('base64')
const initB64 = (i: StateInit) => b64(beginCell().store(storeStateInit(i)).endCell())

/**
 * Everything the owner signs once, in one transaction:
 * 1. deploy + fund the agentic wallet (operator = the device key),
 * 2. deploy + fund the limits extension (it pays its own gas),
 * 3. add the extension to the wallet and switch the operator signature off,
 *    so the only way to spend is through the limits.
 */
export function setupMessages(p: AllowancePlan, fundWalletNano: bigint, fundExtNano: bigint): SetupMessage[] {
  const wInit = walletInit(p)
  const { wallet, ext } = allowanceAddresses(p)
  const op = pubInt(p.devicePublicKey)
  const runtime = beginCell().storeAddress(Address.parse(p.owner)).storeMaybeRef(null).storeUint(op, 256).storeUint(op, 256).storeBit(true).endCell()
  const deploy = beginCell().storeUint(OP_DEPLOY_WALLET, 32).storeUint(0, 64).storeRef(runtime).storeUint(0, 256).endCell()
  const disableSig = beginCell().storeUint(EXTRA_SET_SIGNATURE_ALLOWED, 8).storeBit(false).endCell()
  const addExt = beginCell().storeUint(EXTRA_ADD_EXTENSION, 8).storeAddress(ext).storeRef(disableSig).endCell()
  const wire = beginCell().storeUint(OP_EXTENSION_ACTION, 32).storeUint(1, 64).storeMaybeRef(null).storeBit(true).storeSlice(addExt.beginParse()).endCell()
  return [
    { address: wallet.toString({ bounceable: false, testOnly: p.networkId === NETWORK.testnet }), amount: fundWalletNano.toString(), stateInit: initB64(wInit), payload: b64(deploy), purpose: 'Create your capped wallet and fund it' },
    { address: ext.toString({ bounceable: false, testOnly: p.networkId === NETWORK.testnet }), amount: fundExtNano.toString(), stateInit: initB64(extInit(p, wallet)), purpose: 'Create the limits that guard it' },
    { address: wallet.toString({ bounceable: true, testOnly: p.networkId === NETWORK.testnet }), amount: '50000000', payload: b64(wire), purpose: 'Let only the limits spend from it' },
  ]
}

/** Owner-only controls, sent from the main wallet to the extension. */
export const ownerOps = {
  setLimits: (perTx: bigint, daily: bigint) => b64(beginCell().storeUint(OP_SET_LIMITS, 32).storeUint(0, 64).storeCoins(perTx).storeCoins(daily).endCell()),
  setPaused: (paused: boolean) => b64(beginCell().storeUint(OP_SET_PAUSED, 32).storeUint(0, 64).storeBit(paused).endCell()),
  setDevice: (pub: Uint8Array) => b64(beginCell().storeUint(OP_SET_DEVICE, 32).storeUint(0, 64).storeUint(pubInt(pub), 256).endCell()),
  withdraw: () => b64(beginCell().storeUint(OP_WITHDRAW, 32).storeUint(0, 64).endCell()),
}
