import './polyfill'
import { drawPage, formatGram, initialState, LENS_H, LENS_W, reduce, renderScreen, type LensEvent, type LensState, type ServerToLens } from '@thruppence/core'

const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://127.0.0.1:8787'
const EXPLORER = (import.meta.env.VITE_EXPLORER as string | undefined) ?? 'https://testnet.tonviewer.com'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('lens')
const log = $<HTMLOListElement>('log')
const openBtn = $<HTMLAnchorElement>('open-tg')
const status = $<HTMLSpanElement>('status')

const SCALE = 2
canvas.width = LENS_W * SCALE
canvas.height = LENS_H * SCALE
const ctx = canvas.getContext('2d')!

let state: LensState = initialState(Date.now())
let ws: WebSocket | null = null

function line(text: string, href?: string) {
  const li = document.createElement('li')
  const t = document.createElement('time')
  t.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  li.append(t)
  const span = document.createElement('span')
  span.textContent = text
  li.append(span)
  if (href) {
    const a = document.createElement('a')
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = 'view on chain ↗'
    li.append(a)
  }
  log.prepend(li)
}

function paint() {
  drawPage(ctx, renderScreen(state), { scale: SCALE })
}

function narrate(m: ServerToLens) {
  switch (m.t) {
    case 'hello_ok':
      return line(`Lens connected. Demo wallet: ${formatGram(m.limits.spendableNano)} GRAM, up to ${formatGram(m.limits.perTxNano)} per payment.`)
    case 'ask': {
      const r = m.ask.risk.reasons[0]
      return line(`${m.ask.from.name} asked for ${formatGram(m.ask.amountNano)} GRAM · ${m.ask.memo}${r ? ` · flagged: ${r.code.replace(/_/g, ' ')}` : ''}`)
    }
    case 'pay_params':
      return line(`Signed request #${m.params.requestId} for ${formatGram(m.params.amountNano)} GRAM, limits extension seqno ${m.params.seqno}`)
    case 'paid':
      return line(`Confirmed on TON in ${(m.ms / 1000).toFixed(1)} s${m.receiptSent ? ', receipt posted in your chat' : ''}`, `${EXPLORER}/transaction/${m.txHash}`)
    case 'pay_failed':
      return line(`Not paid: ${m.reason}`)
    default:
      return
  }
}

function dispatch(ev: LensEvent) {
  const out = reduce({ ...state, now: Date.now() }, ev)
  state = out.state
  for (const e of out.effects) {
    // The demo device signs server-side; the page only forwards decisions.
    if (e.k === 'send' && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e.m))
  }
  paint()
}

async function start() {
  status.textContent = 'Starting a demo session…'
  const res = await fetch(`${SERVER}/api/try`, { method: 'POST' })
  if (!res.ok) {
    status.textContent = 'The live demo is resting right now. The video below shows the same flow.'
    return
  }
  const { session, link, bot } = (await res.json()) as { session: string; link: string; bot: string }
  openBtn.href = link
  openBtn.removeAttribute('aria-disabled')
  $('bot-name').textContent = `@${bot}`
  ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/lens')
  ws.onopen = () => {
    ws!.send(JSON.stringify({ t: 'hello', deviceId: `try:${session}`, token: '' }))
    status.textContent = 'Waiting for your message in Telegram'
  }
  ws.onmessage = ev => {
    const m = JSON.parse(String(ev.data)) as ServerToLens
    narrate(m)
    dispatch({ k: 'server', m })
    if (m.t === 'ask') status.textContent = 'Press the ring to pay'
    if (m.t === 'paid') status.textContent = 'Paid. Ask again any time.'
  }
  ws.onclose = () => {
    status.textContent = 'Disconnected. Reload to start a new session.'
  }
}

// The R1 ring, on a keyboard and a mouse.
const press = (g: 'tap' | 'up' | 'down' | 'back' | 'hold' | 'release') => dispatch({ k: 'input', g })
$('ring-press').addEventListener('click', () => press('tap'))
$('ring-up').addEventListener('click', () => press('up'))
$('ring-down').addEventListener('click', () => press('down'))
$('ring-back').addEventListener('click', () => press('back'))
canvas.addEventListener('click', () => press('tap'))
canvas.addEventListener('dblclick', () => press('back'))
canvas.addEventListener('wheel', e => {
  e.preventDefault()
  press(e.deltaY > 0 ? 'down' : 'up')
}, { passive: false })
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); press('tap') }
  if (e.key === 'ArrowUp') press('up')
  if (e.key === 'ArrowDown') press('down')
  if (e.key === 'Escape' || e.key === 'Backspace') press('back')
})

setInterval(() => dispatch({ k: 'tick', now: Date.now() }), 300)
paint()
void start()
