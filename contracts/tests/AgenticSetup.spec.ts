import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, internal, SendMode, toNano } from '@ton/core';
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import '@ton/test-utils';
import {
    addExtensionAction,
    AGENTIC_COLLECTION_ADDRESS,
    AgenticWallet,
    AgenticWalletError,
    AgenticWalletParams,
    publicKeyToBigInt,
    sendMessageActions,
    setSignatureAllowedAction,
} from '../wrappers/AgenticWallet';
import { agenticWalletCode, expectExternalRejected, T0 } from './helpers';

describe('Official agentic wallet setup', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let extension: SandboxContract<TreasuryContract>;
    let payee: SandboxContract<TreasuryContract>;
    let operator: KeyPair;
    let params: AgenticWalletParams;
    let wallet: SandboxContract<AgenticWallet>;

    beforeAll(() => {
        code = agenticWalletCode();
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = T0;
        owner = await blockchain.treasury('owner');
        extension = await blockchain.treasury('extension');
        payee = await blockchain.treasury('payee');
        operator = keyPairFromSeed(Buffer.alloc(32, 7));
        params = {
            owner: owner.address,
            operatorPublicKey: publicKeyToBigInt(operator.publicKey),
            collection: AGENTIC_COLLECTION_ADDRESS,
        };
        wallet = blockchain.openContract(AgenticWallet.forOwner(params, code));

        const deploy = await wallet.sendDeployWallet(owner.getSender(), toNano('10'), params);
        expect(deploy.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            deploy: true,
            success: true,
        });
    });

    async function registerExtensionAndLockSignature() {
        return wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 1n,
            extraActions: [addExtensionAction(extension.address), setSignatureAllowedAction(false)],
        });
    }

    it('is owned by the deployer and starts with the operator signature on', async () => {
        expect(await wallet.getSeqno()).toBe(0);
        expect(await wallet.getPublicKey()).toBe(params.operatorPublicKey);
        expect(await wallet.getIsSignatureAllowed()).toBe(true);
        expect(await wallet.getExtensions()).toEqual([]);
        expect(await wallet.getWalletIndex()).toBe(wallet.index);
    });

    it('refuses a deploy from anyone but the owner', async () => {
        const otherParams = { ...params, operatorPublicKey: publicKeyToBigInt(keyPairFromSeed(Buffer.alloc(32, 8)).publicKey) };
        const other = blockchain.openContract(AgenticWallet.forOwner(otherParams, code));
        const stranger = await blockchain.treasury('stranger');
        const res = await other.sendDeployWallet(stranger.getSender(), toNano('1'), otherParams);
        expect(res.transactions).toHaveTransaction({
            from: stranger.address,
            to: other.address,
            success: false,
            exitCode: AgenticWalletError.incorrectSender,
        });
    });

    it('owner adds an extension and disables the operator signature in one request', async () => {
        const res = await registerExtensionAndLockSignature();
        expect(res.transactions).toHaveTransaction({ from: owner.address, to: wallet.address, success: true });

        const extensions = await wallet.getExtensions();
        expect(extensions.map((a) => a.toRawString())).toEqual([extension.address.toRawString()]);
        expect(await wallet.getIsSignatureAllowed()).toBe(false);
    });

    it('rejects an operator-signed external once the signature is disabled', async () => {
        const transfer = sendMessageActions([
            {
                mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                message: internal({ to: payee.address, value: toNano('1'), bounce: false }),
            },
        ]);
        const request = { walletIndex: wallet.index!, validUntil: T0 + 60, seqno: 0, outActions: transfer };

        // Before the lock the operator key works, which proves the request is well formed.
        const ok = await wallet.sendSignedExternal(request, operator.secretKey);
        expect(ok.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: toNano('1') });

        await registerExtensionAndLockSignature();
        await expectExternalRejected(
            wallet.sendSignedExternal({ ...request, seqno: 1 }, operator.secretKey),
            AgenticWalletError.signatureDisabled,
        );
        expect(await wallet.getSeqno()).toBe(1);
    });

    it('a registered extension makes the wallet send a transfer', async () => {
        await registerExtensionAndLockSignature();
        const comment = beginCell().storeUint(0, 32).storeStringTail('via extension').endCell();
        const outActions = sendMessageActions([
            {
                mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                message: internal({ to: payee.address, value: toNano('2'), bounce: false, body: comment }),
            },
        ]);
        const res = await wallet.sendExtensionActionRequest(extension.getSender(), toNano('0.05'), { queryId: 9n, outActions });
        expect(res.transactions).toHaveTransaction({ from: extension.address, to: wallet.address, success: true });
        expect(res.transactions).toHaveTransaction({
            from: wallet.address,
            to: payee.address,
            value: toNano('2'),
            body: comment,
        });
    });

    it('ignores the same request from an address that is not an extension', async () => {
        await registerExtensionAndLockSignature();
        const stranger = await blockchain.treasury('stranger');
        const outActions = sendMessageActions([
            {
                mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                message: internal({ to: stranger.address, value: toNano('2'), bounce: false }),
            },
        ]);
        const res = await wallet.sendExtensionActionRequest(stranger.getSender(), toNano('0.05'), { queryId: 9n, outActions });
        expect(res.transactions).not.toHaveTransaction({ from: wallet.address, to: stranger.address });
    });
});
