import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { serve } from '@hono/node-server'
import { verifySignedPay } from '@thruppence/core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { WebSocketServer } from 'ws'
import { Budget, VeniceLlm, VeniceStt } from './adapters/venice'
import { ToncenterChain } from './adapters/toncenter'
import { DemoDevice } from './demo/device'
import { Hub } from './hub'
import { Service, type DemoWallet } from './service'
import { Store } from './store'
import { TelegramApi, type TgUpdate } from './telegram/api'
import { UpdateRouter } from './telegram/updates'
import { OfflineTelegram, type BotLike } from './telegram/offline'

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

const PORT = Number(env('PORT', '8787'))
const PUBLIC_URL = process.env.PUBLIC_URL
const NETWORK_ID = Number(env('NETWORK_ID', '-3'))
const EXPLORER = env('EXPLORER', 'https://testnet.tonviewer.com')

const store = new Store(env('DB_PATH', 'thruppence.db'))
const offline = !process.env.BOT_TOKEN
const tg: BotLike = offline ? new OfflineTelegram() : new TelegramApi(env('BOT_TOKEN'))
const DEV = process.env.DEV === '1'
const chain = new ToncenterChain(
  env('TONCENTER_ENDPOINT', 'https://testnet.toncenter.com/api/v2/jsonRPC'),
  process.env.TONCENTER_API_KEY,
  process.env.TON_RPS ? Number(process.env.TON_RPS) : undefined,
  process.env.TON_FALLBACK_ENDPOINT ?? 'https://testnet.toncenter.com/api/v2/jsonRPC',
)
const llmCfg = { baseUrl: 'https://api.venice.ai/api/v1', apiKey: env('VENICE_API_KEY'), model: env('LLM_MODEL', 'claude-haiku-5-5'), timeoutMs: 8000 }
const llm = new VeniceLlm(llmCfg, new Budget(Number(env('LLM_DAILY_CAP', '3000'))))
const stt = new VeniceStt(llmCfg.baseUrl, llmCfg.apiKey, env('STT_MODEL', 'openai/whisper-large-v3'), new Budget(Number(env('STT_DAILY_CAP', '600'))))

// Try-it sessions: one per visitor of the public demo page.
const sessions = new Map<string, { created: number; tgId?: number }>()
const sessionByTg = new Map<number, string>()
const demoSessions = {
  exists: (id: string) => sessions.has(id),
  bind: (id: string, tgId: number) => {
    const s = sessions.get(id)
    if (!s) return false
    s.tgId = tgId
    sessionByTg.set(tgId, id)
    return true
  },
  sessionOf: (tgId: number) => sessionByTg.get(tgId) ?? null,
}

const demo: DemoWallet | undefined = process.env.DEMO_EXT
  ? { owner: env('DEMO_OWNER'), wallet: env('DEMO_WALLET'), ext: env('DEMO_EXT'), jar: env('DEMO_JAR') }
  : undefined
const demoDevice = process.env.DEMO_DEVICE_SEED ? new DemoDevice(env('DEMO_DEVICE_SEED')) : undefined

let usdPerGram: number | null = null
async function refreshPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd')
    const j = (await r.json()) as Record<string, { usd?: number }>
    usdPerGram = j['the-open-network']?.usd ?? usdPerGram
  } catch {
    // Keep the last known price; dollar asks are refused while it is unknown.
  }
}
void refreshPrice()
setInterval(refreshPrice, 10 * 60_000).unref()

const hub = new Hub(store, demoSessions)
const svc = new Service(
  store,
  tg,
  chain,
  llm,
  stt,
  hub,
  { now: () => Date.now() },
  {
    networkId: NETWORK_ID,
    explorerTx: h => `${EXPLORER}/transaction/${h}`,
    payWindowSec: 120,
    confirmPollMs: 2500,
    confirmTimeoutMs: 120_000,
    usdPerGram: () => usdPerGram,
    ...(demo ? { demo } : {}),
    verifySigned: (boc, p, tgId) => {
      // Real devices registered their key: check the signature here too, before anything is relayed.
      const pub = tgId && !tgId.startsWith('demo:') ? store.devicePubFor(tgId) : null
      return verifySignedPay(boc, p, pub ? Buffer.from(pub, 'hex') : undefined)
    },
  },
  demoDevice,
)
hub.attach(svc)
void svc.resume()
setInterval(() => void svc.resume(), 60_000).unref()

const me = await tg.getMe()
const router = new UpdateRouter({
  store,
  svc,
  tg,
  botUsername: me.username,
  onPaired: (deviceId, tgId) => hub.paired(deviceId, tgId),
  demo: demoSessions,
  demoRate: Number(env('DEMO_RATE', '6')),
})

const app = new Hono()
app.use('/api/*', cors())
app.get('/health', c => c.json({ ok: true, bot: me.username, network: NETWORK_ID }))

const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET ?? randomBytes(16).toString('hex')
app.post('/tg/webhook', async c => {
  if (c.req.header('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return c.text('no', 401)
  const update = (await c.req.json()) as TgUpdate
  void router.handle(update).catch(err => console.error('update failed', err))
  return c.text('ok')
})

// Devices: the glasses app registers once, then links to Telegram with a one-time code.
app.post('/api/devices', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { pub?: string }
  const pub = typeof body.pub === 'string' && /^[0-9a-f]{64}$/i.test(body.pub) ? body.pub.toLowerCase() : null
  const deviceId = randomUUID()
  const token = randomBytes(24).toString('base64url')
  store.addDevice(deviceId, token, pub)
  return c.json({ deviceId, token })
})

const authDevice = (deviceId?: string, token?: string) => {
  const d = deviceId ? store.device(deviceId) : undefined
  return d && token && d.token === token ? d : null
}

app.post('/api/pair', async c => {
  const { deviceId, token } = (await c.req.json()) as { deviceId?: string; token?: string }
  const d = authDevice(deviceId, token)
  if (!d) return c.json({ error: 'unknown device' }, 401)
  const code = randomBytes(6).toString('base64url')
  store.addPairCode(code, d.device_id, 10 * 60_000)
  return c.json({ code, link: `https://t.me/${me.username}?start=pair_${code}` })
})

app.get('/api/me', c => {
  const d = authDevice(c.req.query('deviceId'), c.req.query('token'))
  if (!d) return c.json({ error: 'unknown device' }, 401)
  const u = d.tg_id ? store.user(d.tg_id) : undefined
  return c.json({ paired: !!u, name: u?.name ?? null, business: !!u?.business_connection_id, wallets: u ? svc.wallets(u.tg_id) : null })
})

app.post('/api/wallets', async c => {
  const b = (await c.req.json()) as { deviceId?: string; token?: string; owner?: string; wallet?: string; ext?: string }
  const d = authDevice(b.deviceId, b.token)
  if (!d?.tg_id || !b.owner || !b.wallet || !b.ext) return c.json({ error: 'bad request' }, 400)
  store.setWallets(d.tg_id, { owner: b.owner, wallet: b.wallet, ext: b.ext })
  await svc.lensHello(d.tg_id, store.user(d.tg_id)?.name ?? '')
  return c.json({ ok: true })
})

app.get('/api/history', c => {
  const d = authDevice(c.req.query('deviceId'), c.req.query('token'))
  if (!d?.tg_id) return c.json({ error: 'unknown device' }, 401)
  const rows = store.db
    .prepare('SELECT ask_json, status, amount_nano, tx_hash, updated_at FROM asks WHERE payer_tg_id = ? ORDER BY updated_at DESC LIMIT 50')
    .all(d.tg_id) as { ask_json: string; status: string; amount_nano: string | null; tx_hash: string | null; updated_at: number }[]
  return c.json(rows.map(r => ({ ...JSON.parse(r.ask_json), status: r.status, paidNano: r.amount_nano, txHash: r.tx_hash, at: r.updated_at })))
})

if (DEV) {
  // Development only: link a device and play an incoming Telegram ask without a real bot.
  app.post('/api/dev/pair', async c => {
    const { deviceId, tgId, name } = (await c.req.json()) as { deviceId: string; tgId: string; name?: string }
    store.upsertUser({ tg_id: tgId, name: name ?? 'Dev', business_connection_id: 'dev-connection' })
    store.bindDevice(deviceId, tgId)
    hub.paired(deviceId, tgId)
    return c.json({ ok: true })
  })
  app.post('/api/dev/wallets', async c => {
    const b = (await c.req.json()) as { tgId: string; owner: string; wallet: string; ext: string }
    store.setWallets(b.tgId, b)
    await svc.lensHello(b.tgId, store.user(b.tgId)?.name ?? '')
    return c.json({ ok: true })
  })
  app.post('/api/dev/ask', async c => {
    const b = (await c.req.json()) as { payerTgId: string; fromId: number; fromName: string; text: string; card?: string }
    if (b.card && tg instanceof OfflineTelegram) tg.cards.set(b.fromId, b.card)
    const r = await svc.handleMessage({
      payerTgId: b.payerTgId,
      chat: { id: b.fromId, kind: 'dm' },
      from: { tgId: b.fromId, name: b.fromName },
      text: b.text,
      messageId: Date.now() % 100000,
      businessConnectionId: 'dev-connection',
    })
    return c.json(r)
  })
}

// The public "try it" page asks for a session, then shows a lens bound to it.
app.post('/api/try', c => {
  if (!demo || !demoDevice) return c.json({ error: 'demo is off' }, 503)
  const id = randomBytes(5).toString('base64url')
  sessions.set(id, { created: Date.now() })
  return c.json({ session: id, link: `https://t.me/${me.username}?start=try_${id}`, bot: me.username })
})

const server = serve({ fetch: app.fetch, port: PORT, createServer }) as ReturnType<typeof createServer>
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/lens')) return socket.destroy()
  wss.handleUpgrade(req, socket, head, ws => hub.handle(ws))
})

if (PUBLIC_URL) {
  await tg.setWebhook(`${PUBLIC_URL}/tg/webhook`, WEBHOOK_SECRET)
  console.log(`webhook → ${PUBLIC_URL}/tg/webhook`)
} else {
  // Local development: long polling instead of a public webhook.
  await tg.call('deleteWebhook', { drop_pending_updates: false })
  let offset = 0
  void (async () => {
    for (;;) {
      try {
        const updates = await tg.call<TgUpdate[]>('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'business_connection', 'business_message', 'callback_query'],
        })
        for (const u of updates) {
          offset = u.update_id + 1
          await router.handle(u).catch(err => console.error('update failed', err))
        }
      } catch (err) {
        console.error('polling', err)
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  })()
}
console.log(`thruppence server on :${PORT} as @${me.username}`)
