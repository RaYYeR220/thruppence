import fs from 'fs';
import path from 'path';
import { Blockchain, BlockchainTransaction, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, loadMessageRelaxed, SendMode, toNano } from '@ton/core';
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import {
    addExtensionAction,
    AGENTIC_COLLECTION_ADDRESS,
    AgenticWallet,
    AgenticWalletError,
    AgenticWalletOp,
    AgenticWalletParams,
    publicKeyToBigInt,
    sendMessageActions,
    setSignatureAllowedAction,
} from '../wrappers/AgenticWallet';
import {
    ATTACH_TO_WALLET,
    buildSignedPayRequest,
    LimitsError,
    LimitsExtension,
    MIN_BALANCE_TO_PAY,
    NetworkId,
    PayRequest,
    readTextComment,
    signedPayRequestBody,
    payRequestCell,
    STORAGE_RESERVE,
    textCommentCell,
} from '../wrappers/LimitsExtension';
import { agenticWalletCode, expectExternalRejected, fromNanoString, T0 } from './helpers';

const COMMENT = 'Thruppence #42 · concert tickets';
const PER_TX_CAP = toNano('5');
const DAILY_CAP = toNano('10');

describe('LimitsExtension', () => {
    let walletCode: Cell;
    let extCode: Cell;

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let payee: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let operator: KeyPair;
    let device: KeyPair;
    let walletParams: AgenticWalletParams;
    let wallet: SandboxContract<AgenticWallet>;
    let ext: SandboxContract<LimitsExtension>;

    beforeAll(async () => {
        walletCode = agenticWalletCode();
        extCode = await compile('LimitsExtension');
    });

    // The whole production setup, done by the owner's main wallet:
    // deploy the agentic wallet, deploy the extension, register it and
    // switch the operator signature off in the same request.
    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = T0;
        owner = await blockchain.treasury('owner');
        payee = await blockchain.treasury('payee');
        stranger = await blockchain.treasury('stranger');
        operator = keyPairFromSeed(Buffer.alloc(32, 7));
        device = keyPairFromSeed(Buffer.alloc(32, 1));

        walletParams = {
            owner: owner.address,
            operatorPublicKey: publicKeyToBigInt(operator.publicKey),
            collection: AGENTIC_COLLECTION_ADDRESS,
        };
        wallet = blockchain.openContract(AgenticWallet.forOwner(walletParams, walletCode));
        const walletDeploy = await wallet.sendDeployWallet(owner.getSender(), toNano('50'), walletParams);
        expect(walletDeploy.transactions).toHaveTransaction({ to: wallet.address, deploy: true, success: true });

        ext = blockchain.openContract(
            LimitsExtension.createFromConfig(
                {
                    wallet: wallet.address,
                    owner: owner.address,
                    networkId: NetworkId.testnet,
                    deviceKey: publicKeyToBigInt(device.publicKey),
                    perTxCap: PER_TX_CAP,
                    dailyCap: DAILY_CAP,
                },
                extCode,
            ),
        );
        const extDeploy = await ext.sendDeploy(owner.getSender(), toNano('1'));
        expect(extDeploy.transactions).toHaveTransaction({ to: ext.address, deploy: true, success: true });

        const lock = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 1n,
            extraActions: [addExtensionAction(ext.address), setSignatureAllowedAction(false)],
        });
        expect(lock.transactions).toHaveTransaction({ from: owner.address, to: wallet.address, success: true });
    });

    async function request(overrides: Partial<PayRequest> = {}): Promise<PayRequest> {
        return {
            networkId: NetworkId.testnet,
            extAddress: ext.address,
            seqno: await ext.getSeqno(),
            validUntil: blockchain.now! + 60,
            dest: payee.address,
            amount: toNano('1'),
            bounce: false,
            requestId: 42n,
            comment: COMMENT,
            ...overrides,
        };
    }

    async function pay(overrides: Partial<PayRequest> = {}, key: Buffer = device.secretKey) {
        return ext.sendPay(buildSignedPayRequest(await request(overrides), key).body);
    }

    async function balance(address: Address) {
        return (await blockchain.getContract(address)).balance;
    }

    // The transaction triggered by an internal message from -> to.
    function txBetween(txs: BlockchainTransaction[], from: Address, to: Address) {
        const tx = txs.find((t) => {
            const info = t.inMessage?.info;
            return info?.type === 'internal' && info.src.equals(from) && info.dest.equals(to);
        });
        if (!tx) throw new Error(`no transaction ${from} -> ${to}`);
        return tx;
    }

    it('pays dest with the exact comment text', async () => {
        const res = await pay({ amount: toNano('1.5') });

        expect(res.transactions).toHaveTransaction({ to: ext.address, success: true });
        expect(res.transactions).toHaveTransaction({
            from: ext.address,
            to: wallet.address,
            op: AgenticWalletOp.extensionActionRequest,
            success: true,
        });
        expect(res.transactions).toHaveTransaction({
            from: wallet.address,
            to: payee.address,
            value: toNano('1.5'),
            body: textCommentCell(COMMENT),
        });
        expect(readTextComment(txBetween(res.transactions, wallet.address, payee.address).inMessage!.body)).toBe(COMMENT);

        expect(await ext.getSeqno()).toBe(1);
        expect((await ext.getSpent()).spent).toBe(toNano('1.5'));
    });

    it('rejects a bad signature (401)', async () => {
        const stolen = keyPairFromSeed(Buffer.alloc(32, 99));
        await expectExternalRejected(pay({}, stolen.secretKey), LimitsError.badSignature);

        // A valid signature glued to a different request is just as bad.
        const signed = buildSignedPayRequest(await request(), device.secretKey);
        const tampered = payRequestCell({ ...(await request()), amount: toNano('4') });
        await expectExternalRejected(ext.sendPay(signedPayRequestBody(signed.signature, tampered)), LimitsError.badSignature);

        expect(await ext.getSeqno()).toBe(0);
    });

    it('rejects a replay (402)', async () => {
        const { body } = buildSignedPayRequest(await request(), device.secretKey);
        await ext.sendPay(body);
        expect(await ext.getSeqno()).toBe(1);

        await expectExternalRejected(ext.sendPay(body), LimitsError.badSeqno);
        await expectExternalRejected(pay({ seqno: 5 }), LimitsError.badSeqno);
        expect((await ext.getSpent()).spent).toBe(toNano('1'));
    });

    it('rejects an expired request and one valid for more than 600 s (403)', async () => {
        await expectExternalRejected(pay({ validUntil: T0 }), LimitsError.expired);
        await expectExternalRejected(pay({ validUntil: T0 - 1 }), LimitsError.expired);
        await expectExternalRejected(pay({ validUntil: T0 + 601 }), LimitsError.expired);

        const res = await pay({ validUntil: T0 + 600 });
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: toNano('1') });
    });

    it('rejects while paused (404)', async () => {
        await ext.sendSetPaused(owner.getSender(), toNano('0.05'), true);
        expect((await ext.getLimits()).paused).toBe(true);
        await expectExternalRejected(pay(), LimitsError.paused);

        await ext.sendSetPaused(owner.getSender(), toNano('0.05'), false);
        const res = await pay();
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: toNano('1') });
    });

    it('allows exactly perTxCap and rejects perTxCap + 1 nano (405)', async () => {
        await expectExternalRejected(pay({ amount: PER_TX_CAP + 1n }), LimitsError.overTxCap);

        const res = await pay({ amount: PER_TX_CAP });
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: PER_TX_CAP });
    });

    it('allows exactly dailyCap in total and rejects the next nano (406)', async () => {
        await pay({ amount: toNano('5') });
        await pay({ amount: toNano('3') });
        await pay({ amount: toNano('2') });
        expect((await ext.getSpent()).spent).toBe(DAILY_CAP);

        await expectExternalRejected(pay({ amount: 1n }), LimitsError.overDailyCap);
        expect(await ext.getSeqno()).toBe(3);
    });

    it('rolls the window after 86400 s', async () => {
        await pay({ amount: toNano('5') });
        await pay({ amount: toNano('5') });
        expect(await ext.getSpent()).toEqual({ spent: DAILY_CAP, windowStart: T0 });

        blockchain.now = T0 + 86399;
        await expectExternalRejected(pay({ amount: 1n }), LimitsError.overDailyCap);
        expect((await ext.getSpent()).spent).toBe(DAILY_CAP);

        blockchain.now = T0 + 86400;
        expect((await ext.getSpent()).spent).toBe(0n);
        const res = await pay({ amount: toNano('4') });
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: toNano('4') });
        expect(await ext.getSpent()).toEqual({ spent: toNano('4'), windowStart: T0 + 86400 });
    });

    it('rejects a request bound to another extension or network (407)', async () => {
        await expectExternalRejected(pay({ extAddress: stranger.address }), LimitsError.wrongDomain);
        await expectExternalRejected(pay({ networkId: NetworkId.mainnet }), LimitsError.wrongDomain);
        expect(await ext.getSeqno()).toBe(0);
    });

    it('rejects paying the wallet, the extension or a masterchain address (408)', async () => {
        await expectExternalRejected(pay({ dest: wallet.address }), LimitsError.badDest);
        await expectExternalRejected(pay({ dest: ext.address }), LimitsError.badDest);
        await expectExternalRejected(pay({ dest: new Address(-1, payee.address.hash) }), LimitsError.badDest);
    });

    it('rejects a comment that is not a one-cell text comment (410)', async () => {
        const notText = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).endCell();
        const withRef = beginCell().storeUint(0, 32).storeStringTail('hi').storeRef(textCommentCell('tail')).endCell();
        const tooShort = beginCell().storeUint(0, 16).endCell();
        const notBytes = beginCell().storeUint(0, 32).storeUint(1, 7).endCell();
        for (const comment of [notText, withRef, tooShort, notBytes]) {
            await expectExternalRejected(pay({ comment }), LimitsError.badComment);
        }
        // An empty text comment is still a text comment.
        const res = await pay({ comment: '' });
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, body: textCommentCell('') });
    });

    it('only the owner can SetLimits, SetDevice, SetPaused and Withdraw (409)', async () => {
        const value = toNano('0.05');
        const strangerKey = publicKeyToBigInt(keyPairFromSeed(Buffer.alloc(32, 66)).publicKey);
        const attempts = [
            () => ext.sendSetLimits(stranger.getSender(), value, toNano('1000'), toNano('1000')),
            () => ext.sendSetDevice(stranger.getSender(), value, strangerKey),
            () => ext.sendSetPaused(stranger.getSender(), value, true),
            () => ext.sendWithdraw(stranger.getSender(), value),
        ];
        for (const attempt of attempts) {
            const res = await attempt();
            expect(res.transactions).toHaveTransaction({
                from: stranger.address,
                to: ext.address,
                success: false,
                exitCode: LimitsError.notOwner,
            });
        }
        expect(await ext.getLimits()).toEqual({ perTxCap: PER_TX_CAP, dailyCap: DAILY_CAP, paused: false });
        expect(await ext.getDeviceKey()).toBe(publicKeyToBigInt(device.publicKey));

        await ext.sendSetLimits(owner.getSender(), value, toNano('2'), toNano('3'));
        expect(await ext.getLimits()).toEqual({ perTxCap: toNano('2'), dailyCap: toNano('3'), paused: false });
        await ext.sendSetPaused(owner.getSender(), value, true);
        expect((await ext.getLimits()).paused).toBe(true);
        await ext.sendSetDevice(owner.getSender(), value, strangerKey);
        expect(await ext.getDeviceKey()).toBe(strangerKey);

        const before = await balance(ext.address);
        const res = await ext.sendWithdraw(owner.getSender(), value);
        expect(res.transactions).toHaveTransaction({ from: ext.address, to: owner.address });
        const back = txBetween(res.transactions, ext.address, owner.address).inMessage!.info;
        expect(back.type === 'internal' && back.value.coins).toBeGreaterThan(before - STORAGE_RESERVE - toNano('0.01'));
        expect(await balance(ext.address)).toBe(STORAGE_RESERVE);
        expect(await ext.getWallet()).toMatchObject({ networkId: NetworkId.testnet });
    });

    it('accepts the rotated device key and rejects the old one', async () => {
        const fresh = keyPairFromSeed(Buffer.alloc(32, 2));
        await ext.sendSetDevice(owner.getSender(), toNano('0.05'), publicKeyToBigInt(fresh.publicKey));

        await expectExternalRejected(pay(), LimitsError.badSignature);
        const res = await pay({}, fresh.secretKey);
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: toNano('1') });
    });

    it('end to end on the real agentic wallet: the extension is the only way to spend', async () => {
        expect((await wallet.getExtensions()).map((a) => a.toRawString())).toEqual([ext.address.toRawString()]);
        expect(await wallet.getIsSignatureAllowed()).toBe(false);
        const bound = await ext.getWallet();
        expect(bound.wallet.equals(wallet.address) && bound.owner.equals(owner.address)).toBe(true);
        expect(bound.networkId).toBe(NetworkId.testnet);

        // The operator key the wallet was created with is dead.
        const transfer = sendMessageActions([
            {
                mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                message: { info: { type: 'internal', ihrDisabled: true, bounce: false, bounced: false, dest: stranger.address, value: { coins: toNano('10') }, ihrFee: 0n, forwardFee: 0n, createdAt: 0, createdLt: 0n }, body: Cell.EMPTY },
            },
        ]);
        await expectExternalRejected(
            wallet.sendSignedExternal({ walletIndex: wallet.index!, validUntil: T0 + 60, seqno: 0, outActions: transfer }, operator.secretKey),
            AgenticWalletError.signatureDisabled,
        );

        const amount = toNano('2.5');
        const walletBefore = await balance(wallet.address);
        const extBefore = await balance(ext.address);
        const payeeBefore = await balance(payee.address);

        const res = await pay({ amount });

        const walletDrop = walletBefore - (await balance(wallet.address));
        const extDrop = extBefore - (await balance(ext.address));
        expect(res.transactions).toHaveTransaction({
            from: wallet.address,
            to: payee.address,
            value: amount,
            body: textCommentCell(COMMENT),
            success: true,
        });
        // The wallet pays the amount; the attached coins cover its fees and the rest stays with it.
        expect(walletDrop).toBeLessThanOrEqual(amount);
        expect(walletDrop).toBeGreaterThan(amount - ATTACH_TO_WALLET);
        // The extension spends gas plus the attachment, never the amount.
        expect(extDrop).toBeGreaterThanOrEqual(ATTACH_TO_WALLET);
        expect(extDrop).toBeLessThan(toNano('0.03'));
        // The payee got the amount (less its own receive fees).
        expect((await balance(payee.address)) - payeeBefore).toBeGreaterThan(amount - toNano('0.01'));
    });

    it('a request at the cap cannot drain the wallet or touch its settings', async () => {
        const walletBefore = await balance(wallet.address);
        expect(walletBefore).toBeGreaterThan(toNano('45'));

        const res = await pay({ amount: PER_TX_CAP, bounce: true });

        // What the extension sent to the wallet: one send-message action, mode 3, no extra actions.
        const toWallet = txBetween(res.transactions, ext.address, wallet.address).inMessage!;
        const cs = toWallet.body.beginParse();
        expect(cs.loadUint(32)).toBe(AgenticWalletOp.extensionActionRequest);
        expect(cs.loadUintBig(64)).toBe(42n);
        const outList = cs.loadMaybeRef()!;
        expect(cs.loadBit()).toBe(false); // hasExtraActions
        expect(cs.remainingBits).toBe(0);
        expect(cs.remainingRefs).toBe(0);

        const action = outList.beginParse();
        expect(action.loadRef().bits.length).toBe(0); // prev = empty list, so exactly one action
        expect(action.loadUint(32)).toBe(0x0ec3c86d);
        expect(action.loadUint(8)).toBe(SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS);
        const out = loadMessageRelaxed(action.loadRef().beginParse());
        expect(out.info.type === 'internal' && out.info.dest.equals(payee.address)).toBe(true);
        expect(out.info.type === 'internal' && out.info.value.coins).toBe(PER_TX_CAP);
        expect(out.info.type === 'internal' && out.info.bounce).toBe(true);
        expect(out.init).toBeFalsy();

        const walletTx = txBetween(res.transactions, ext.address, wallet.address);
        expect(walletTx.outMessagesCount).toBe(1);
        expect(walletBefore - (await balance(wallet.address))).toBeLessThanOrEqual(PER_TX_CAP);
        expect((await blockchain.getContract(wallet.address)).accountState?.type).toBe('active');
        expect((await wallet.getExtensions()).map((a) => a.toRawString())).toEqual([ext.address.toRawString()]);
        expect(await wallet.getIsSignatureAllowed()).toBe(false);

        // Asking for more than the cap does not get through at all.
        await expectExternalRejected(pay({ amount: walletBefore }), LimitsError.overTxCap);
    });

    it('refuses to accept a request when its own balance is too low (411)', async () => {
        await ext.sendWithdraw(owner.getSender(), toNano('0.05'));
        expect(await balance(ext.address)).toBeLessThan(MIN_BALANCE_TO_PAY);
        await expectExternalRejected(pay(), LimitsError.lowBalance);

        await owner.send({ to: ext.address, value: toNano('0.5'), bounce: false });
        const res = await pay();
        expect(res.transactions).toHaveTransaction({ from: wallet.address, to: payee.address, value: toNano('1') });
    });

    it('keeps plain transfers, comments and unknown ops as top-ups', async () => {
        const before = await balance(ext.address);
        const bodies = [Cell.EMPTY, textCommentCell('gas money'), beginCell().storeUint(0xdeadbeef, 32).endCell()];
        for (const body of bodies) {
            const res = await stranger.send({ to: ext.address, value: toNano('0.1'), bounce: true, body });
            expect(res.transactions).toHaveTransaction({ from: stranger.address, to: ext.address, success: true });
            expect(res.transactions).not.toHaveTransaction({ from: ext.address });
        }
        expect(await balance(ext.address)).toBeGreaterThan(before + toNano('0.29'));
    });

    it('takes back the attachment when the wallet is not there', async () => {
        // An extension pointed at an address with no contract on it.
        const missing = new Address(0, Buffer.alloc(32, 0xab));
        const orphan = blockchain.openContract(
            LimitsExtension.createFromConfig(
                {
                    wallet: missing,
                    owner: owner.address,
                    networkId: NetworkId.testnet,
                    deviceKey: publicKeyToBigInt(device.publicKey),
                    perTxCap: PER_TX_CAP,
                    dailyCap: DAILY_CAP,
                },
                extCode,
            ),
        );
        await orphan.sendDeploy(owner.getSender(), toNano('1'));

        const req = { ...(await request()), extAddress: orphan.address, seqno: 0 };
        const res = await orphan.sendPay(buildSignedPayRequest(req, device.secretKey).body);
        expect(res.transactions).toHaveTransaction({ from: orphan.address, to: missing, aborted: true });
        expect(res.transactions).toHaveTransaction({ from: missing, to: orphan.address, inMessageBounced: true, success: true });
        expect(await orphan.getSeqno()).toBe(1);
    });

    it('costs well under 0.03 TON per payment (gas report)', async () => {
        const amount = toNano('1');
        const extBefore = await balance(ext.address);
        const walletBefore = await balance(wallet.address);

        const res = await pay({ amount });

        const extTx = res.transactions[0];
        const walletTx = txBetween(res.transactions, ext.address, wallet.address);
        const computeOf = (tx: BlockchainTransaction) => {
            if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') throw new Error('no compute phase');
            return tx.description.computePhase;
        };
        const extCompute = computeOf(extTx);
        const walletCompute = computeOf(walletTx);

        const extDrop = extBefore - (await balance(ext.address));
        const walletDrop = walletBefore - (await balance(wallet.address));
        const feesPerPayment = extDrop + walletDrop - amount;

        const report = {
            note: 'One device-signed payment of 1 TON through the extension and the official agentic wallet, @ton/sandbox default config.',
            extComputeGas: Number(extCompute.gasUsed),
            extComputeFeeTon: fromNanoString(extCompute.gasFees),
            extTxFeesTon: fromNanoString(extTx.totalFees.coins),
            extBalanceDropTon: fromNanoString(extDrop),
            attachedToWalletTon: fromNanoString(ATTACH_TO_WALLET),
            walletComputeGas: Number(walletCompute.gasUsed),
            walletComputeFeeTon: fromNanoString(walletCompute.gasFees),
            walletTxFeesTon: fromNanoString(walletTx.totalFees.coins),
            feesPerPaymentTon: fromNanoString(feesPerPayment),
        };
        fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, '..', 'results', 'gas.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(report);

        expect(extDrop).toBeLessThan(toNano('0.03'));
        expect(feesPerPayment).toBeLessThan(toNano('0.03'));
        // The attachment leaves a wide margin over what the wallet actually burns.
        expect(walletCompute.gasFees * 4n).toBeLessThan(ATTACH_TO_WALLET);
    });
});
