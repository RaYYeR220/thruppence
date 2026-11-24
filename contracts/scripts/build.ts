// Compiles every contract with Blueprint's compiler API and writes
// build/<Name>.compiled.json in Blueprint's own format ({ "hex": ... }).
// Same result as `blueprint build --all`, minus the interactive UI that
// fails when stdin is not a terminal (CI, `pnpm -r build`).
import { compile } from '@ton/blueprint';
import fs from 'fs';
import path from 'path';

const CONTRACTS = ['LimitsExtension'];

async function main() {
    const outDir = path.join(__dirname, '..', 'build');
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of CONTRACTS) {
        const code = await compile(name);
        fs.writeFileSync(path.join(outDir, `${name}.compiled.json`), JSON.stringify({ hex: code.toBoc().toString('hex') }) + '\n');
        console.log(`${name}: ${code.toBoc().length} bytes, code hash ${code.hash().toString('hex')}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
