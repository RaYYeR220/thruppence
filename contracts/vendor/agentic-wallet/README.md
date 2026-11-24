# TON Agentic Wallet bytecode (vendored)

`agentic_wallet.code.boc` (raw bag of cells) and `agentic_wallet.code.hex` (the same bytes as hex) are the compiled code cell of the official TON Agentic Wallet by TonTech. We only ship the bytecode; the wrapper in `wrappers/AgenticWallet.ts` is our own code, written against the wallet's message formats.

| | |
|---|---|
| Taken from | npm package `@ton/mcp`, version `0.1.15-alpha.23`, export `AgenticWalletCodeCell` (hex BOC literal in `dist/index.js`, identical in `dist/index.cjs`) |
| Package license | MIT, Copyright (c) 2025 TonTech |
| Upstream source | github.com/the-ton-tech/agentic-wallet-contract, commit `a11ddb7` |
| Code hash | `73e9c4c82905c1a25a4be10c98047d1755c5500037501b0d033863784215ba79` |

The code hash matches what `@ton/tolk-js` 1.2.0 (the version pinned in the upstream lockfile) produces from `contracts/agentic_wallet.tolk` at that commit, so the npm bytecode and the published source agree.

The same package uses `EQByQ19qvWxW7VibSbGEgZiYMqilHY5y1a_eeSL2VaXhfy07` as the default agentic-wallet collection on mainnet and testnet. A wallet's address is derived from that collection address, the owner, the operator key and this code, so all four have to match for indexers to list the wallet as an agentic wallet. The wrapper exports it as `AGENTIC_COLLECTION_ADDRESS`.

Re-check after an upgrade:

```sh
node -e "const {Cell}=require('@ton/core');console.log(Cell.fromHex(require('fs').readFileSync('vendor/agentic-wallet/agentic_wallet.code.hex','utf8').trim()).hash().toString('hex'))"
```
