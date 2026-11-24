import './polyfill'
import { Address } from '@ton/core'
import { allowanceAddresses, NETWORK, ownerOps, parseGram, setupMessages, type AllowancePlan } from '@thruppence/core'
import { TonConnectUI } from '@tonconnect/ui'

const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://127.0.0.1:8787'
const TESTNET = ((import.meta.env.VITE_NETWORK as string | undefined) ?? 'testnet') === 'testnet'
const NET = TESTNET ? NETWORK.testnet : NETWORK.mainnet
const EXPLORER = TESTNET ? 'https://testnet.tonviewer.com' : 'https://tonviewer.com'

const q = new URLSearchParams(location.search)
const device = { deviceId: q.get('d') ?? '', token: q.get('t') ?? '', pub: q.get('k') ?? '' }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const say = (id: string, text: string) => ($(id).textContent = text)

const tc = new TonConnectUI({ manifestUrl: `${location.origin}/tonconnect-manifest.json`, buttonRootId: 'connect' })

function readPlan(owner: string): AllowancePlan | null {
  const perTx = parseGram($<HTMLInputElement>('per-tx').value)
  const daily = parseGram($<HTMLInputElement>('daily').value)
  if (!perTx || !daily || BigInt(perTx) > BigInt(daily) || !/^[0-9a-f]{64}$/i.test(device.pub)) return null
  return {
    owner,
    devicePublicKey: new Uint8Array(device.pub.match(/../g)!.map(h => parseInt(h, 16))),
    networkId: NET,
    perTxNano: BigInt(perTx),
    dailyNano: BigInt(daily),
  }
}

function owner(): string | null {
  const a = tc.account
  return a ? Address.parse(a.address).toRawString() : null
}

function refresh() {
  const o = owner()
  const plan = o ? readPlan(o) : null
  $<HTMLButtonElement>('create').disabled = !plan
  if (!device.deviceId) say('device', 'Open this page from Thruppence on your glasses to link a device.')
  else say('device', `Device key ${device.pub.slice(0, 8)}…${device.pub.slice(-8)}`)
  if (plan) {
    const { wallet, ext } = allowanceAddresses(plan)
    say('addr-wallet', wallet.toString({ testOnly: TESTNET, bounceable: false }))
    say('addr-ext', ext.toString({ testOnly: TESTNET, bounceable: false }))
  }
}

$('create').addEventListener('click', async () => {
  const o = owner()
  const plan = o ? readPlan(o) : null
  const fund = parseGram($<HTMLInputElement>('fund').value)
  if (!plan || !fund) return
  const msgs = setupMessages(plan, BigInt(fund), 250_000_000n)
  say('result', 'Confirm in your wallet…')
  try {
    await tc.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      network: String(NET) as '-3' | '-239',
      messages: msgs.map(({ address, amount, stateInit, payload }) => ({ address, amount, ...(stateInit ? { stateInit } : {}), ...(payload ? { payload } : {}) })),
    })
    const { wallet, ext } = allowanceAddresses(plan)
    const r = await fetch(`${SERVER}/api/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId, token: device.token, owner: plan.owner, wallet: wallet.toRawString(), ext: ext.toRawString() }),
    })
    say('result', r.ok ? 'Done. Your glasses can pay now, up to the limits you set.' : 'Sent on chain, but the glasses did not get the news. Reopen Thruppence on your glasses.')
    $<HTMLAnchorElement>('explore').href = `${EXPLORER}/${wallet.toString({ testOnly: TESTNET, bounceable: false })}`
    $('explore').hidden = false
  } catch {
    say('result', 'Cancelled. Nothing was sent.')
  }
})

async function ownerOp(payload: string, label: string) {
  const o = owner()
  const plan = o ? readPlan(o) : null
  if (!plan) return
  const { ext } = allowanceAddresses(plan)
  try {
    await tc.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      network: String(NET) as '-3' | '-239',
      messages: [{ address: ext.toString({ testOnly: TESTNET, bounceable: true }), amount: '50000000', payload }],
    })
    say('result', `${label}: sent.`)
  } catch {
    say('result', `${label}: cancelled.`)
  }
}

$('pause').addEventListener('click', () => void ownerOp(ownerOps.setPaused(true), 'Pause'))
$('resume').addEventListener('click', () => void ownerOp(ownerOps.setPaused(false), 'Resume'))
for (const id of ['per-tx', 'daily', 'fund']) $(id).addEventListener('input', refresh)
tc.onStatusChange(refresh)
refresh()
