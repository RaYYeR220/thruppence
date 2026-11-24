// Builds the pay-request fixture from fixed inputs. Shared by
// scripts/make-fixture.ts (writes the file) and tests/PayRequestFixture.spec.ts
// (checks the committed file still matches the code and the wrapper).
import { Address, beginCell, Cell, contractAddress, external, storeMessage } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { AGENTIC_COLLECTION_ADDRESS, AgenticWallet, publicKeyToBigInt } from '../wrappers/AgenticWallet';
import { buildSignedPayRequest, limitsExtensionConfigToCell, NetworkId, textCommentCell } from '../wrappers/LimitsExtension';

export const FIXTURE_INPUTS = {
    // 32 raw bytes; ed25519 seed for the device key (tweetnacl / @ton/crypto keyPairFromSeed).
    deviceSeedHex: 'a1b2c3d4e5f60718293a4b5c6d7e8f900f1e2d3c4b5a69788796a5b4c3d2e1f0',
    // Seed for the agentic wallet operator key; only used to derive the wallet address.
    operatorSeedHex: '6f70657261746f72206b657920666f722074687275707065656e636520233031',
    owner: '0:' + '11'.repeat(32),
    dest: '0:' + '5a'.repeat(32),
    collection: AGENTIC_COLLECTION_ADDRESS.toRawString(),
    networkId: NetworkId.testnet,
    perTxCap: '5000000000',
    dailyCap: '10000000000',
    seqno: 3,
    now: 1_800_000_000,
    validUntil: 1_800_000_300,
    amount: '2500000000',
    bounce: false,
    requestId: '42',
    comment: 'Thruppence #42 · concert tickets',
};

export type FixtureInputs = typeof FIXTURE_INPUTS;

const hex = (c: Cell) => c.toBoc().toString('hex');

export function buildFixture(inputs: FixtureInputs, extCode: Cell, walletCode: Cell) {
    const device = keyPairFromSeed(Buffer.from(inputs.deviceSeedHex, 'hex'));
    const operator = keyPairFromSeed(Buffer.from(inputs.operatorSeedHex, 'hex'));
    const owner = Address.parse(inputs.owner);
    const dest = Address.parse(inputs.dest);

    const wallet = AgenticWallet.forOwner(
        { owner, operatorPublicKey: publicKeyToBigInt(operator.publicKey), collection: Address.parse(inputs.collection) },
        walletCode,
    );

    const extConfig = {
        wallet: wallet.address,
        owner,
        networkId: inputs.networkId,
        deviceKey: publicKeyToBigInt(device.publicKey),
        perTxCap: BigInt(inputs.perTxCap),
        dailyCap: BigInt(inputs.dailyCap),
        seqno: inputs.seqno,
    };
    const extData = limitsExtensionConfigToCell(extConfig);
    const extAddress = contractAddress(0, { code: extCode, data: extData });

    const signed = buildSignedPayRequest(
        {
            networkId: inputs.networkId,
            extAddress,
            seqno: inputs.seqno,
            validUntil: inputs.validUntil,
            dest,
            amount: BigInt(inputs.amount),
            bounce: inputs.bounce,
            requestId: BigInt(inputs.requestId),
            comment: inputs.comment,
        },
        device.secretKey,
    );
    const message = beginCell()
        .store(storeMessage(external({ to: extAddress, body: signed.body })))
        .endCell();

    return {
        devicePublicKeyHex: device.publicKey.toString('hex'),
        agenticWallet: {
            operatorPublicKeyHex: operator.publicKey.toString('hex'),
            index: wallet.index!.toString(16).padStart(64, '0'),
            address: wallet.address.toRawString(),
            codeHashHex: walletCode.hash().toString('hex'),
        },
        extension: {
            wallet: wallet.address.toRawString(),
            owner: owner.toRawString(),
            networkId: inputs.networkId,
            deviceKeyHex: device.publicKey.toString('hex'),
            perTxCap: inputs.perTxCap,
            dailyCap: inputs.dailyCap,
            seqno: inputs.seqno,
            dataBocHex: hex(extData),
            codeHashHex: extCode.hash().toString('hex'),
            codeBocHex: hex(extCode),
            address: extAddress.toRawString(),
            addressTestnet: extAddress.toString({ testOnly: true, bounceable: true }),
        },
        expected: {
            commentCellBocHex: hex(textCommentCell(inputs.comment)),
            requestCellBocHex: hex(signed.request),
            requestHashHex: signed.hash.toString('hex'),
            signatureHex: signed.signature.toString('hex'),
            externalBodyBocHex: hex(signed.body),
            externalBodyHashHex: signed.body.hash().toString('hex'),
            externalMessageBocHex: hex(message),
        },
    };
}

export function fixtureDocument(inputs: FixtureInputs, extCode: Cell, walletCode: Cell) {
    const built = buildFixture(inputs, extCode, walletCode);
    return {
        about:
            'Reference vector for the Thruppence pay request. Every off-chain signer must reproduce `expected` from `inputs` exactly. Regenerate with `pnpm --filter @thruppence/contracts fixture` after any contract change.',
        encoding: {
            requestCell: [
                'op:uint32 = 0x50415952',
                'networkId:int32 (-3 testnet, -239 mainnet)',
                'extAddress:addr_std (267 bits: 0b10, anycast 0b0, workchain int8, hash 256)',
                'seqno:uint32',
                'validUntil:uint32 (unix seconds; now < validUntil <= now + 600)',
                'dest:addr_std (267 bits, basechain only)',
                'amount:coins (VarUInteger 16: 4-bit byte length, then big-endian bytes; 0 is 4 zero bits)',
                'bounce:bit',
                'requestId:uint64 (echoed as queryId to the wallet)',
                'comment:^Cell',
            ],
            commentCell: 'uint32 0, then the UTF-8 bytes of the text; no refs; at most 123 bytes',
            signature: 'ed25519 over the 32-byte representation hash of the request cell (not over the BOC)',
            externalBody: 'signature:bits512, then the request cell as the only ref',
            externalMessage: 'ext_in_msg_info to the extension address, no state init, body inline (@ton/core storeMessage)',
            boc: '@ton/core Cell.toBoc() defaults: no index, with crc32c. Compare cells by hash if your serializer differs.',
            seed: 'deviceSeedHex is the 32-byte ed25519 seed (nacl.sign.keyPair.fromSeed)',
        },
        inputs,
        ...built,
    };
}
