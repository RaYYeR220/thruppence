import type { LensToServer, ServerToLens } from '@thruppence/core'

export const SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://127.0.0.1:8791'
const WS_URL = SERVER.replace(/^http/, 'ws') + '/lens'

export interface Creds {
  deviceId: string
  token: string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export const api = {
  register: (pub: string) =>
    fetch(`${SERVER}/api/devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pub }) }).then(r => json<Creds>(r)),
  pair: (c: Creds) =>
    fetch(`${SERVER}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }).then(r =>
      json<{ code: string; link: string }>(r),
    ),
  me: (c: Creds) =>
    fetch(`${SERVER}/api/me?deviceId=${encodeURIComponent(c.deviceId)}&token=${encodeURIComponent(c.token)}`).then(r =>
      json<{ paired: boolean; name: string | null; business: boolean; wallets: { owner: string; wallet: string; ext: string } | null }>(r),
    ),
  history: (c: Creds) =>
    fetch(`${SERVER}/api/history?deviceId=${encodeURIComponent(c.deviceId)}&token=${encodeURIComponent(c.token)}`).then(r =>
      json<{ askId: string; from: { name: string }; memo: string; amountNano: string; status: string; paidNano: string | null; txHash: string | null; at: number }[]>(r),
    ),
}

/** One lens socket that keeps itself alive across Wi-Fi drops and WebView suspends. */
export class LensSocket {
  private ws: WebSocket | null = null
  private backoff = 500
  private closed = false
  private outbox: LensToServer[] = []

  constructor(
    private readonly hello: () => LensToServer,
    private readonly onMessage: (m: ServerToLens) => void,
    private readonly onState: (up: boolean) => void,
  ) {}

  open() {
    this.closed = false
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 500
      ws.send(JSON.stringify(this.hello()))
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m))
      this.onState(true)
    }
    ws.onmessage = ev => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerToLens)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = ev => {
      this.onState(false)
      if (this.closed || ev.code === 4401) return
      setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 8000)
    }
  }

  send(m: LensToServer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
    // Audio is useless late; everything else waits for the reconnect.
    else if (m.t !== 'audio') this.outbox.push(m)
  }

  /** Re-open after the phone suspended the WebView. */
  ensure() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.open()
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
