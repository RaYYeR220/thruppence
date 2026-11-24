# Claims and their evidence

Every statement we make about Thruppence, tagged by how it is backed.

- **VERIFIED-LIVE** — happened on TON testnet or a live deployment; follow the link.
- **REPRODUCIBLE** — a script or test in this repository produces it.
- **MODELED** — an estimate or design property, not a measurement.
- **NOT-CLAIMED** — things we do not claim, listed so nobody assumes them.

| Claim | Tier | Evidence |
|---|---|---|
| Payments go through TonTech's official Agentic Wallet, unmodified | VERIFIED-LIVE + REPRODUCIBLE | wallet address in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md); code hash `73e9c4c8…ba79` checked in `packages/core/test/setup.test.ts` and `contracts/vendor/agentic-wallet/README.md` |
| The wallet's operator signature is off, so only the limits extension can spend | VERIFIED-LIVE + REPRODUCIBLE | `is_signature_allowed` = false on the demo wallet (`scripts/allowance.ts status`); `contracts/tests/AgenticSetup.spec.ts` |
| Per-payment and per-day caps are enforced on-chain | VERIFIED-LIVE + REPRODUCIBLE | the 0.6 GRAM request refused with exit code 405 (DEPLOYMENTS); `LimitsExtension.spec.ts` cap and window tests |
| A refused request costs nothing and never lands on-chain | REPRODUCIBLE + VERIFIED-LIVE | all checks run before `acceptExternalMessage()` (`limits_extension.tolk`); the refused send returned an error from the RPC with no transaction |
| A device-signed payment moves Gram to the friend with a matching comment | VERIFIED-LIVE | first payment and the simulator payment in DEPLOYMENTS |
| The glasses app signs on the phone; the server holds no key for real users | REPRODUCIBLE | `apps/glasses/src/signer.ts` (key in Even app storage); the server only relays (`apps/server/src/service.ts`) |
| The public demo signs with a server-held testnet key | REPRODUCIBLE | `apps/server/src/demo/device.ts`; used only for `demo:` sessions |
| The device refuses to sign anything other than what the card showed | REPRODUCIBLE | `packages/core/test/machine.test.ts` "signs only when the params match what the wearer saw" |
| The off-chain PayRequest encoding matches the contract byte for byte | REPRODUCIBLE | `packages/core/test/payRequest.test.ts` against `contracts/tests/fixtures/payrequest.json` |
| On 70 unseen messages: 1 unsafe payment offered, against 19 for the model alone and 26 for a keyword rule | REPRODUCIBLE | `eval/results/v2-heldout-2026-11-24.json`, tag `eval-v2`, `--offline` |
| Scams 9/9, messages aimed at the AI 5/5 and swapped addresses 5/5 refused on that set | REPRODUCIBLE | same file, `byCategory` |
| 24 of 29 genuine asks on that set were paid correctly; the model alone paid 29 | REPRODUCIBLE | same file — our system trades recall for safety |
| Our first version offered 22 unsafe payments on the development set | REPRODUCIBLE | `eval/results/v1-2026-11-24.json` |
| Receipts are posted into the original chat as the user | REPRODUCIBLE (offline) | `apps/server/test/service.test.ts` "receipt in the original chat, as the payer"; live once the bot is connected |
| A payment that times out but lands later still gets its receipt | REPRODUCIBLE | `apps/server/test/service.test.ts` "reconciliation" |
| One payment costs about 0.0011 GRAM in fees | REPRODUCIBLE | `contracts/results/gas.json` (sandbox, mainnet fee config) |
| A stolen phone can move at most the daily cap | MODELED | true per window; the anchored window allows up to two caps within 24 hours (see Honest limits) |
| Paying from the glasses is faster than from the phone | MODELED | one press against the phone route (unlock, open the chat, copy the address, open a wallet, paste, type the amount, confirm, return, reply); not yet timed |

## NOT-CLAIMED

- Mainnet use. Everything runs on TON testnet; the contracts are unaudited.
- That the language model never makes mistakes. It errs, and the rules are built so its errors refuse rather than pay.
- Support for Telegram's built-in wallet as the capped wallet itself. It cannot host extensions; it owns and funds the Agentic Wallet instead.
- Background alerts on the glasses. Even Hub shows one app at a time; asks reach the lens while Thruppence is open.
- Any user numbers, revenue or partnerships.
