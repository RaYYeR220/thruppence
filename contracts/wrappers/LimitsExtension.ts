// TypeScript bindings for contracts/limits_extension.tolk.
//
// The pay-request encoding here is the reference for every off-chain signer.
// tests/fixtures/payrequest.json pins it byte for byte.

import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import { sign } from '@ton/crypto';

export const LimitsOp = {
    payRequest: 0x50415952, // 'PAYR'
    setLimits: 0x4c494d54, // 'LIMT'
    setDevice: 0x44455643, // 'DEVC'
    setPaused: 0x50415553, // 'PAUS'
    withdraw: 0x57445257, // 'WDRW'
} as const;

export const LimitsError = {
    badSignature: 401,
    badSeqno: 402,
    expired: 403,
    paused: 404,
    overTxCap: 405,
    overDailyCap: 406,
    wrongDomain: 407,
    badDest: 408,
    notOwner: 409,
    badComment: 410,
    lowBalance: 411,
} as const;

export const NetworkId = { mainnet: -239, testnet: -3 } as const;

export const WINDOW_SECONDS = 86400;
export const MAX_VALIDITY_SECONDS = 600;
export const ATTACH_TO_WALLET = toNano('0.02');
export const MIN_BALANCE_TO_PAY = toNano('0.03');
export const STORAGE_RESERVE = toNano('0.01');
/** 1023 bits per cell minus the 32-bit zero prefix, whole bytes only. */
export const MAX_COMMENT_BYTES = 123;

export type LimitsExtensionConfig = {
    wallet: Address;
    owner: Address;
    networkId: number;
    deviceKey: bigint;
    perTxCap: bigint;
    dailyCap: bigint;
    seqno?: number;
    windowStart?: number;
    spent?: bigint;
    paused?: boolean;
};

/**
 * Storage layout. Root: ^fixed, deviceKey:uint256, seqno:uint32, perTxCap:coins,
 * dailyCap:coins, windowStart:uint32, spent:coins, paused:bool.
 * fixed: wallet:address, owner:address, networkId:int32.
 */
export function limitsExtensionConfigToCell(c: LimitsExtensionConfig): Cell {
    const fixed = beginCell().storeAddress(c.wallet).storeAddress(c.owner).storeInt(c.networkId, 32).endCell();
    return beginCell()
        .storeRef(fixed)
        .storeUint(c.deviceKey, 256)
        .storeUint(c.seqno ?? 0, 32)
        .storeCoins(c.perTxCap)
        .storeCoins(c.dailyCap)
        .storeUint(c.windowStart ?? 0, 32)
        .storeCoins(c.spent ?? 0n)
        .storeBit(c.paused ?? false)
        .endCell();
}

export type PayRequest = {
    networkId: number;
    extAddress: Address;
    seqno: number;
    validUntil: number;
    dest: Address;
    amount: bigint;
    bounce: boolean;
    requestId: bigint;
    /** Text, or a ready comment cell (used by tests to send malformed ones). */
    comment: string | Cell;
};

/** Text comment in a single cell: 32 zero bits, then the UTF-8 bytes. */
export function textCommentCell(text: string): Cell {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_COMMENT_BYTES) {
        throw new Error(`comment is ${bytes.length} bytes, max ${MAX_COMMENT_BYTES}`);
    }
    return beginCell().storeUint(0, 32).storeBuffer(bytes).endCell();
}

export function readTextComment(cell: Cell): string {
    const cs = cell.beginParse();
    if (cs.loadUint(32) !== 0) throw new Error('not a text comment');
    return cs.loadBuffer(cs.remainingBits / 8).toString('utf8');
}

/**
 * Request cell, the thing the device key signs:
 * op:uint32 networkId:int32 extAddress:addr_std seqno:uint32 validUntil:uint32
 * dest:addr_std amount:coins bounce:bit requestId:uint64 comment:^Cell
 */
export function payRequestCell(r: PayRequest): Cell {
    const comment = typeof r.comment === 'string' ? textCommentCell(r.comment) : r.comment;
    return beginCell()
        .storeUint(LimitsOp.payRequest, 32)
        .storeInt(r.networkId, 32)
        .storeAddress(r.extAddress)
        .storeUint(r.seqno, 32)
        .storeUint(r.validUntil, 32)
        .storeAddress(r.dest)
        .storeCoins(r.amount)
        .storeBit(r.bounce)
        .storeUint(r.requestId, 64)
        .storeRef(comment)
        .endCell();
}

/** ed25519 over the 32-byte representation hash of the request cell. */
export function signPayRequest(request: Cell, deviceSecretKey: Buffer): Buffer {
    return sign(request.hash(), deviceSecretKey);
}

/** External body: signature:bits512, request:^Cell. */
export function signedPayRequestBody(signature: Buffer, request: Cell): Cell {
    if (signature.length !== 64) throw new Error(`signature must be 64 bytes, got ${signature.length}`);
    return beginCell().storeBuffer(signature).storeRef(request).endCell();
}

export function buildSignedPayRequest(r: PayRequest, deviceSecretKey: Buffer) {
    const request = payRequestCell(r);
    const signature = signPayRequest(request, deviceSecretKey);
    return { request, hash: request.hash(), signature, body: signedPayRequestBody(signature, request) };
}

export function setLimitsBody(perTxCap: bigint, dailyCap: bigint, queryId = 0n): Cell {
    return beginCell()
        .storeUint(LimitsOp.setLimits, 32)
        .storeUint(queryId, 64)
        .storeCoins(perTxCap)
        .storeCoins(dailyCap)
        .endCell();
}

export function setDeviceBody(deviceKey: bigint, queryId = 0n): Cell {
    return beginCell().storeUint(LimitsOp.setDevice, 32).storeUint(queryId, 64).storeUint(deviceKey, 256).endCell();
}

export function setPausedBody(paused: boolean, queryId = 0n): Cell {
    return beginCell().storeUint(LimitsOp.setPaused, 32).storeUint(queryId, 64).storeBit(paused).endCell();
}

export function withdrawBody(queryId = 0n): Cell {
    return beginCell().storeUint(LimitsOp.withdraw, 32).storeUint(queryId, 64).endCell();
}

export class LimitsExtension implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new LimitsExtension(address);
    }

    static createFromConfig(config: LimitsExtensionConfig, code: Cell, workchain = 0) {
        const init = { code, data: limitsExtensionConfigToCell(config) };
        return new LimitsExtension(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: Cell.EMPTY });
    }

    async sendPay(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    private async sendOwnerOp(provider: ContractProvider, via: Sender, value: bigint, body: Cell) {
        await provider.internal(via, { value, bounce: true, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    async sendSetLimits(provider: ContractProvider, via: Sender, value: bigint, perTxCap: bigint, dailyCap: bigint) {
        await this.sendOwnerOp(provider, via, value, setLimitsBody(perTxCap, dailyCap));
    }

    async sendSetDevice(provider: ContractProvider, via: Sender, value: bigint, deviceKey: bigint) {
        await this.sendOwnerOp(provider, via, value, setDeviceBody(deviceKey));
    }

    async sendSetPaused(provider: ContractProvider, via: Sender, value: bigint, paused: boolean) {
        await this.sendOwnerOp(provider, via, value, setPausedBody(paused));
    }

    async sendWithdraw(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendOwnerOp(provider, via, value, withdrawBody());
    }

    async getLimits(provider: ContractProvider) {
        const s = (await provider.get('get_limits', [])).stack;
        return { perTxCap: s.readBigNumber(), dailyCap: s.readBigNumber(), paused: s.readBoolean() };
    }

    async getSpent(provider: ContractProvider) {
        const s = (await provider.get('get_spent', [])).stack;
        return { spent: s.readBigNumber(), windowStart: s.readNumber() };
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        return (await provider.get('seqno', [])).stack.readNumber();
    }

    async getDeviceKey(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_device_key', [])).stack.readBigNumber();
    }

    async getWallet(provider: ContractProvider) {
        const s = (await provider.get('get_wallet', [])).stack;
        return { wallet: s.readAddress(), owner: s.readAddress(), networkId: s.readNumber() };
    }
}
