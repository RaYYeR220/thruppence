// Thruppence limits extension.
//
// Sits next to a TON Agentic Wallet (Wallet V5 based) as its only extension.
// The phone holds a device key and signs pay requests; this contract checks
// them against a per-transaction cap and a rolling daily cap, then asks the
// wallet to make exactly one plain transfer. The request can choose who gets
// paid, how much, the bounce flag and a text comment. Nothing else: the send
// mode, the out-action list and the (absent) extra actions are built here.

import "@stdlib/gas-payments"

const ERR_BAD_SIGNATURE = 401
const ERR_BAD_SEQNO = 402
const ERR_EXPIRED = 403
const ERR_PAUSED = 404
const ERR_OVER_TX_CAP = 405
const ERR_OVER_DAILY_CAP = 406
const ERR_WRONG_DOMAIN = 407
const ERR_BAD_DEST = 408
const ERR_NOT_OWNER = 409
const ERR_BAD_COMMENT = 410
const ERR_LOW_BALANCE = 411

const WINDOW_SECONDS = 86400
const MAX_VALIDITY_SECONDS = 600

// Attached to every ExtensionActionRequest. It pays the wallet's compute and
// the forward fee of the payout (mode 3 takes fees from the wallet balance,
// which by then includes this value). Whatever is left stays in the user's
// own wallet, so a generous value costs nothing. Measured wallet side of one
// payment: 3,622 gas, ~0.00027 TON in fees at today's config and still under
// 0.002 TON at 400 nanoton/gas, so 0.02 is a 10x+ margin against fee rises
// (tests/LimitsExtension.spec.ts, gas report).
const ATTACH_TO_WALLET: coins = grams("0.02")

// A pay request is only accepted while the extension can cover the attached
// value plus its own compute and forward fees with room to spare. Below this
// the request is refused before acceptExternalMessage, so nothing is burnt.
const MIN_BALANCE_TO_PAY: coins = grams("0.03")

// Left behind by Withdraw so the account keeps paying storage and never
// freezes; the owner can top it up later and carry on.
const STORAGE_RESERVE: coins = grams("0.01")

struct FixedData {
    wallet: address
    owner: address
    networkId: int32
}

struct Storage {
    fixed: Cell<FixedData>
    deviceKey: uint256
    seqno: uint32
    perTxCap: coins
    dailyCap: coins
    windowStart: uint32
    spent: coins
    paused: bool
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Signed by the device key: ed25519 over the representation hash of this cell.
struct (0x50415952) PayRequest {
    networkId: int32
    extAddress: address
    seqno: uint32
    validUntil: uint32
    dest: address
    amount: coins
    bounce: bool
    requestId: uint64
    comment: cell
}

// External message body: signature first, request in the only ref.
struct SignedPayRequest {
    signature: bits512
    request: Cell<PayRequest>
}

// Wallet V5 / Agentic Wallet wire formats.
// One element of the c5 out-action list (block.tlb action_send_msg).
struct (0x0ec3c86d) OutActionSendMsg {
    prev: cell
    mode: uint8
    outMsg: cell
}

struct (0xed84cbf0) ExtensionActionRequest {
    queryId: uint64
    outActions: cell?
    hasExtraActions: bool
}

struct (0x4c494d54) SetLimits {
    queryId: uint64
    perTxCap: coins
    dailyCap: coins
}

struct (0x44455643) SetDevice {
    queryId: uint64
    deviceKey: uint256
}

struct (0x50415553) SetPaused {
    queryId: uint64
    paused: bool
}

struct (0x57445257) Withdraw {
    queryId: uint64
}

type OwnerMessage = SetLimits | SetDevice | SetPaused | Withdraw

fun isPlainTextComment(comment: cell): bool {
    val cs = comment.beginParse();
    val bits = cs.remainingBitsCount();
    return (cs.remainingRefsCount() == 0) && (bits >= 32) && (bits % 8 == 0) && (cs.preloadUint(32) == 0);
}

fun onExternalMessage(inMsgBody: slice) {
    val signed = SignedPayRequest.fromSlice(inMsgBody);
    var storage = lazy Storage.load();

    assert (isSignatureValid(signed.request.hash(), signed.signature as slice, storage.deviceKey)) throw ERR_BAD_SIGNATURE;

    val req = lazy signed.request.load();
    assert (req.seqno == storage.seqno) throw ERR_BAD_SEQNO;

    val now = blockchain.now();
    assert ((req.validUntil > now) & (req.validUntil <= now + MAX_VALIDITY_SECONDS)) throw ERR_EXPIRED;

    assert (!storage.paused) throw ERR_PAUSED;
    assert (req.amount <= storage.perTxCap) throw ERR_OVER_TX_CAP;

    if (now >= storage.windowStart + WINDOW_SECONDS) {
        storage.windowStart = now;
        storage.spent = 0;
    }
    assert (storage.spent + req.amount <= storage.dailyCap) throw ERR_OVER_DAILY_CAP;

    val fixed = storage.fixed.load();
    val myAddress = contract.getAddress();
    assert ((req.networkId == fixed.networkId) & (req.extAddress == myAddress)) throw ERR_WRONG_DOMAIN;

    assert ((req.dest.getWorkchain() == BASECHAIN) & (req.dest != fixed.wallet) & (req.dest != myAddress)) throw ERR_BAD_DEST;
    assert (isPlainTextComment(req.comment)) throw ERR_BAD_COMMENT;
    assert (contract.getOriginalBalance() >= MIN_BALANCE_TO_PAY) throw ERR_LOW_BALANCE;

    // Every check above is free for us if it fails: nothing is paid and
    // nothing changes until the request is fully valid.
    acceptExternalMessage();

    storage.seqno += 1;
    storage.spent += req.amount;
    storage.save();

    var payout: OutMessage;
    if (req.bounce) {
        payout = createMessage({
            bounce: BounceMode.Only256BitsOfBody,
            value: req.amount,
            dest: req.dest,
            body: req.comment,
        });
    } else {
        payout = createMessage({
            bounce: BounceMode.NoBounce,
            value: req.amount,
            dest: req.dest,
            body: req.comment,
        });
    }

    val action: OutActionSendMsg = {
        prev: createEmptyCell(),
        mode: SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS,
        outMsg: payout.messageCell,
    };

    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: ATTACH_TO_WALLET,
        dest: fixed.wallet,
        body: ExtensionActionRequest {
            queryId: req.requestId,
            outActions: action.toCell() as cell,
            hasExtraActions: false,
        },
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy OwnerMessage.fromSlice(in.body);

    match (msg) {
        SetLimits => {
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.fixed.load().owner) throw ERR_NOT_OWNER;
            storage.perTxCap = msg.perTxCap;
            storage.dailyCap = msg.dailyCap;
            storage.save();
        }

        SetDevice => {
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.fixed.load().owner) throw ERR_NOT_OWNER;
            storage.deviceKey = msg.deviceKey;
            storage.save();
        }

        SetPaused => {
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.fixed.load().owner) throw ERR_NOT_OWNER;
            storage.paused = msg.paused;
            storage.save();
        }

        Withdraw => {
            val storage = lazy Storage.load();
            val owner = storage.fixed.load().owner;
            assert (in.senderAddress == owner) throw ERR_NOT_OWNER;
            reserveGramsOnBalance(STORAGE_RESERVE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: owner,
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        else => {
            // Plain transfers, comments and unknown ops are top-ups: keep the coins.
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // A request to the wallet came back (wallet missing or not initialised).
    // The attached coins are back on our balance; nothing else to undo.
}

get fun get_limits(): (coins, coins, bool) {
    val storage = lazy Storage.load();
    return (storage.perTxCap, storage.dailyCap, storage.paused);
}

get fun get_spent(): (coins, int) {
    val storage = lazy Storage.load();
    if (blockchain.now() >= storage.windowStart + WINDOW_SECONDS) {
        return (0, storage.windowStart);
    }
    return (storage.spent, storage.windowStart);
}

get fun seqno(): int {
    val storage = lazy Storage.load();
    return storage.seqno;
}

get fun get_device_key(): int {
    val storage = lazy Storage.load();
    return storage.deviceKey;
}

get fun get_wallet(): (address, address, int) {
    val storage = lazy Storage.load();
    val fixed = storage.fixed.load();
    return (fixed.wallet, fixed.owner, fixed.networkId);
}
