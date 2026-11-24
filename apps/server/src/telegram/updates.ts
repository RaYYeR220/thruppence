import { formatGram, parseGram } from '@thruppence/core'
import type { Service } from '../service'
import type { Store } from '../store'
import { displayName, type TgMessage, type TgUpdate, type TgUser } from './api'
import type { TelegramPort } from '../ports'

interface Split {
  id: string
  chatId: number
  chatTitle: string
  messageId: number
  requester: TgUser
  totalNano: bigint
  people: number
  memo: string
  joined: Set<number>
}

export interface RouterDeps {
  store: Store
  svc: Service
  tg: TelegramPort & { answerCallbackQuery(id: string, text?: string): Promise<boolean> }
  botUsername: string
  /** Called when a device gets linked to a Telegram account. */
  onPaired: (deviceId: string, tgId: string) => void
  /** Try-it sessions: a page shows a lens; the visitor talks to the bot. */
  demo: { bind(sessionId: string, tgId: number): boolean; sessionOf(tgId: number): string | null }
  /** Max demo asks per visitor in a rolling 10 minutes. */
  demoRate: number
}

const HELP = `Thruppence pays what you're asked for on Telegram from your Even G2 glasses.

• Connect me in Telegram Settings → Telegram Business → Chatbots, so asks in your chats reach your glasses.
• In a group: /split 60 dinner 4 splits a bill; friends tap “I'm in”.
• Trying the demo? Open the link on thruppence's “Try it live” page first.`

export class UpdateRouter {
  private splits = new Map<string, Split>()
  private demoHits = new Map<number, number[]>()

  constructor(private readonly d: RouterDeps) {}

  async handle(u: TgUpdate): Promise<void> {
    if (!this.d.store.firstSeen(`u${u.update_id}`)) return
    if (u.business_connection) return this.onConnection(u.business_connection)
    if (u.business_message) return this.onBusinessMessage(u.business_message)
    if (u.callback_query) return this.onCallback(u.callback_query)
    if (u.message) return this.onMessage(u.message)
  }

  private async onConnection(c: NonNullable<TgUpdate['business_connection']>) {
    const tgId = String(c.user.id)
    this.d.store.upsertUser({ tg_id: tgId, name: displayName(c.user) })
    this.d.store.setBusinessConnection(tgId, c.is_enabled && c.rights?.can_reply !== false ? c.id : null)
    const ready = !!this.d.svc.wallets(tgId)
    await this.d.tg.sendMessage({
      chat_id: c.user_chat_id,
      text: c.is_enabled
        ? `Connected. When someone asks you for money in a chat, it shows up on your glasses.${ready ? '' : '\nFinish setup in Thruppence on your glasses to start paying.'}`
        : 'Disconnected. Asks will no longer reach your glasses.',
    })
  }

  private async onBusinessMessage(m: TgMessage) {
    const user = m.business_connection_id ? this.d.store.userByConnection(m.business_connection_id) : undefined
    if (!user || !m.from || String(m.from.id) === user.tg_id || m.from.is_bot || m.forward_origin) return
    await this.d.svc.handleMessage({
      payerTgId: user.tg_id,
      chat: { id: m.chat.id, kind: 'dm' },
      from: { tgId: m.from.id, name: displayName(m.from), ...(m.from.username ? { username: m.from.username } : {}) },
      ...(m.text || m.caption ? { text: m.text ?? m.caption } : {}),
      ...(m.voice ? { voiceFileId: m.voice.file_id } : {}),
      messageId: m.message_id,
      businessConnectionId: m.business_connection_id!,
    })
  }

  private async onMessage(m: TgMessage) {
    if (!m.from || m.from.is_bot) return
    const text = (m.text ?? '').trim()
    if (m.chat.type === 'private') return this.onPrivate(m, text)
    if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
      const cmd = text.match(new RegExp(`^/split(?:@${this.d.botUsername})?\\s+(.+)$`, 'i'))
      if (cmd) return this.onSplit(m, cmd[1]!)
    }
  }

  private async onPrivate(m: TgMessage, text: string) {
    const from = m.from!
    const start = text.match(/^\/start(?:\s+(\S+))?$/)
    if (start) {
      const arg = start[1] ?? ''
      if (arg.startsWith('pair_')) {
        const deviceId = this.d.store.takePairCode(arg.slice(5))
        if (!deviceId) return void (await this.d.tg.sendMessage({ chat_id: m.chat.id, text: 'That link has expired. Open Thruppence on your glasses and try again.' }))
        this.d.store.upsertUser({ tg_id: String(from.id), name: displayName(from) })
        this.d.store.bindDevice(deviceId, String(from.id))
        this.d.onPaired(deviceId, String(from.id))
        return void (await this.d.tg.sendMessage({ chat_id: m.chat.id, text: 'Linked to your glasses ✓\nNext: Telegram Settings → Telegram Business → Chatbots → add me, so asks in your chats reach you.' }))
      }
      if (arg.startsWith('try_') && this.d.demo.bind(arg.slice(4), from.id)) {
        return void (await this.d.tg.sendMessage({
          chat_id: m.chat.id,
          text: 'You are on the live demo. Ask me for money the way you would ask a friend, for example:\n“can you send me 0.5 for coffee?”\nThen look at the lens on the page and press the ring.',
        }))
      }
      return void (await this.d.tg.sendMessage({ chat_id: m.chat.id, text: HELP }))
    }
    const session = this.d.demo.sessionOf(from.id)
    if (!session) return void (await this.d.tg.sendMessage({ chat_id: m.chat.id, text: HELP }))
    if (!this.allowDemo(from.id)) {
      return void (await this.d.tg.sendMessage({ chat_id: m.chat.id, text: 'That is a lot of asks for one demo. Give it a few minutes.' }))
    }
    const r = await this.d.svc.handleMessage({
      payerTgId: `demo:${session}`,
      chat: { id: m.chat.id, kind: 'bot' },
      from: { tgId: from.id, name: displayName(from), ...(from.username ? { username: from.username } : {}) },
      ...(text ? { text } : {}),
      ...(m.voice ? { voiceFileId: m.voice.file_id } : {}),
      messageId: m.message_id,
    })
    const why: Record<string, string> = {
      not_a_request: 'Not a money ask, so the lens stays dark. Try “can you send me 0.5 for coffee?”',
      no_amount: 'No amount in that, so the lens stays dark.',
      ungrounded_amount: 'Could not find the amount in your words, so the lens stays dark.',
      unsupported_currency: 'Ask in GRAM, TON or dollars.',
      voice_unreadable: 'Could not make out that voice note.',
    }
    if (!r.askId) await this.d.tg.sendMessage({ chat_id: m.chat.id, text: why[r.dropped ?? ''] ?? 'The lens stays dark for that one.' })
  }

  private allowDemo(tgId: number): boolean {
    const now = Date.now()
    const hits = (this.demoHits.get(tgId) ?? []).filter(t => now - t < 10 * 60_000)
    if (hits.length >= this.d.demoRate) return false
    hits.push(now)
    this.demoHits.set(tgId, hits)
    return true
  }

  /** /split 60 dinner 4 → each friend who taps “I'm in” gets a card for 15. */
  private async onSplit(m: TgMessage, args: string) {
    const parts = args.trim().split(/\s+/)
    const total = parseGram(parts[0] ?? '')
    const last = parts.length > 2 ? Number(parts[parts.length - 1]) : NaN
    const people = Number.isInteger(last) && last >= 2 && last <= 50 ? last : 0
    const memo = parts.slice(1, people ? -1 : undefined).join(' ').slice(0, 40) || 'the bill'
    if (!total || !people) {
      return void (await this.d.tg.sendMessage({ chat_id: m.chat.id, text: 'Usage: /split <total> <what for> <people>, e.g. /split 60 dinner 4', reply_to_message_id: m.message_id }))
    }
    const id = Math.random().toString(36).slice(2, 8)
    const share = BigInt(total) / BigInt(people)
    const post = await this.d.tg.sendMessage({
      chat_id: m.chat.id,
      text: `${displayName(m.from!)} paid ${formatGram(total)} GRAM for ${memo}. ${people} people, ${formatGram(share)} each.\nTap if you were there; your glasses will ask you.`,
      buttons: [[{ text: "I'm in", callback_data: `split:${id}` }]],
    })
    this.splits.set(id, {
      id,
      chatId: m.chat.id,
      chatTitle: m.chat.title ?? 'group',
      messageId: post.message_id,
      requester: m.from!,
      totalNano: BigInt(total),
      people,
      memo,
      joined: new Set(),
    })
  }

  private async onCallback(q: NonNullable<TgUpdate['callback_query']>) {
    const id = q.data?.startsWith('split:') ? q.data.slice(6) : null
    const s = id ? this.splits.get(id) : undefined
    if (!s) return void (await this.d.tg.answerCallbackQuery(q.id, 'This split has closed.'))
    if (q.from.id === s.requester.id) return void (await this.d.tg.answerCallbackQuery(q.id, 'You paid the bill.'))
    if (s.joined.has(q.from.id)) return void (await this.d.tg.answerCallbackQuery(q.id, 'Already on your glasses.'))
    if (s.joined.size >= s.people - 1) return void (await this.d.tg.answerCallbackQuery(q.id, 'Everyone is in already.'))
    const tgId = String(q.from.id)
    if (!this.d.svc.wallets(tgId)) return void (await this.d.tg.answerCallbackQuery(q.id, 'Set up Thruppence on your glasses first.'))
    s.joined.add(q.from.id)
    const share = s.totalNano / BigInt(s.people)
    const r = await this.d.svc.handleMessage({
      payerTgId: tgId,
      chat: { id: s.chatId, kind: 'group', title: s.chatTitle },
      from: { tgId: s.requester.id, name: displayName(s.requester) },
      messageId: s.messageId,
      via: 'split',
      split: { totalNano: s.totalNano.toString(), people: s.people },
      structured: { amountNano: share.toString(), memo: s.memo },
    })
    await this.d.tg.answerCallbackQuery(q.id, r.askId ? 'On your glasses now.' : 'Could not create the ask.')
  }
}
