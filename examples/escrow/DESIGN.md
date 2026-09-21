# Escrow: the design, and the brief for the page

Brief 1 of [`../BRIEFS.md`](../BRIEFS.md). The contract and the logic are built and tested; what is
left is `index.html`, the page a person uses. This file is the whole of what the designer needs:
the state machine to render, the exact shape of every function it may call, and the rules the page
must not break. Read the brief's ground rules too — they all still apply, particularly *no hosts in
repos* and *nothing live changes*.

## 1. What it is, and what it is not

A hash-and-deadline lock. The payer sends sats naming a payee, a hash, and a deadline. Before the
deadline only the preimage releases them, and only to the payee. After the deadline only the payer
can take them back. No arbiter, no owner, no upgrade path, no admin key — the third role is *none*.

Say this plainly on the page, because it is the honest part: the contract guarantees the payer
**cannot** take the money back early and **cannot** send it anywhere but to the payee. It does not
force the payer to release the secret; a payer who never reveals it simply gets a refund at the
deadline. What it buys is that the preimage becomes a receipt anyone can check, and that the same
secret can unlock the other leg of a trade — two locks with the same hash on two chains are an
atomic swap, and the preimage is what makes them atomic. This is the primitive agents will use to
buy from each other, in its smallest honest form.

## 2. What already exists

| file | what it is | state |
| --- | --- | --- |
| `Escrow.sol` | the contract, 34 lines | live at `0x42c6f8bd9c1f44ce52e509b16139023a5d2998d5` on `sidestr:txbt4-evm`, block 520 |
| `escrow.mjs` | all the logic, no DOM | done; §4 is its API |
| `test/escrow-test.mjs` | end to end on a throwaway chain | 41 checks, all passing |
| `test/compile.mjs` | Escrow.sol → `test/fixtures/` | solc 0.8.28, optimiser 200, cancun |
| `index.html` | the page | built; proven in Chrome on `txbt4-evm` — see §8 |
| `og.svg` · `og.png` | 1200×630, rendered with headless Chromium | done |

Measured on a throwaway chain, and the deployment on the live one (1 gas = 1 gwei = 1 sat): deploy
580,854 · lock 114,767 · claim 41,622 · refund 40,482. Creation code is 2,468 bytes, runtime 2,440.
The sha256 precompile is live on both — the design's one assumption, checked at the top of the test
and again against the deployed contract.

## 3. The contract, and the five decisions worth explaining

The page explains it line by line, beside the code, as `../../faucet/index.html` does. These are the
choices a reader should come away understanding:

- **`sha256`, not `keccak256`.** About 60 gas against 36, and in exchange the same secret unlocks a
  Bitcoin-style HTLC on the sats side of a sidestr chain. The hash is the bridge to everything else.
- **The id is content-addressed**: `keccak(payer, payee, hash, deadline)`, not a counter. The payer
  knows the id before sending anything, so it can go straight into a link, and nobody can squat it
  because `payer` is `msg.sender` and cannot be forged.
- **The struct is ordered for packing.** `address payer` (20 bytes) and `uint64 deadline` (8) share
  one storage slot, so a lock writes four slots instead of five: 20,000 gas — 20,000 sats — saved by
  writing two fields in the right order.
- **`claim` and `refund` check no caller.** The secret is the authorisation, not the sender, and the
  money goes to the payee or payer the lock names whoever pays the gas. One `require` fewer, and a
  third party can push a claim through for a payee with no gwei.
- **Delete, then pay, with `.call`.** `transfer`'s 2,300-gas stipend breaks contract payees, so this
  uses `.call`; `.call` is only safe because the lock is already gone when the callee runs. The
  faucet page's "write before paying" lesson, one notch harder. And `block.timestamp <` in claim
  against `>=` in refund means the two windows can never both be open, which is what makes the
  missing caller check safe rather than sloppy.

## 4. The module the page is a rendering of

`escrow.mjs` holds every decision. The page decides nothing the module has not already decided: it
shows `state`, `why` and at most one `action`. Import it and `../../ide/abi.mjs` relatively; the
wallet comes from the jsDelivr pin, as in the faucet and the ide.

```js
import * as E from './escrow.mjs';

// constants
E.GWEI            // 1000000000n — wei per sat. The contract counts wei; people are shown sats.
E.MARGIN          // 120 s. Inside this much of the deadline, a claim is unsafe to publish.
E.MIN_TERM        // 600 s. The shortest deadline the page may offer.
E.GAS             // { lock: 180000n, claim: 90000n, refund: 80000n } — the gas LIMIT each action is
                  // sent with, and so what the role must hold up front. See §7: this page sets its
                  // own limits because the wallet's automatic one can silently under-shoot.
E.SIG · E.EVENT   // the signatures, if the page ever needs a raw call

// secrets — no chain needed
E.newSecret()                      → '0x…' 32 bytes
await E.hashOf(secret)             → '0x…' sha256 of those bytes
await E.opens(secret, lock)        → boolean, never throws (use it to light the claim button as they type)
await E.sha256Live(w)              → boolean; the VM check, worth doing once on load

// reading
await E.idOf(w, { payer, payee, hash, deadline })   → '0x…' the lock's id
await E.readLock(w, escrow, id)    → null | { id, payer, payee, wei, sats, deadline, hash }
                                     sats and wei are BigInt; deadline is unix seconds as a Number.
                                     null means claimed, refunded, or never made — ask history which.
await E.history(w, escrow, { address })  → newest first, each { kind, id, height, gasUsed, txid, ethHash, from }
                                     kind 'locked' adds payer, payee, wei, sats, deadline, hash
                                     kind 'claimed' adds preimage; 'refunded' adds nothing
                                     address filters to the locks that key is party to
E.settlementOf(events, id)         → that lock's 'claimed' | 'refunded' record, or null

// the state machine — the page is this table and nothing else
E.stateOf(lock, { now, me, settled, margin })
  → { state, role, action, why, secondsLeft }
     state   'none' | 'open' | 'closing' | 'expired' | 'claimed' | 'refunded'
     role    'payer' | 'payee' | 'observer'
     action  null | { kind: 'lock' | 'claim' | 'refund', label, needs: 'form' | 'secret' | null }
     why     one sentence, ready to show; when action is null this is the whole answer
     secondsLeft  to the deadline, negative past it

// building — each dry-runs on the page's own state first, so a refusal is a sentence, not a receipt
await E.buildLock(w,   { key, escrow, payee, hash, deadline, sats })   → b + { id, deadline, sats, payee, hash }
await E.buildClaim(w,  { key, escrow, lock, secret })                  → b + { id, sats }
await E.buildRefund(w, { key, escrow, lock })                          → b + { id, sats }
await E.dryRun(w, { from, to, data, value })  → { ok, gasUsed, reason }  reason is the revert word
E.needs(kind, sats)               → gwei that role must hold before it can act
```

Everything that can refuse throws an `Error` whose `message` is already a sentence for a person —
show it, do not rewrite it. The five revert words the chain itself can answer with are `empty`,
`nobody`, `past`, `taken`, `gone`, `late`, `early` and `hash`; `escrow.mjs` catches all of them
before signing and turns them into that sentence, so the page never has to know them.

A build `b` is the wallet's: `b.hex`, `b.txid`, `b.ethHash`, `b.fee` (sats for the carrier),
`b.gasUsed` and `b.evmAfter` from the dry run, `b.note` in plain words. Publishing is the faucet
page's loop exactly: `await w.publish(b.hex)` → poll `await w.mined(b.txid)` every 5 s → then
`w.evmReceipt(b.ethHash)` for `status`, `gasUsed` and `logs`. Re-read the lock afterwards; do not
assume the new state.

## 5. The screen

One page, one lock at a time: `?chain=<chain id>&lock=<0x…>`, defaulting to `sidestr:txbt4-evm`. No
lock in the URL means the make-a-lock view. The contract is `E.ESCROW[chainId]`; `?escrow=`
overrides it for anyone testing their own deployment.

The whole interface is the state table. One primary action at a time, chosen by the lock's state and
by whose key is in this browser — never two buttons, never a disabled button with no explanation:

| state | payer sees | payee sees | anyone else |
| --- | --- | --- | --- |
| `none` | the lock form | nothing here | nothing here |
| `open` | copy the secret, hand it over when they deliver · countdown · *no action* | paste the preimage → **claim** | read-only: amount, parties, countdown |
| `closing` | *no action*; the payee should not claim this late | why it is too late to be safe | read-only |
| `expired` | **refund** | too late; the payer may take it back | read-only |
| `claimed` | paid; the preimage is public now | paid in block N, G gas | the trade, settled, with the preimage |
| `refunded` | refunded in block N | never claimed | — |

Sections, in the faucet page's shape: the lock, live (parties, amount in sats, countdown, hash, the
contract's own balance) · your one action · the code, line by line · what has happened to this
contract (from `E.history`) · how it got here.

Four things the page must handle that are not obvious from the table:

1. **The secret is the payer's to keep and to hand over.** Generate it with `E.newSecret()`, store it
   under `sidestr_escrow_secret:<chain id>:<lock id>`, and say that losing it means waiting for the
   refund. It never goes in the URL, in the link the payee is given, or on the chain until the claim.
   What the payer sends the payee is the lock link; the secret follows separately, when they are
   satisfied.
2. **Gas before anything else.** Both parties need gwei in the EVM *and* sats for the carrier fee, or
   nothing they press will work — the likeliest way a first run fails, and nothing to do with the
   contract. Lead the payee's view with `E.needs('claim')` against their balance, the deposit button
   and a link to the faucet contract, exactly as the faucet page does.
3. **The margin, explained rather than enforced silently.** In `closing` the claim button is gone.
   Show `why`: a claim published this close may land in a block after the deadline, revert `"late"`,
   and make the secret public for nothing while the payer refunds.
4. **Whose clock.** The producer sets `block.timestamp`, so on a single-signer chain the deadline is
   that signer's word for what time it is. One sentence, near the countdown.

## 6. Conventions, and what must stay true

- Every page here: a `<title>`, the OGP set the others carry, a link back to the directory, `?chain=`
  for the chain id, **sats before any other unit**. The faucet page is the model for the layout, the
  palette and the line-by-line explanation; the ide is the model for the build-publish-wait loop.
- The key is the shared `sidestr_key:<chain id>` in `localStorage` — the same key the wallet, the ide
  and the faucet use. Offer to make one if there is none. Never put a key in a URL or a repo.
- No server, no API, no RPC: every number on the page comes from the chain this page validated
  itself. No host, mirror or endpoint is written into the file.
- Licence AGPL-3.0-or-later. One-line commit messages saying what changed and why. No attribution
  footers or session links in commits.

## 7. The gas limit, and why this page sets its own

The wallet picks a gas limit for you: it dry-runs once at a high limit and re-signs at
`gasUsed × 1.25 + 5,000`. For a call that ends in `.call`, that measurement is taken under
conditions the real transaction does not repeat, and the limit can come out below what the
transaction actually needs. The transaction is then still **valid** — it is mined, it costs its
sats, and it does nothing.

Worse, nothing in the build tells you. `checkTx` executes the transaction and writes a receipt with
the real status, then deletes that receipt before returning (`spec/siding/lib/overlays/evm.mjs`), and
its `ok` means only "a validator would accept this into a block". So `buildEvm` returns happily,
`b.gasUsed` is the gas the failing run burned, and the page publishes it.

This is not hypothetical: claims `0x370aac75…` (block 531) and `0x4ef5f782…` (block 532) on
`txbt4-evm` were both built this way, both went out with a 48,414 limit, both spent exactly 48,414
sats, and both left the lock untouched. The claim needs about 57,000 — 21,000 intrinsic plus ~35,000
of execution — and the estimate had only counted the execution.

`escrow.mjs` therefore does two things, and any page built on the wallet's EVM side should copy both:

- **it sets its own `gasLimit`** per action, from `E.GAS` (unused gas is not charged, so a generous
  limit costs nothing but the balance it demands up front); and
- **it refuses to publish a build whose `gasUsed` reached its `gasLimit`**, which is the tell for a
  dry run that ran out of gas. That check is three lines and it would have caught both failures.

## 8. Done when

The page makes a lock on `txbt4-evm` and shows it; a second browser with the payee's key claims it
with the preimage and the sats arrive; a lock left to expire refunds; a wrong preimage and an early
refund each say why *before* anything is signed; every figure on the page is read from the page's own
validated state; it reads well on a phone; `node test/escrow-test.mjs` still passes.

Proven on the live chain, from the page, in Chrome, at
`0x42c6f8bd9c1f44ce52e509b16139023a5d2998d5`, every path:

| block | what | gas |
| --- | --- | --- |
| 530 | locked 5,000 sats | 114,767 |
| 534 | claimed by the payee with the preimage | 41,622 |
| 535 | locked 5,000 sats **from the page's own form** | 114,767 |
| 537 | refunded to the payer after the deadline | 40,472 |

and, without spending anything: a wrong preimage refused in the page before any call, the claim
button dark until the secret hashes to the lock, the page rewriting its URL to the lock it has just
made and keeping both the payee link and the secret across the re-render, the state pill naming each
key's role from the chain's records, and the history built from the contract's logs.

Then report, as the brief asks: the commit, the live URL, the test output, the gas of each call, and
the issues filed:

0. **`buildEvm` can hand back a transaction that cannot succeed, and says nothing** — §7. It cost
   real sats twice before it was understood, and the faucet page and the ide are exposed to it too.
   Filed as [wallet#2](https://github.com/sidestr/wallet/issues/2), with
   [spec#3](https://github.com/sidestr/spec/issues/3) for the half of the fix that belongs in
   `checkTx`: stop discarding the execution status it just computed.

1. **`ide/abi.mjs` is not in the wallet.** `w.abi.encode` handles only words and its `selector` knows
   only the ERC-20 constants, so anything with a `bytes32` or `uint64` argument needs the
   playground's coder. This page imports it across two directories rather than copy it.
   [wallet#3](https://github.com/sidestr/wallet/issues/3)
2. **No log decoding.** Receipts carry raw `[address, topics, data]`; `E.history` hand-rolls it.
   Wants a `wallet.logs(address, signature)`. [wallet#4](https://github.com/sidestr/wallet/issues/4)
3. **`w.keccak(hex)` hashes the ASCII of the string** — it takes bytes only as a `Uint8Array`
   (`wallet.mjs:163`). A quiet footgun for exactly this kind of code, filed together with the missing
   `sha256` helper as [wallet#5](https://github.com/sidestr/wallet/issues/5).
4. **`evmActivity` matches any topic whose last 20 bytes equal the address** (`wallet.mjs:158`), so a
   `bytes32` lock id can false-positive as one of your transactions.
   [wallet#6](https://github.com/sidestr/wallet/issues/6)
5. **No sha256 helper** in the wallet, though the precompile is there and this design leans on it —
   folded into [wallet#5](https://github.com/sidestr/wallet/issues/5).
