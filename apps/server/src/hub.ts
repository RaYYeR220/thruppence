import type { LensToServer, ServerToLens } from '@thruppence/core'
import type { WebSocket } from 'ws'
import type { LensPort } from './ports'
import type { Service } from './service'
import type { Store } from './store'

interface Conn {
  ws: WebSocket
  tgId: string
}

/**
 * Live lens connections. A lens says hello with its device id and token (or
 * a try-it session id), then receives asks and sends decisions, signatures
 * and microphone audio.
 */
export class Hub implements LensPort {
  private conns = new Map<string, Set<Conn>>()
  private svc!: Service

  constructor(
    private readonly store: Store,
    private readonly demoSessions: { exists(id: string): boolean },
  ) {}

  attach(svc: Service) {
    this.svc = svc
  }

  push(tgId: string, msg: ServerToLens) {
    const data = JSON.stringify(msg)
    for (const c of this.conns.get(tgId) ?? []) if (c.ws.readyState === 1) c.ws.send(data)
  }

  connected(tgId: string): boolean {
    return [...(this.conns.get(tgId) ?? [])].some(c => c.ws.readyState === 1)
  }

  /** Called when a device gets linked: if its socket is waiting, greet it. */
  paired(deviceId: string, tgId: string) {
    for (const [key, set] of this.conns) {
      if (key !== `pending:${deviceId}`) continue
      this.conns.delete(key)
      for (const c of set) {
        c.tgId = tgId
        this.add(c)
      }
      void this.svc.lensHello(tgId, this.store.user(tgId)?.name ?? '')
    }
  }

  private add(c: Conn) {
    const set = this.conns.get(c.tgId) ?? new Set()
    set.add(c)
    this.conns.set(c.tgId, set)
  }

  private remove(c: Conn) {
    this.conns.get(c.tgId)?.delete(c)
  }

  handle(ws: WebSocket) {
    let conn: Conn | null = null
    const timer = setTimeout(() => !conn && ws.close(4408, 'hello timeout'), 10_000)
    ws.on('message', async raw => {
      let msg: LensToServer
      try {
        msg = JSON.parse(String(raw)) as LensToServer
      } catch {
        return
      }
      if (!conn) {
        if (msg.t !== 'hello') return
        clearTimeout(timer)
        if (msg.deviceId.startsWith('try:')) {
          const session = msg.deviceId.slice(4)
          if (!this.demoSessions.exists(session)) return ws.close(4404, 'unknown session')
          conn = { ws, tgId: `demo:${session}` }
          this.add(conn)
          return void this.svc.lensHello(conn.tgId, 'Demo')
        }
        const dev = this.store.device(msg.deviceId)
        if (!dev || dev.token !== msg.token) return ws.close(4401, 'unknown device')
        if (!dev.tg_id) {
          conn = { ws, tgId: `pending:${dev.device_id}` }
          this.add(conn)
          return
        }
        conn = { ws, tgId: dev.tg_id }
        this.add(conn)
        return void this.svc.lensHello(dev.tg_id, this.store.user(dev.tg_id)?.name ?? '')
      }
      if (conn.tgId.startsWith('pending:')) return
      try {
        switch (msg.t) {
          case 'decision':
            return await this.svc.decision(conn.tgId, msg)
          case 'signed':
            return await this.svc.signed(conn.tgId, msg.askId, msg.boc)
          case 'ptt':
            return msg.state === 'start' ? this.svc.pttStart(conn.tgId, msg.askId) : await this.svc.pttStop(conn.tgId)
          case 'audio':
            return this.svc.pttAudio(conn.tgId, msg.pcm)
        }
      } catch {
        // A failing handler must never take the socket down.
      }
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (conn) this.remove(conn)
    })
  }
}
