import type { Ask, Limits } from '../src/types'

export const LIMITS: Limits = {
  perTxNano: '2000000000',
  dailyNano: '5000000000',
  spentNano: '0',
  spendableNano: '18000000000',
  paused: false,
}

export function ask(over: Partial<Ask> = {}): Ask {
  return {
    askId: 'a1',
    chat: { id: '100', kind: 'dm' },
    from: { tgId: '100', name: 'Dima' },
    amountNano: '1500000000',
    memo: 'concert tickets',
    recipient: { address: 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG', source: 'profile_card' },
    risk: { level: 'ok', reasons: [] },
    via: 'text',
    receivedAt: 0,
    ...over,
  }
}
