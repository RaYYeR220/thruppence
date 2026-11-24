import type { Limits, ServerToLens, VoiceIntent } from '@thruppence/core'
import type { RawIntent } from './intent/schema'
import type { TgChatFullInfo, TgMessage, InlineButton } from './telegram/api'

export interface ExtInfo {
  seqno: number
  perTxNano: bigint
  dailyNano: bigint
  spentNano: bigint
  paused: boolean
}

/** The chain as the server sees it. Implemented over toncenter; faked in tests. */
export interface ChainPort {
  extInfo(ext: string): Promise<ExtInfo>
  balance(addr: string): Promise<bigint>
  isActive(addr: string): Promise<boolean>
  /** Broadcast a signed external message (base64 BOC). */
  sendExternal(boc: string): Promise<void>
  /** The wallet → dest transfer carrying exactly this comment, if it has landed. */
  findPayment(wallet: string, comment: string, sinceSec: number): Promise<{ txHash: string } | null>
}

export interface TelegramPort {
  getChat(chatId: number): Promise<TgChatFullInfo>
  sendMessage(p: {
    chat_id: number
    text: string
    business_connection_id?: string
    reply_to_message_id?: number
    buttons?: InlineButton[][]
  }): Promise<TgMessage>
  downloadFile(fileId: string): Promise<Uint8Array>
}

export interface LlmPort {
  extract(text: string): Promise<RawIntent | null>
  /** What the wearer said while holding the ring ("pay one and say enjoy"). */
  voice(transcript: string): Promise<VoiceIntent>
}

export interface SttPort {
  transcribe(audio: Uint8Array, mime: 'audio/ogg' | 'audio/wav'): Promise<string | null>
}

export interface LensPort {
  push(tgId: string, msg: ServerToLens): void
  connected(tgId: string): boolean
}

export interface Clock {
  now(): number
}

/** Signs on behalf of the shared demo wallet used by the public "try it" page. Never used for real users. */
export interface DemoSigner {
  sign(params: import('@thruppence/core').PayParams): Promise<string>
}

export type { Limits }
