import type { TelegramApi, TgChatFullInfo, TgMessage, TgUpdate, TgUser } from './api'

/**
 * A stand-in for the Bot API when the server runs without a bot token
 * (local development, simulator runs). Outgoing messages are logged and kept
 * so a developer can see the receipts that would have been posted.
 */
export class OfflineTelegram {
  readonly sent: { chat_id: number; text: string; business_connection_id?: string }[] = []
  readonly cards = new Map<number, string>()
  private nextId = 1000

  getMe = async (): Promise<TgUser & { username: string }> => ({ id: 1, is_bot: true, first_name: 'Thruppence', username: 'thruppence_bot' })

  getChat = async (chatId: number): Promise<TgChatFullInfo> => {
    const a = this.cards.get(chatId)
    return { id: chatId, type: 'private', ...(a ? { ton_wallet_card: { address: a, amount: '0' } } : {}) }
  }

  sendMessage = async (p: { chat_id: number; text: string; business_connection_id?: string }): Promise<TgMessage> => {
    this.sent.push(p)
    console.log(`[telegram → ${p.chat_id}${p.business_connection_id ? ' as user' : ''}] ${p.text.replace(/\n/g, ' ⏎ ')}`)
    return { message_id: this.nextId++, chat: { id: p.chat_id, type: 'private' }, date: Math.floor(Date.now() / 1000) }
  }

  answerCallbackQuery = async () => true
  downloadFile = async () => new Uint8Array()
  setWebhook = async () => true
  call = async <T>(method: string): Promise<T> => {
    if (method === 'getUpdates') await new Promise(r => setTimeout(r, 25_000))
    return [] as unknown as T
  }
}

export type BotLike = Pick<TelegramApi, 'getMe' | 'getChat' | 'sendMessage' | 'answerCallbackQuery' | 'downloadFile' | 'setWebhook' | 'call'>
export type { TgUpdate }
