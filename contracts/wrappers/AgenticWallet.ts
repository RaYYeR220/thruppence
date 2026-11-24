// TypeScript bindings for the official TON Agentic Wallet (TonTech).
//
// The bytecode is vendored from @ton/mcp (see vendor/agentic-wallet/README.md).
// Message layouts below follow the wallet's published message formats
// (Wallet V5 extension requests plus the agentic-wallet deploy message).

import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    MessageRelaxed,
    Sender,
    SendMode,
    storeOutList,
} from '@ton/core';
import { sign } from '@ton/crypto';

export const AgenticWalletOp = {
    deployWallet: 0x0609e47b,
    extensionActionRequest: 0xed84cbf0,
    externalSignedRequest: 0xbf235204,
    internalSignedRequest: 0x4a3ca895,
    changeOperator: 0xea4e36cf,
} as const;

export const ExtraActionOp = {
    addExtension: 0x02,
    removeExtension: 0x03,
    setSignatureAllowed: 0x04,
} as const;

// Exit codes thrown by the wallet that matter to us.
export const AgenticWalletError = {
    notInitialized: 44,
    incorrectSender: 50,
    signatureDisabled: 132,
    invalidSeqno: 133,
    invalidWalletId: 134,
    invalidSignature: 135,
    expired: 136,
    addExtension: 139,
    unsupportedAction: 141,
    disableSignatureWithoutExtensions: 142,
    onlyExtensionCanChangeSignatureMode: 146,
    invalidC5: 147,
} as const;

// Default agentic-wallet NFT collection used by @ton/mcp on mainnet and testnet.
// A wallet's address depends on it, so it must match for indexers to list it.
export const AGENTIC_COLLECTION_ADDRESS = Address.parse('EQByQ19qvWxW7VibSbGEgZiYMqilHY5y1a_eeSL2VaXhfy07');

export type AgenticWalletParams = {
    owner: Address;
    operatorPublicKey: bigint;
    collection: Address;
    nftItemContent?: Cell | null;
    deployedByUser?: boolean;
};

export function publicKeyToBigInt(publicKey: Buffer): bigint {
    if (publicKey.length !== 32) throw new Error(`public key must be 32 bytes, got ${publicKey.length}`);
    return BigInt('0x' + publicKey.toString('hex'));
}

/** Wallet index = hash of (owner, origin operator key, deployedByUser). */
export function agenticWalletIndex(owner: Address, operatorPublicKey: bigint, deployedByUser = true): bigint {
    const seed = beginCell().storeAddress(owner).storeUint(operatorPublicKey, 256).storeBit(deployedByUser).endCell();
    return BigInt('0x' + seed.hash().toString('hex'));
}

/** Data the wallet is deployed with; the address is derived from this and the code. */
export function agenticWalletInitialData(index: bigint, collection: Address): Cell {
    return beginCell()
        .storeUint(index, 256) // nftItemIndex
        .storeAddress(collection)
        .storeBit(true) // isSignatureAllowed
        .storeUint(0, 32) // seqno
        .storeDict(null) // extensions
        .storeMaybeRef(null) // walletData (filled by DeployWalletMsg)
        .endCell();
}

export function agenticWalletRuntimeData(p: AgenticWalletParams): Cell {
    return beginCell()
        .storeAddress(p.owner)
        .storeMaybeRef(p.nftItemContent ?? null)
        .storeUint(p.operatorPublicKey, 256) // originOperatorPublicKey
        .storeUint(p.operatorPublicKey, 256) // operatorPublicKey
        .storeBit(p.deployedByUser ?? true)
        .endCell();
}

/** Direct deploy by the owner (senderOriginOperatorPublicKey = 0). */
export function deployWalletBody(p: AgenticWalletParams, queryId = 0n): Cell {
    return beginCell()
        .storeUint(AgenticWalletOp.deployWallet, 32)
        .storeUint(queryId, 64)
        .storeRef(agenticWalletRuntimeData(p))
        .storeUint(0, 256)
        .endCell();
}

export function addExtensionAction(extension: Address): Cell {
    return beginCell().storeUint(ExtraActionOp.addExtension, 8).storeAddress(extension).endCell();
}

export function removeExtensionAction(extension: Address): Cell {
    return beginCell().storeUint(ExtraActionOp.removeExtension, 8).storeAddress(extension).endCell();
}

export function setSignatureAllowedAction(allowed: boolean): Cell {
    return beginCell().storeUint(ExtraActionOp.setSignatureAllowed, 8).storeBit(allowed).endCell();
}

/** Extra actions are a snake: each action's bits, then a ref to the next one. */
export function chainExtraActions(actions: Cell[]): Cell | null {
    let next: Cell | null = null;
    for (let i = actions.length - 1; i >= 0; i--) {
        const b = beginCell().storeSlice(actions[i].beginParse());
        if (next) b.storeRef(next);
        next = b.endCell();
    }
    return next;
}

/** c5 out-action list made only of send-message actions. */
export function sendMessageActions(messages: { mode: number; message: MessageRelaxed }[]): Cell {
    return beginCell()
        .store(storeOutList(messages.map((m) => ({ type: 'sendMsg' as const, mode: m.mode, outMsg: m.message }))))
        .endCell();
}

export type ExtensionActionRequest = {
    queryId: bigint;
    outActions?: Cell | null;
    extraActions?: Cell[];
};

export function extensionActionRequestBody(r: ExtensionActionRequest): Cell {
    const b = beginCell()
        .storeUint(AgenticWalletOp.extensionActionRequest, 32)
        .storeUint(r.queryId, 64)
        .storeMaybeRef(r.outActions ?? null);
    const extra = chainExtraActions(r.extraActions ?? []);
    b.storeBit(extra !== null);
    if (extra) b.storeSlice(extra.beginParse());
    return b.endCell();
}

export type SignedRequest = {
    walletIndex: bigint;
    validUntil: number;
    seqno: number;
    outActions?: Cell | null;
    extraActions?: Cell[];
};

function storeSignedRequest(b: Builder, op: number, r: SignedRequest): Builder {
    return b
        .storeUint(op, 32)
        .storeUint(r.walletIndex, 256)
        .storeUint(r.validUntil, 32)
        .storeUint(r.seqno, 32)
        .storeMaybeRef(r.outActions ?? null)
        .storeMaybeRef(chainExtraActions(r.extraActions ?? []));
}

/** Operator-signed external request: payload, then a 512-bit signature over its hash. */
export function externalSignedRequestBody(r: SignedRequest, operatorSecretKey: Buffer): Cell {
    const payload = storeSignedRequest(beginCell(), AgenticWalletOp.externalSignedRequest, r).endCell();
    const signature = sign(payload.hash(), operatorSecretKey);
    return beginCell().storeSlice(payload.beginParse()).storeBuffer(signature).endCell();
}

export class AgenticWallet implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
        readonly index?: bigint,
    ) {}

    static createFromAddress(address: Address) {
        return new AgenticWallet(address);
    }

    /** Wallet a given owner deploys for a given operator key, workchain 0. */
    static forOwner(p: AgenticWalletParams, code: Cell) {
        const index = agenticWalletIndex(p.owner, p.operatorPublicKey, p.deployedByUser ?? true);
        const init = { code, data: agenticWalletInitialData(index, p.collection) };
        return new AgenticWallet(contractAddress(0, init), init, index);
    }

    async sendDeployWallet(provider: ContractProvider, via: Sender, value: bigint, p: AgenticWalletParams, queryId = 0n) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: deployWalletBody(p, queryId),
        });
    }

    async sendExtensionActionRequest(provider: ContractProvider, via: Sender, value: bigint, r: ExtensionActionRequest) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: extensionActionRequestBody(r),
        });
    }

    async sendSignedExternal(provider: ContractProvider, r: SignedRequest, operatorSecretKey: Buffer) {
        await provider.external(externalSignedRequestBody(r, operatorSecretKey));
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        return (await provider.get('seqno', [])).stack.readNumber();
    }

    async getIsSignatureAllowed(provider: ContractProvider): Promise<boolean> {
        return (await provider.get('is_signature_allowed', [])).stack.readBoolean();
    }

    async getPublicKey(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_public_key', [])).stack.readBigNumber();
    }

    async getWalletIndex(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_subwallet_id', [])).stack.readBigNumber();
    }

    /** Registered extensions (same workchain as the wallet). */
    async getExtensions(provider: ContractProvider): Promise<Address[]> {
        const cell = (await provider.get('get_extensions', [])).stack.readCellOpt();
        if (!cell) return [];
        const dict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Bool(), cell);
        return dict.keys().map((k) => new Address(this.address.workChain, Buffer.from(k.toString(16).padStart(64, '0'), 'hex')));
    }
}
