// Writes tests/fixtures/payrequest.json from FIXTURE_INPUTS.
import fs from 'fs';
import path from 'path';
import { Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import { FIXTURE_INPUTS, fixtureDocument } from './fixture-lib';

async function main() {
    const extCode = await compile('LimitsExtension');
    const walletHex = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'agentic-wallet', 'agentic_wallet.code.hex'), 'utf8').trim();
    const doc = fixtureDocument(FIXTURE_INPUTS, extCode, Cell.fromHex(walletHex));
    const out = path.join(__dirname, '..', 'tests', 'fixtures', 'payrequest.json');
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
    console.log(`wrote ${out}`);
    console.log(`request hash ${doc.expected.requestHashHex}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
