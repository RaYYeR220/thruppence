import fs from 'fs';
import path from 'path';
import { Cell } from '@ton/core';
import { EmulationError } from '@ton/sandbox';

/** Official agentic-wallet bytecode, vendored from @ton/mcp. */
export function agenticWalletCode(): Cell {
    const hex = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'agentic-wallet', 'agentic_wallet.code.hex'), 'utf8').trim();
    return Cell.fromHex(hex);
}

/**
 * An external that fails before acceptExternalMessage never makes it on-chain:
 * the sandbox throws, like a liteserver refusing the message.
 */
export async function expectExternalRejected(send: Promise<unknown>, exitCode: number) {
    let error: unknown;
    try {
        await send;
    } catch (e) {
        error = e;
    }
    expect(error).toBeInstanceOf(EmulationError);
    expect((error as EmulationError).exitCode).toBe(exitCode);
}

export const T0 = 1_800_000_000;

export function fromNanoString(n: bigint): string {
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const whole = abs / 1_000_000_000n;
    const frac = (abs % 1_000_000_000n).toString().padStart(9, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
}
