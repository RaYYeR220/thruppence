import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite'
import type { Ask } from '@thruppence/core'

// Loaded through require so bundlers and test runners that do not know the
// node:sqlite builtin leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export type AskStatus = 'open' | 'later' | 'paying' | 'sent' | 'paid' | 'declined' | 'failed'

export interface UserRow {
  tg_id: string
  name: string
  business_connection_id: string | null
  owner_address: string | null
  wallet_address: string | null
  ext_address: string | null
  demo: number
}

export interface AskRow {
  ask_id: string
  payer_tg_id: string
  ask: Ask
  status: AskStatus
  request_id: string
  amount_nano: string | null
  reply: string | null
  source_chat_id: string
  source_message_id: number | null
  business_connection_id: string | null
  tx_hash: string | null
  created_at: number
  updated_at: number
}

/**
 * Everything the server remembers. Message text is never stored: only the
 * asks it produced (who, how much, what for, which wallet).
 */
export class Store {
  readonly db: DatabaseSyncT

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        tg_id TEXT PRIMARY KEY, name TEXT NOT NULL, business_connection_id TEXT,
        owner_address TEXT, wallet_address TEXT, ext_address TEXT, demo INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY, token TEXT NOT NULL, tg_id TEXT, pub TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS asks (
        ask_id TEXT PRIMARY KEY, payer_tg_id TEXT NOT NULL, ask_json TEXT NOT NULL, status TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE, amount_nano TEXT, reply TEXT, source_chat_id TEXT NOT NULL,
        source_message_id INTEGER, business_connection_id TEXT, tx_hash TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS asks_payer ON asks(payer_tg_id, status);
      CREATE TABLE IF NOT EXISTS book (
        payer_tg_id TEXT NOT NULL, contact_tg_id TEXT NOT NULL, address TEXT NOT NULL,
        PRIMARY KEY (payer_tg_id, contact_tg_id));
      CREATE TABLE IF NOT EXISTS paid_to (
        payer_tg_id TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (payer_tg_id, address));
      CREATE TABLE IF NOT EXISTS seen_updates (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `)
  }

  /** True the first time a key is seen; used to drop Telegram's redelivered updates. */
  firstSeen(key: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO seen_updates (key, at) VALUES (?, ?)').run(key, Date.now())
    return Number(r.changes) === 1
  }

  upsertUser(u: { tg_id: string; name: string; business_connection_id?: string | null; demo?: boolean }) {
    this.db
      .prepare(
        `INSERT INTO users (tg_id, name, business_connection_id, demo, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name,
           business_connection_id = COALESCE(excluded.business_connection_id, users.business_connection_id)`,
      )
      .run(u.tg_id, u.name, u.business_connection_id ?? null, u.demo ? 1 : 0, Date.now())
  }

  setBusinessConnection(tgId: string, connectionId: string | null) {
    this.db.prepare('UPDATE users SET business_connection_id = ? WHERE tg_id = ?').run(connectionId, tgId)
  }

  setWallets(tgId: string, w: { owner: string; wallet: string; ext: string }) {
    this.db.prepare('UPDATE users SET owner_address = ?, wallet_address = ?, ext_address = ? WHERE tg_id = ?').run(w.owner, w.wallet, w.ext, tgId)
  }

  user(tgId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as UserRow | undefined
  }

  userByConnection(connectionId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE business_connection_id = ?').get(connectionId) as UserRow | undefined
  }

  addDevice(deviceId: string, token: string, pub: string | null = null) {
    this.db.prepare('INSERT OR REPLACE INTO devices (device_id, token, tg_id, pub, created_at) VALUES (?, ?, NULL, ?, ?)').run(deviceId, token, pub, Date.now())
  }

  device(deviceId: string): { device_id: string; token: string; tg_id: string | null; pub: string | null } | undefined {
    return this.db.prepare('SELECT device_id, token, tg_id, pub FROM devices WHERE device_id = ?').get(deviceId) as never
  }

  /** The device key of the phone paired to this user, if one registered it. */
  devicePubFor(tgId: string): string | null {
    const r = this.db.prepare('SELECT pub FROM devices WHERE tg_id = ? AND pub IS NOT NULL ORDER BY created_at DESC').get(tgId) as { pub: string } | undefined
    return r?.pub ?? null
  }

  bindDevice(deviceId: string, tgId: string) {
    this.db.prepare('UPDATE devices SET tg_id = ? WHERE device_id = ?').run(tgId, deviceId)
  }

  addPairCode(code: string, deviceId: string, ttlMs: number) {
    this.db.prepare('INSERT OR REPLACE INTO pair_codes (code, device_id, expires_at) VALUES (?, ?, ?)').run(code, deviceId, Date.now() + ttlMs)
  }

  takePairCode(code: string): string | null {
    const row = this.db.prepare('SELECT device_id, expires_at FROM pair_codes WHERE code = ?').get(code) as { device_id: string; expires_at: number } | undefined
    this.db.prepare('DELETE FROM pair_codes WHERE code = ?').run(code)
    return row && row.expires_at > Date.now() ? row.device_id : null
  }

  insertAsk(a: Omit<AskRow, 'status' | 'amount_nano' | 'reply' | 'tx_hash' | 'created_at' | 'updated_at'>) {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO asks (ask_id, payer_tg_id, ask_json, status, request_id, source_chat_id, source_message_id,
           business_connection_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.ask_id, a.payer_tg_id, JSON.stringify(a.ask), a.request_id, a.source_chat_id, a.source_message_id, a.business_connection_id, now, now)
  }

  private row(r: Record<string, unknown> | undefined): AskRow | undefined {
    if (!r) return undefined
    const { ask_json, ...rest } = r as Record<string, unknown> & { ask_json: string }
    return { ...(rest as unknown as Omit<AskRow, 'ask'>), ask: JSON.parse(ask_json) as Ask }
  }

  ask(askId: string): AskRow | undefined {
    return this.row(this.db.prepare('SELECT * FROM asks WHERE ask_id = ?').get(askId) as never)
  }

  openAsks(payerTgId: string): AskRow[] {
    return (this.db.prepare(`SELECT * FROM asks WHERE payer_tg_id = ? AND status IN ('open','later','paying','sent') ORDER BY created_at`).all(payerTgId) as never[]).map(
      r => this.row(r)!,
    )
  }

  /**
   * Compare-and-set on the status. Returns false if the ask was not in one of
   * the expected states, which is how a double tap becomes a single payment.
   */
  transition(askId: string, from: AskStatus[], to: AskStatus, patch: { amount_nano?: string; reply?: string | null; tx_hash?: string } = {}): boolean {
    const placeholders = from.map(() => '?').join(',')
    const r = this.db
      .prepare(
        `UPDATE asks SET status = ?, amount_nano = COALESCE(?, amount_nano), reply = COALESCE(?, reply),
           tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE ask_id = ? AND status IN (${placeholders})`,
      )
      .run(to, patch.amount_nano ?? null, patch.reply ?? null, patch.tx_hash ?? null, Date.now(), askId, ...from)
    return Number(r.changes) === 1
  }

  bookAddress(payerTgId: string, contactTgId: string): string | null {
    const r = this.db.prepare('SELECT address FROM book WHERE payer_tg_id = ? AND contact_tg_id = ?').get(payerTgId, contactTgId) as { address: string } | undefined
    return r?.address ?? null
  }

  saveBook(payerTgId: string, contactTgId: string, address: string) {
    this.db.prepare('INSERT OR REPLACE INTO book (payer_tg_id, contact_tg_id, address) VALUES (?, ?, ?)').run(payerTgId, contactTgId, address)
  }

  paidBefore(payerTgId: string): string[] {
    return (this.db.prepare('SELECT address FROM paid_to WHERE payer_tg_id = ?').all(payerTgId) as { address: string }[]).map(r => r.address)
  }

  markPaidTo(payerTgId: string, address: string) {
    this.db.prepare('INSERT OR IGNORE INTO paid_to (payer_tg_id, address) VALUES (?, ?)').run(payerTgId, address)
  }
}
