# Thruppence contracts: self-audit

Your Gram sits in the official TON Agentic Wallet, owned by your main wallet. The wallet's own operator key is switched off, so the only way to spend from it is our limits extension. The extension pays out only when your phone's device key signs a request, and only within your per-payment and daily caps. This note covers what that protects, what it doesn't, and the trade-offs we chose.

Files: `contracts/limits_extension.tolk`, wrappers in `wrappers/`, tests in `tests/` (28 passing, all in `@ton/sandbox`).

## Replay and signature domain

- The device key signs ed25519 over the hash of the request cell. That cell starts with the op `PAYR` (0x50415952) and names the network (`networkId`, -3 testnet or -239 mainnet) and the exact extension address. A request signed for testnet, or for another extension that uses the same key, is refused with 407.
- `seqno` must match the stored one and goes up by one on every accepted payment, so a payment runs at most once (402).
- `validUntil` has to be in the future and no more than 600 s ahead (403). A signed request is worthless after ten minutes, even if the extension were ever redeployed from scratch with seqno 0.
- Wallet V5 signed requests start with different ops (0xbf235204, 0x4a3ca895) and are checked against a different key, so a pay request can't be mistaken for one and the reverse can't happen either.

## External-message griefing

- Every check runs before `acceptExternalMessage()`: signature, seqno, expiry, pause, both caps, domain, destination, comment, and our own gas balance. A request that fails any of them costs us nothing, changes nothing and never reaches the chain. A rejected send comes back to the phone with the exit code.
- The spec only required accepting after the signature, seqno and expiry checks. We accept after all of them because otherwise a thief holding the device key could keep sending signed requests while the extension is paused and burn its gas balance one transaction at a time.
- The whole external transaction uses 7,785 gas, well inside the 10,000 gas credit validators give before acceptance.
- The extension won't accept a request when its own balance is under 0.03 TON (411). It never starts a payment it can't fund.
- The message to the wallet goes out with mode 3 (pay fees separately, ignore errors). A failed send can't roll back the seqno bump and turn an accepted request into a replayable one.

## Bounces

- The request to the wallet is bounceable. If the wallet isn't there, the 0.02 TON attachment comes back and `onBouncedMessage` takes it quietly. Seqno and spent are not rolled back: a bounce carries only 256 bits of the body, so the amount can't be recovered. The counter errs towards caution.
- The payout's bounce flag is the phone's choice. With bounce on, a payment to an uninitialised address comes back to the agentic wallet, which keeps it. It still counts towards today's spend.

## Daily window

- The window is a rolling 24 hours anchored at the first payment after the previous window ended, not at midnight. When `now >= windowStart + 86400`, the next payment starts a new window with `spent = 0`. `get_spent` reports 0 once the window has expired.
- Exactly `perTxCap` and exactly `dailyCap` in total are allowed. One nanoton more is refused (405, 406).

## What the owner can do

The owner is your main wallet, fixed when the extension is deployed. Every owner op is refused with 409 from anyone else.

- `SetLimits` changes both caps.
- `SetDevice` rotates the device key. Requests signed with the old key fail immediately.
- `SetPaused` stops all payments.
- `Withdraw` sends the extension's gas balance back to the owner. It keeps 0.01 TON so the account keeps paying storage and never freezes, and you can top it up and carry on.
- Separately, the owner keeps full control of the agentic wallet itself: it can add or remove extensions, turn the operator signature back on, or move funds directly. The extension can't take any of that away.

Plain transfers, comments and unknown ops are kept as top-ups.

## What the extension can't do

- It can't send with any mode other than 3. There's no 128 (whole balance), 64 or +32 (destroy), because the mode isn't a field in the request.
- It can't send more than one message per request.
- It can't attach extra actions: it can't add or remove extensions or change the signature mode. `hasExtraActions` is always false.
- It can't attach a state init or a non-text body.
- It can't pay the agentic wallet itself, the extension, or any address outside the basechain (408).
- It can't take payment requests over internal messages. Only signed externals pay.
- It can't upgrade its own code, and it has no owner-change op.

## Known limits

- **Up to 2x the daily cap around a window boundary.** Someone holding the device key can spend what's left of the current window just before it ends and a full cap right after. The worst case in any 24 hours is 2 x `dailyCap`, then `dailyCap` per day until you pause or rotate the key.
- **A refused request stays valid until `validUntil`.** If the reason it was refused goes away within that window (unpause, higher limits, a new day, a top-up), anyone holding the signed message can still submit it. It pays exactly what the device signed, to the same recipient. Keep `validUntil` short (60 to 120 s) and re-sign retries with the same seqno, so only one of them can ever land.
- **Spent counts payments that didn't arrive.** If the wallet holds less than the amount, mode 3 makes it skip the send silently, and seqno and spent still move. The app should check the wallet balance before signing.
- **The extension needs gas.** Each payment moves about 0.0208 TON out of the extension: 0.02 TON attached, plus about 0.0008 TON of its own fees. The wallet's share of the fees comes out of that attachment and the rest lands in your agentic wallet. All in, one payment burns about 0.0011 TON (`results/gas.json`).
- **The attachment is a constant.** The wallet side uses 3,622 gas, under 0.002 TON even at 400 nanoton/gas. If fees ever rose more than tenfold, the wallet's compute could run out. The request would then bounce back and nothing would be paid, but it would still count as spent.
- **There's no payee allowlist.** Within the caps, the device key can pay anyone.
- **Removing the extension takes a step first.** While the operator signature is off, the agentic wallet won't let you remove its last extension. Turn the signature back on, or add a new extension, before removing this one.
- **Seqno is uint32.** It would overflow after about four billion payments.
