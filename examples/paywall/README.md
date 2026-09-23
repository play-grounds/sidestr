# Pay-per-request: an agent buys an answer

Brief 3 of [`../BRIEFS.md`](../BRIEFS.md). A server that answers one question — the height and hash
of the tip of the chain it watches — only after a payment it has checked on its own validated copy
of that chain, and a client agent that asks, is shown a price, pays, waits for the block and asks
again. No human on either side, and nothing trusted but the chain.

It is also a project that is not ours: `npm install sidestr` in its own `package.json`, and
everything — the wallet, the validator, even the producer the test spawns — comes from that.

```
npm install
node server.mjs --key-file server.key --chain sidestr:txbt4-siding --price 1000
SIDESTR_KEY=<hex> node client.mjs http://127.0.0.1:8402          # or --key-file client.key
npm test                                                           # about 3 minutes
```

Keys are 32 bytes of hex in a file with mode 0600 (both sides refuse anything looser), or for the
client `SIDESTR_KEY`, as in the package's agent example. `--mirror URL` pins a mirror instead of
asking the relays; the client then hands its payment to that producer's `POST /tx`, which is how the
test drives a throwaway chain with no relays.

## How a payment is bound to one request

```
client                                  server
  GET /height ───────────────────────▶
              ◀─── 402 { chain, address, sats, nonce, memo, expires }
  checks the invoice: same chain it opened, price under its ceiling,
  memo = OP_RETURN "paywall:" ‖ nonce and nothing else, not about to expire
  pays: sats → address, 0 → memo, change → itself      (one transaction)
  waits for the block
  GET /height?nonce=…&txid=… ────────▶  reads the txid from its own validated state:
                                        mined? pays this address ≥ sats? carries this memo?
              ◀─── 200 { chain, height, hash, paid }
```

The client's only claim is a txid. Everything else the server reads off the chain itself. The memo
is what makes a payment belong to one invoice: a payment for one nonce cannot redeem another, a plain
payment of the right amount without it is refused, and a redeemed invoice (or a txid that has already
bought an answer) is refused with 409. Two requests racing on one paid invoice get exactly one
answer. Invoices live in memory, so a restarted server has forgotten every nonce and old payments
redeem nothing.

The server keeps whatever it is sent, including payments it refuses to answer — it has no way to
return them without being asked to spend, and that is the client's risk to manage by checking the
invoice first. `client.mjs` does: it refuses an invoice for another chain, over its ceiling, about
to expire, or whose memo is anything but the OP_RETURN its nonce implies.

A design this example did not take, and should be argued about: a fresh address per invoice. The
server derives or generates a key per nonce, a payment to that address *is* the binding, and no
OP_RETURN is needed. It costs the server a sweep later and a key per invoice; it saves every client
the gap below.

## Proof

`node test/paywall-test.mjs`, 25 checks against a throwaway chain produced by the `siding` in this
example's own `node_modules`: the client pays and is answered; the same payment is refused a second
time and against a fresh invoice; a payment one sat short, a plain payment without the nonce and a
payment carrying another invoice's nonce are each refused and say why; an unmined txid is told to ask
again with a `Retry-After` and its invoice stays open; two racing redemptions get one answer; the
client refuses an invoice over its ceiling, a tampered memo, another chain, and a key file anyone can
read. A payment with its memo is 190 vB, 190 sats of fee at the chain's rate.

## Report: what the package lacked

1. **No way to pay an address and carry an OP_RETURN in one transaction.** `build()` takes one
   destination: an amount to an address, or a zero-value `carrier` that *replaces* it
   (`amount = carrier ? 0 : …`). The extra-outputs path exists — deposits use it — but only
   internally. `paywall.mjs` rebuilds the transaction by hand and signs it again, which takes six
   internals: `ex.k`, `ex.hash`, `signer`, `txsign`, `vsize`, `minFeeRate`. The smallest fix is an
   `opReturn` (or `outputs`) option on `build()` that goes where the deposit marker already goes.

2. **Doing that by hand has a trap, and `verify()` hides it.** The schema's interpreter caches each
   transaction's sighash midstates — the hash of its outputs among them — in a `WeakMap` keyed by the
   transaction *object*. Change the outputs of a transaction `build()` has already signed, sign it
   again, and the signature commits to the old outputs. `wallet.verify()`, reading the same cache,
   says it is fine. Only a validator, decoding the bytes fresh, refuses it: "invalid key-path schnorr
   signature". The first version of this example did exactly that; the test keeps both halves as
   checks. Two small fixes: `verify()` should decode the transaction from its hex before checking it,
   so it checks what will be sent; and the cache wants either content keys or a clear line in the
   codec that a signed transaction must not be changed in place.

3. **No public way to read a mined transaction.** The server has to see the OP_RETURN of one txid.
   `history(script)` deliberately skips OP_RETURN outputs, `mined(txid)` returns only `{ height }`,
   and there is no `wallet.tx(txid)`, so the server reads the explorer's index, `w.ex.txs`. A
   `wallet.tx(txid) → { tx, height, fee } | null` is one line over what already exists.

4. **No `waitForPayment` (or `waitMined`).** Every example polls `mined()` in a loop of its own:
   the faucet page, the ide, the escrow, and both sides here. `mined()` also asks the mirror for new
   blocks on every call, however often it is polled. A `wallet.waitMined(txid, { timeout })` that
   refreshes once per block would replace all of them.

5. **`publish()` is relays-only.** A throwaway chain has no relays, so every test that submits a
   transaction — the wallet's own, the escrow's, this one — hand-rolls `POST ${mirror}/tx`, and a
   client that is told a mirror has to do the same. `publish(hex, { mirror })` would end that.

6. **The packaged producer looks for the schema in a developer's home directory.**
   `@sidestr/spec`'s `engine.mjs` defaults `SCHEMA` to `~/bitcoin-desktop/schema`. In an installed
   project that path does not exist, although the schema is right there in `node_modules` — the
   `sidestr` package even exports its location as `paths.cdn`. The test sets `SCHEMA` itself; the
   default should be the installed `@bitcoin-desktop/schema` when there is one.

None of these stopped the brief. Numbers 1 and 2 together are the ones worth fixing first: the
missing option is what sends people to hand-built transactions, and the cache is what makes a
hand-built transaction fail in a way nothing local can see.
