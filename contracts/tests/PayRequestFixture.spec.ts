import { Blockchain, internal } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { keyPairFromSeed, signVerify } from '@ton/crypto';
import '@ton/test-utils';
import fixture from './fixtures/payrequest.json';
import { buildFixture, FIXTURE_INPUTS } from '../scripts/fixture-lib';
import {
    addExtensionAction,
    AgenticWallet,
    deployWalletBody,
    extensionActionRequestBody,
    publicKeyToBigInt,
    setSignatureAllowedAction,
} from '../wrappers/AgenticWallet';
import { LimitsExtension, LimitsOp, readTextComment } from '../wrappers/LimitsExtension';
import { agenticWalletCode } from './helpers';

const REGENERATE = 'fixture is stale: run `pnpm --filter @thruppence/contracts fixture` and commit the result';

describe('Pay request fixture', () => {
    let extCode: Cell;
    let walletCode: Cell;

    beforeAll(async () => {
        extCode = await compile('LimitsExtension');
        walletCode = agenticWalletCode();
    });

    it('is up to date with the contract code and the wrapper encoding', () => {
        try {
            expectFixtureFresh();
        } catch (e) {
            throw new Error(`${REGENERATE}
${(e as Error).message}`);
        }
    });

    function expectFixtureFresh() {
        expect(fixture.inputs).toEqual(FIXTURE_INPUTS);
        expect(fixture.extension.codeHashHex).toBe(extCode.hash().toString('hex'));
        const rebuilt = buildFixture(FIXTURE_INPUTS, extCode, walletCode);
        expect({ ...fixture.expected, ext: fixture.extension, wallet: fixture.agenticWallet }).toEqual({
            ...rebuilt.expected,
            ext: rebuilt.extension,
            wallet: rebuilt.agenticWallet,
        });
    }

    it('spells out every field of the request cell in order', () => {
        const request = Cell.fromHex(fixture.expected.requestCellBocHex);
        const cs = request.beginParse();
        expect(cs.loadUint(32)).toBe(LimitsOp.payRequest);
        expect(cs.loadInt(32)).toBe(fixture.inputs.networkId);
        expect(cs.loadAddress().toRawString()).toBe(fixture.extension.address);
        expect(cs.loadUint(32)).toBe(fixture.inputs.seqno);
        expect(cs.loadUint(32)).toBe(fixture.inputs.validUntil);
        expect(cs.loadAddress().toRawString()).toBe(fixture.inputs.dest);
        expect(cs.loadCoins()).toBe(BigInt(fixture.inputs.amount));
        expect(cs.loadBit()).toBe(fixture.inputs.bounce);
        expect(cs.loadUintBig(64)).toBe(BigInt(fixture.inputs.requestId));
        const comment = cs.loadRef();
        expect(cs.remainingBits).toBe(0);
        expect(cs.remainingRefs).toBe(0);
        expect(readTextComment(comment)).toBe(fixture.inputs.comment);
        expect(comment.toBoc().toString('hex')).toBe(fixture.expected.commentCellBocHex);

        expect(request.hash().toString('hex')).toBe(fixture.expected.requestHashHex);
        const device = keyPairFromSeed(Buffer.from(fixture.inputs.deviceSeedHex, 'hex'));
        expect(device.publicKey.toString('hex')).toBe(fixture.devicePublicKeyHex);
        expect(signVerify(request.hash(), Buffer.from(fixture.expected.signatureHex, 'hex'), device.publicKey)).toBe(true);

        const body = Cell.fromHex(fixture.expected.externalBodyBocHex).beginParse();
        expect(body.loadBuffer(64).toString('hex')).toBe(fixture.expected.signatureHex);
        expect(body.loadRef().equals(request)).toBe(true);
        expect(body.remainingBits).toBe(0);
    });

    it('is paid out by a real extension and agentic wallet built from the fixture', async () => {
        const blockchain = await Blockchain.create();
        blockchain.now = fixture.inputs.now;
        const owner = Address.parse(fixture.inputs.owner);
        // The fixture owner is a bare address, so its messages are injected directly.
        const fromOwner = (to: Address, body: Cell, stateInit?: { code: Cell; data: Cell }) =>
            blockchain.sendMessage(internal({ from: owner, to, value: toNano('10'), body, stateInit }));

        const operator = keyPairFromSeed(Buffer.from(fixture.inputs.operatorSeedHex, 'hex'));
        const params = {
            owner,
            operatorPublicKey: publicKeyToBigInt(operator.publicKey),
            collection: Address.parse(fixture.inputs.collection),
        };
        const wallet = blockchain.openContract(AgenticWallet.forOwner(params, walletCode));
        expect(wallet.address.toRawString()).toBe(fixture.agenticWallet.address);
        const deployed = await fromOwner(wallet.address, deployWalletBody(params), wallet.init);
        expect(deployed.transactions).toHaveTransaction({ to: wallet.address, deploy: true, success: true });

        const ext = blockchain.openContract(
            new LimitsExtension(Address.parse(fixture.extension.address), {
                code: Cell.fromHex(fixture.extension.codeBocHex),
                data: Cell.fromHex(fixture.extension.dataBocHex),
            }),
        );
        const extDeployed = await fromOwner(ext.address, Cell.EMPTY, ext.init);
        expect(extDeployed.transactions).toHaveTransaction({ to: ext.address, deploy: true, success: true });
        const locked = await fromOwner(
            wallet.address,
            extensionActionRequestBody({
                queryId: 0n,
                extraActions: [addExtensionAction(ext.address), setSignatureAllowedAction(false)],
            }),
        );
        expect(locked.transactions).toHaveTransaction({ to: wallet.address, success: true });

        const res = await blockchain.sendMessage(Cell.fromHex(fixture.expected.externalMessageBocHex));
        expect(res.transactions).toHaveTransaction({
            from: wallet.address,
            to: Address.parse(fixture.inputs.dest),
            value: BigInt(fixture.inputs.amount),
            body: Cell.fromHex(fixture.expected.commentCellBocHex),
        });
        expect(await ext.getSeqno()).toBe(fixture.inputs.seqno + 1);
    });
});
