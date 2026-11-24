# Thruppence

**Someone asks you for money on Telegram. You pay with one press of your ring, without taking out your phone, and a scammer can't get paid the same way.**

<!-- tagline:start -->
On 70 Telegram messages it had never seen, a plain AI assistant would have offered **19** unsafe payments. Thruppence offered **1**.
<!-- tagline:end -->

You're at dinner. Mia drops the bill in the group chat: 60 for four of you. Your Even G2 glasses, dark all evening, show one card: *Mia asks · 15 GRAM · dinner · wallet on her profile*. You press the R1 ring under the table. Gram leaves a small capped wallet you own, and a receipt lands in the chat from your account before the plates are cleared.

**Try it:** [thruppence.vercel.app/try](https://thruppence.vercel.app/try/) — message the bot, press the ring on the page, and a real transfer lands on TON testnet.

---

## What it does

- **Dark until asked.** Ordinary messages never reach the lens. Only a money ask lights it: who, how much, what for, and where the money goes.
- **One press pays.** The ring (or a tap on the glasses) pays the exact amount the card showed. Swipe for *not now*, *later*, *another amount* or *reply by voice*. Hold to talk: "pay one and tell her enjoy".
- **The receipt goes back where the ask came from**, sent as you through Telegram Business: `Sent 15 GRAM ✓ · dinner` with a link to the transaction.
- **Voice notes work.** G2 has no speaker, so a voice note asking for money is transcribed and becomes a card like any text.
- **Bills split themselves.** In a group, `/split 60 dinner 4` puts a 15 GRAM card on every paired friend's lens.

## How it stays safe

The design rule is simple: **the language model may only say no.**

1. **The model describes, rules decide.** A model reads the message and reports what it sees (is it an ask, how much, for what, does it look like a scam, is it talking to a bot). Deterministic code then decides. The amount must be written in the message (or follow from its numbers, like a share of a total). A scam shape or text aimed at an AI blocks the card; nothing the model says can unblock one.
2. **The recipient comes from the requester's own Telegram profile**, not from the message. Telegram shows each user's TON wallet on their profile (Bot API 10.4 `ton_wallet_card`). An address typed in a message that differs from it is treated as a swap and refused.
3. **The glasses never hold your wallet.** Your money sits in TonTech's official **Agentic Wallet**, owned by your main wallet (Gram Wallet or any TON wallet). Its own operator signature is switched off. The only way to spend from it is our **limits extension**: per-payment and per-day caps, enforced on-chain.
4. **The key that signs lives on your phone**, inside the Even app, and can only sign pay requests to that extension. Our server never holds a key that can move your money. If the phone is stolen, the most it can move is the daily cap, and you pause or rotate it from your main wallet.
5. **Refusals cost nothing.** The extension checks the signature, sequence, expiry, caps and destination *before* accepting a message, so a refused payment never lands on-chain and spends nothing.

## Numbers

<!-- eval:start -->
Blind held-out set: 70 hand-labelled messages in English, Russian, Arabic and Spanish, written after the system was frozen and never used for tuning (`eval/data/heldout.jsonl`). 41 of them must never be paid (scams, messages aimed at the AI, swapped addresses, things that aren't asks); 29 are genuine asks.

| System | Unsafe payments offered (to the wrong person, for the wrong amount, or for something that was not an ask) | Genuine asks paid correctly |
|---|---|---|
| Keyword rule | **26** | 11 of 29 |
| Language model alone | **19** | 29 of 29 |
| Thruppence (same model + rules) | **1** | 24 of 29 |

Scams refused: 9 of 9. Messages aimed at the AI: 5 of 5. Swapped addresses: 5 of 5.

On the development set (139 messages, used for tuning) the same three systems offered 52, 34 and 1 unsafe payments. Our first version offered 22 there; the fix is described under "How it stays safe".
<!-- eval:end -->

The trade-off is deliberate: Thruppence would rather miss an ask than pay a scam. Most misses are voice notes with amounts spelled out in words. These numbers come from the commit tagged `eval-v2`; changes made after looking at the held-out set will be measured on a fresh one.

<!-- contracts:start -->
28 of 28 contract tests pass in `@ton/sandbox`. One payment burns about 0.0011 GRAM in fees.
<!-- contracts:end -->

Live on TON testnet: the demo's capped wallet, its first payment through the limits, and a 0.6 GRAM request that the 0.5 GRAM limit refused before acceptance. Addresses and transactions are in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

## How it works

```
Telegram ──▶ server ──────────────▶ glasses (Even Hub app)
 message      model describes         one card on the lens
 voice note   rules decide            press the ring
              recipient from profile        │
                                            ▼
              relay ◀──────── signed PayRequest (device key on the phone)
                │
                ▼
        limits extension ──▶ Agentic Wallet ──▶ friend's wallet
        (caps, on-chain)     (official bytecode)      │
                                                      ▼
Telegram ◀──── receipt, sent as you ◀──── transaction confirmed
```

| Part | Where | What it is |
|---|---|---|
| Glasses app | `apps/glasses` | Even Hub web app: lens renderer, ring and touch input, device key, phone companion |
| Server | `apps/server` | Telegram Business bot, intent extraction and rules, lens hub over WebSocket, relay, confirmation watcher |
| Contracts | `contracts` | Limits extension in Tolk, the vendored official Agentic Wallet bytecode, sandbox tests, self-audit |
| Shared core | `packages/core` | Lens state machine and screens (used by the glasses and the web lens), PayRequest builder, wallet setup builder |
| Web | `apps/web` | The live try-it lens, and one-confirmation wallet setup over TON Connect |
| Eval | `eval` | Labelled messages, three systems, cached model answers so results reproduce offline |

## Built on

- **Even Hub SDK 0.0.16** for G2: text, list and image containers, ring and temple input, glasses microphone, wear detection.
- **Telegram Bot API 10.5**: business connections (read your chats and reply as you, no Premium needed), `ton_wallet_card` on user profiles, group bot for splits.
- **TON**: TonTech's Agentic Wallet (Wallet V5 inside, owner as an irremovable extension), our limits extension in Tolk, TON Connect for setup. Gram is TON's native coin, the one Telegram's built-in wallet holds.
- **Venice API** for the language model (`claude-haiku-5-5`) and speech-to-text (`whisper-large-v3`).

## Run it

```bash
pnpm install
pnpm test                                   # core, server, glasses, contracts

# server (without BOT_TOKEN it runs with an offline Telegram stand-in)
cp apps/server/.env.example apps/server/.env   # fill in VENICE_API_KEY etc.
pnpm --filter @thruppence/server dev

# glasses app in the Even Hub simulator
pnpm --filter @thruppence/glasses dev
pnpm --filter @thruppence/glasses simulate

# reproduce the published held-out numbers without an API key
git checkout eval-v2
pnpm --filter @thruppence/eval eval -- --offline --data heldout
```

## Honest limits

- **Testnet only.** All money in the demo is TON testnet Gram. The contracts are not audited.
- **Theft window.** The daily window is anchored to the first payment after the last one expired, so a thief with your phone could move up to two daily caps in a 24-hour span (the end of one window and the start of the next). Pause from your main wallet to stop it.
- **Telegram's built-in wallet can't host extensions,** so the capped wallet is a separate Agentic Wallet that your Gram Wallet owns and funds.
- **The language model can be wrong in the safe direction.** It sometimes flags a real emergency from a friend as a scam; you then pay from your phone as usual.
- **Spoken amounts** are parsed for English, Russian, Arabic and Spanish number words; other languages need digits.
- **The public demo** signs with a server-held testnet key because it has no phone. Real users' keys never leave their phones.

## What existed before November 23

Nothing in this repository existed before the hackathon. It uses open-source libraries (`@ton/core`, `@ton/ton`, `@ton/crypto`, `@tonconnect/ui`, Hono, ws, Vite, Vitest, Blueprint, `@ton/sandbox`), the Even Hub SDK, CLI and simulator, and TonTech's compiled Agentic Wallet bytecode from `@ton/mcp` (MIT), vendored unmodified in `contracts/vendor/agentic-wallet`.

## License

MIT
