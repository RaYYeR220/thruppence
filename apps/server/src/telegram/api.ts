/**
 * A thin, typed wrapper over the Telegram Bot API (10.5). Only the fields we
 * read are typed; everything else passes through untouched.
 */

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name: string
  last_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  first_name?: string
  username?: string
}

export interface TgMessageEntity {
  type: string
  offset: number
  length: number
}

export interface TgVoice {
  file_id: string
  duration: number
  mime_type?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  caption?: string
  entities?: TgMessageEntity[]
  voice?: TgVoice
  business_connection_id?: string
  reply_to_message?: TgMessage
}

export interface TgBusinessConnection {
  id: string
  user: TgUser
  user_chat_id: number
  date: number
  rights?: { can_reply?: boolean; can_read_messages?: boolean }
  is_enabled: boolean
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  business_connection?: TgBusinessConnection
  business_message?: TgMessage
  callback_query?: TgCallbackQuery
}

export interface TgTonWalletCard {
  address: string
  amount: string
}

export interface TgChatFullInfo extends TgChat {
  ton_wallet_card?: TgTonWalletCard
}

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = 'https://api.telegram.org',
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string }
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description ?? res.status}`)
    return body.result as T
  }

  getMe() {
    return this.call<TgUser & { username: string }>('getMe')
  }

  getChat(chatId: number) {
    return this.call<TgChatFullInfo>('getChat', { chat_id: chatId })
  }

  sendMessage(p: {
    chat_id: number
    text: string
    business_connection_id?: string
    reply_to_message_id?: number
    buttons?: InlineButton[][]
    parse_mode?: 'HTML'
  }) {
    const { buttons, reply_to_message_id, ...rest } = p
    return this.call<TgMessage>('sendMessage', {
      ...rest,
      link_preview_options: { is_disabled: true },
      ...(reply_to_message_id ? { reply_parameters: { message_id: reply_to_message_id, allow_sending_without_reply: true } } : {}),
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    })
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
  }

  editMessageText(p: { chat_id: number; message_id: number; text: string; buttons?: InlineButton[][] }) {
    const { buttons, ...rest } = p
    return this.call<TgMessage>('editMessageText', { ...rest, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) })
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const f = await this.call<{ file_path: string }>('getFile', { file_id: fileId })
    const res = await this.fetchImpl(`${this.base}/file/bot${this.token}/${f.file_path}`)
    if (!res.ok) throw new Error(`telegram file ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  setWebhook(url: string, secret: string) {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'business_connection', 'business_message', 'callback_query'],
      drop_pending_updates: false,
    })
  }
}

export function displayName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || 'Someone'
}
