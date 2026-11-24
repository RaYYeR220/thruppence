// Writes the deployable bytecode into packages/core so the web setup page,
// the server and the scripts all deploy exactly what the tests exercised.
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const wallet = fs.readFileSync(path.join(root, 'vendor/agentic-wallet/agentic_wallet.code.hex'), 'utf8').replace(/\s+/g, '');
const ext = JSON.parse(fs.readFileSync(path.join(root, 'build/LimitsExtension.compiled.json'), 'utf8')).hex as string;
const out = path.join(root, '../packages/core/src/codes.ts');
fs.writeFileSync(
    out,
    `/**
 * Contract bytecode, as deployed.
 * - Agentic wallet: TonTech's official build (@ton/mcp 0.1.15-alpha.23, MIT),
 *   code hash 73e9c4c82905c1a25a4be10c98047d1755c5500037501b0d033863784215ba79.
 * - Limits extension: contracts/contracts/limits_extension.tolk.
 * Regenerate with: pnpm --filter @thruppence/contracts export-codes
 */
export const AGENTIC_WALLET_CODE_HEX = '${wallet}'
export const LIMITS_EXTENSION_CODE_HEX = '${ext}'
`,
);
console.log('wrote', out);
