/**
 * Renders every figure in README.md from the result files, so nothing in it
 * is typed by hand. Run: pnpm numbers
 */
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), 'utf8'))

const held = read('eval/results/v2-heldout-2026-11-24.json')
const dev = read('eval/results/v2-dev-2026-11-24.json')
const v1 = read('eval/results/v1-2026-11-24.json')
const contracts = read('contracts/results/contracts.json')
const gas = read('contracts/results/gas.json')

type S = { unsafePayable: number; harmfulAsks: number; genuineAsks: number; genuinePaidRight: number; messages: number }
const row = (name: string, s: S) => `| ${name} | **${s.unsafePayable}** | ${s.genuinePaidRight} of ${s.genuineAsks} |`
const cat = (c: string) => {
  const r = held.byCategory[c]
  return `${r.ours} of ${r.n}`
}

const blocks: Record<string, string> = {
  tagline: `On ${held.systems.ours.messages} Telegram messages it had never seen, a plain AI assistant would have offered **${held.systems.llmOnly.unsafePayable}** unsafe payments. Thruppence offered **${held.systems.ours.unsafePayable}**.`,
  eval: [
    `Blind held-out set: ${held.systems.ours.messages} hand-labelled messages in English, Russian, Arabic and Spanish, written after the system was frozen and never used for tuning (\`eval/data/heldout.jsonl\`). ${held.systems.ours.harmfulAsks} of them must never be paid (scams, messages aimed at the AI, swapped addresses, things that aren't asks); ${held.systems.ours.genuineAsks} are genuine asks.`,
    '',
    '| System | Unsafe payments offered (to the wrong person, for the wrong amount, or for something that was not an ask) | Genuine asks paid correctly |',
    '|---|---|---|',
    row('Keyword rule', held.systems.regex),
    row('Language model alone', held.systems.llmOnly),
    row('Thruppence (same model + rules)', held.systems.ours),
    '',
    `Scams refused: ${cat('scam')}. Messages aimed at the AI: ${cat('injection')}. Swapped addresses: ${cat('poisoned')}.`,
    '',
    `On the development set (${dev.systems.ours.messages} messages, used for tuning) the same three systems offered ${dev.systems.regex.unsafePayable}, ${dev.systems.llmOnly.unsafePayable} and ${dev.systems.ours.unsafePayable} unsafe payments. Our first version offered ${v1.systems.ours.unsafePayable} there; the fix is described under "How it stays safe".`,
  ].join('\n'),
  contracts: `${contracts.passed} of ${contracts.tests} contract tests pass in \`@ton/sandbox\`. One payment burns about ${Number(gas.feesPerPaymentTon).toFixed(4)} GRAM in fees.`,
}

let md = readFileSync(new URL('README.md', root), 'utf8')
for (const [k, v] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- ${k}:start -->)[\\s\\S]*?(<!-- ${k}:end -->)`)
  if (!re.test(md)) throw new Error(`README is missing the ${k} block`)
  md = md.replace(re, `$1\n${v}\n$2`)
}
writeFileSync(new URL('README.md', root), md)
console.log('README numbers rendered')
