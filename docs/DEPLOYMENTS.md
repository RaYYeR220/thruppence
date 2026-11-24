# Deployments

## TON testnet

The public demo pays from a capped wallet owned by a test wallet. Every address below can be opened on testnet.tonviewer.com.

| What | Address |
|---|---|
| Owner (Wallet V5, testnet) | `0QA0NrvYMQdr9eOrbUd_uZSltc6_p6OlzDSzkv00fH5fPbH3` |
| Agentic wallet (official TonTech bytecode, code hash `73e9c4c8…ba79`) | `0QD_EJGdXfgL19mO3vALCMt0EI2t8bQsRRicgAs1662cmCQg` |
| Limits extension (`contracts/limits_extension.tolk`) | `0QD5POvb0aypq2VbghD5M5Ubz83qH3jwstlp40LDvimgOorK` |
| Agentic wallet collection (TonTech, shared) | `EQByQ19qvWxW7VibSbGEgZiYMqilHY5y1a_eeSL2VaXhfy07` |

Limits: 0.5 GRAM per payment, 1.5 GRAM per 24 hours. Operator signature on the agentic wallet: **disabled**, so the limits extension is the only way to spend.

### Proof

- Setup (one owner transaction: deploy wallet, deploy extension, add extension and disable the operator signature): owner seqno 0 → 1 on 2026-11-24.
- First payment through the limits, signed by a device key: [`ffc5161c…75b8`](https://testnet.tonviewer.com/transaction/ffc5161c9ff385aacc9f628445db73ea5165be4366ac57f2a63230cdcfca75b8), 0.1 GRAM, comment `Thruppence #497448 · first light`.
- A 0.6 GRAM request (over the 0.5 per-payment limit) was refused by the extension before acceptance: `exitcode=405`, nothing landed on chain and nothing was spent.

Re-run: `pnpm --filter @thruppence/server exec tsx scripts/allowance.ts status`.
