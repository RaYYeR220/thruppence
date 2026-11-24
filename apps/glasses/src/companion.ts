import { formatGram, toBig, type LensState } from '@thruppence/core'
import { api, type Creds } from './net'

const WEB = (import.meta.env.VITE_WEB_URL as string | undefined) ?? 'http://127.0.0.1:5310'

type Phase = 'loading' | 'link' | 'wallet' | 'ready'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * The phone side of the app, shown in the Even app while the glasses show the
 * lens: link Telegram, set up the wallet, see limits and history.
 */
export class Companion {
  private phase: Phase = 'loading'
  private online = false
  private creds!: Creds
  private pub = ''
  private lens: LensState | null = null
  private me: Awaited<ReturnType<typeof api.me>> | null = null
  private history: Awaited<ReturnType<typeof api.history>> = []
  private pairLink = ''

  constructor(private readonly root: HTMLElement) {}

  start(creds: Creds, publicHex: string) {
    this.creds = creds
    this.pub = publicHex
    void this.refresh()
    setInterval(() => void this.refresh(), 4000)
  }

  setOnline(up: boolean) {
    this.online = up
    this.draw()
  }

  setLens(st: LensState) {
    const before = this.lens?.screen.s
    this.lens = st
    if (st.screen.s === 'paid' && before !== 'paid') void this.refresh()
    this.draw()
  }

  private async refresh() {
    try {
      this.me = await api.me(this.creds)
      this.phase = !this.me.paired ? 'link' : !this.me.wallets ? 'wallet' : 'ready'
      if (this.phase === 'ready') this.history = await api.history(this.creds)
    } catch {
      // keep the last view; the status dot shows we are offline
    }
    this.draw()
  }

  private async link() {
    if (!this.pairLink) this.pairLink = (await api.pair(this.creds)).link
    window.open(this.pairLink, '_blank')
    this.draw()
  }

  private draw() {
    const dot = `<span class="dot ${this.online ? 'on' : ''}"></span>${this.online ? 'Glasses connected' : 'Connecting…'}`
    let body = ''
    if (this.phase === 'loading') body = `<p class="muted">Starting…</p>`
    if (this.phase === 'link') {
      body = `<h1>Link your Telegram</h1>
        <p>Thruppence reads money asks in your chats and shows them on your glasses. Start by linking your account.</p>
        <button id="link" class="primary">Open Telegram</button>
        ${this.pairLink ? `<p class="muted small">Or send this to the bot: <code>${esc(this.pairLink.split('start=')[1] ?? '')}</code></p>` : ''}`
    }
    if (this.phase === 'wallet') {
      const url = `${WEB}/setup?d=${encodeURIComponent(this.creds.deviceId)}&t=${encodeURIComponent(this.creds.token)}&k=${this.pub}`
      body = `<h1>Give your glasses an allowance</h1>
        <p>Your main wallet stays yours. You fund a small wallet with daily and per-payment limits; only these glasses can spend from it, only up to the limits.</p>
        <a class="primary" href="${esc(url)}" target="_blank" rel="noopener">Set up in your browser</a>
        <p class="muted small">Device key ${this.pub.slice(0, 8)}…${this.pub.slice(-8)}</p>`
    }
    if (this.phase === 'ready') {
      const l = this.lens?.limits
      const left = l ? toBig(l.dailyNano) - toBig(l.spentNano) : 0n
      const rows = this.history
        .slice(0, 12)
        .map(
          h => `<li><span>${esc(h.from.name)} · ${esc(h.memo)}</span><span class="amt ${h.status}">${h.status === 'paid' ? '−' : ''}${formatGram(h.paidNano ?? h.amountNano)}</span></li>`,
        )
        .join('')
      body = `<h1>${esc(this.me?.name ?? '')}</h1>
        ${l ? `<div class="stats"><div><b>${formatGram(l.spendableNano)}</b><span>GRAM ready</span></div><div><b>${formatGram(left > 0n ? left : 0n)}</b><span>left today of ${formatGram(l.dailyNano)}</span></div><div><b>${formatGram(l.perTxNano)}</b><span>max per payment</span></div></div>` : ''}
        ${this.me?.business ? '' : `<p class="hint">Add <b>@thruppence_bot</b> in Telegram → Settings → Telegram Business → Chatbots so asks in your chats reach the glasses.</p>`}
        <h2>Recent</h2><ul class="hist">${rows || '<li class="muted">Nothing yet. The lens stays dark until someone asks.</li>'}</ul>`
    }
    this.root.innerHTML = `<header>${dot}</header><main>${body}</main>`
    this.root.querySelector('#link')?.addEventListener('click', () => void this.link())
  }
}
