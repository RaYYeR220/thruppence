/**
 * Operator tool for a capped wallet on TON testnet.
 *
 *   tsx scripts/allowance.ts setup   deploy the agentic wallet + limits extension for a device
 *   tsx scripts/allowance.ts status  read balance, limits and spend from chain
 *   tsx scripts/allowance.ts pay <to> <gram> [memo]   sign a PayRequest with the device key and send it
 *
 * Env: OWNER_MNEMONIC (24 words, testnet W5 owner), DEVICE_SEED (32-byte hex),
 *      PER_TX, DAILY, FUND_WALLET, FUND_EXT (GRAM), TONCENTER_API_KEY (optional)
 */
import { Address, Cell, internal, loadStateInit, SendMode, toNano } from '@ton/core'
import { mnemonicToPrivateKey } from '@ton/crypto'
import { TonClient, WalletContractV5R1 } from '@ton/ton'
import { allowanceAddresses, devicePublicKey, NETWORK, setupMessages, signPayExternal, type PayParams } from '@thruppence/core'

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d
  if (!v) throw new Error(`missing ${k}`)
  return v
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', ...(process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {}) })
const fmt = (a: Address) => a.toString({ testOnly: true, bounceable: false })

let lastCall = 0
async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    // Keyless toncenter allows one request per second.
    const gap = (process.env.TONCENTER_API_KEY ? 150 : 1200) - (Date.now() - lastCall)
    if (gap > 0) await sleep(gap)
    lastCall = Date.now()
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      await sleep(1500 * (i + 1))
    }
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const kp = await mnemonicToPrivateKey(env('OWNER_MNEMONIC').split(/\s+/))
  const owner = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey, walletId: { networkGlobalId: NETWORK.testnet } })
  const seed = Buffer.from(env('DEVICE_SEED'), 'hex')
  const plan = {
    owner: owner.address.toRawString(),
    devicePublicKey: devicePublicKey(seed),
    networkId: NETWORK.testnet,
    perTxNano: toNano(env('PER_TX', '0.5')),
    dailyNano: toNano(env('DAILY', '1.5')),
  }
  const { wallet, ext } = allowanceAddresses(plan)
  console.log('owner ', fmt(owner.address))
  console.log('wallet', fmt(wallet))
  console.log('ext   ', fmt(ext))

  if (cmd === 'setup') {
    const msgs = setupMessages(plan, toNano(env('FUND_WALLET', '1.2')), toNano(env('FUND_EXT', '0.25')))
    const o = client.open(owner)
    const seqno = await retry(() => o.getSeqno())
    await retry(() =>
      o.sendTransfer({
        seqno,
        secretKey: kp.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: msgs.map(m =>
          internal({
            to: Address.parse(m.address),
            value: BigInt(m.amount),
            bounce: Address.parseFriendly(m.address).isBounceable,
            ...(m.stateInit ? { init: loadStateInit(Cell.fromBoc(Buffer.from(m.stateInit, 'base64'))[0]!.beginParse()) } : {}),
            ...(m.payload ? { body: Cell.fromBoc(Buffer.from(m.payload, 'base64'))[0]! } : {}),
          }),
        ),
      }),
    )
    console.log('setup sent, owner seqno', seqno)
    for (let i = 0; i < 30; i++) {
      await sleep(3000)
      const st = await retry(() => client.getContractState(ext))
      if (st.state === 'active') {
        console.log('extension active')
        break
      }
    }
    await sleep(6000)
    return status(wallet, ext)
  }
  if (cmd === 'status') return status(wallet, ext)
  if (cmd === 'pay') {
    const [to, gram, ...memo] = args
    const seqno = (await retry(() => client.runMethod(ext, 'seqno'))).stack.readNumber()
    const dest = Address.parse(to!)
    const destState = await retry(() => client.getContractState(dest))
    const rid = String(Date.now() % 1_000_000)
    const params: PayParams = {
      askId: 'cli',
      networkId: NETWORK.testnet,
      extAddress: ext.toRawString(),
      seqno,
      validUntil: Math.floor(Date.now() / 1000) + 120,
      dest: dest.toRawString(),
      amountNano: toNano(gram!).toString(),
      bounce: destState.state === 'active',
      requestId: rid,
      comment: `Thruppence #${rid} · ${memo.join(' ') || 'test'}`,
    }
    const boc = signPayExternal(params, seed)
    await retry(() => client.sendFile(Buffer.from(boc, 'base64')), 1)
    console.log('sent', params.comment)
    for (let i = 0; i < 30; i++) {
      await sleep(3000)
      const txs = await retry(() => client.getTransactions(wallet, { limit: 5 }))
      for (const tx of txs) {
        for (const m of tx.outMessages.values()) {
          const s = m.body.beginParse()
          if (s.remainingBits >= 32 && s.loadUint(32) === 0 && s.loadStringTail() === params.comment) {
            console.log('paid in tx', tx.hash().toString('hex'))
            console.log(`https://testnet.tonviewer.com/transaction/${tx.hash().toString('hex')}`)
            return status(wallet, ext)
          }
        }
      }
    }
    throw new Error('payment not seen in 90 s')
  }
  if (cmd !== 'setup' && cmd !== 'status' && cmd !== 'pay') console.log('commands: setup | status | pay <to> <gram> [memo]')
}

async function status(wallet: Address, ext: Address) {
  const bal = await retry(() => client.getBalance(wallet))
  const extBal = await retry(() => client.getBalance(ext))
  const limits = await retry(() => client.runMethod(ext, 'get_limits'))
  const spent = await retry(() => client.runMethod(ext, 'get_spent'))
  const ext2 = await retry(() => client.runMethod(wallet, 'is_signature_allowed'))
  console.log({
    walletBalance: Number(bal) / 1e9,
    extGas: Number(extBal) / 1e9,
    perTx: Number(limits.stack.readBigNumber()) / 1e9,
    daily: Number(limits.stack.readBigNumber()) / 1e9,
    paused: limits.stack.readBoolean(),
    spent: Number(spent.stack.readBigNumber()) / 1e9,
    operatorSignatureAllowed: ext2.stack.readBoolean(),
  })
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
