# Briefs for working examples

Each brief is a self-contained task for one session: one page, one deliverable, one test. The
point of every example is twofold: something a person can use, and a list of what it found wrong
in the libraries. Read this whole file before starting a brief; the constraints apply to all of
them.

## Ground rules for every brief

- **Where things are.** The sidestr client is the `sidestr` package (github.com/sidestr/sidestr):
  `openWallet({ chain })` in Node resolves everything locally; in a page import the wallet from
  jsDelivr at the pin the package's `browser.mjs` names. The API is the wallet's
  (github.com/sidestr/wallet/wallet.mjs, read the methods there); the records and rules are the
  spec's §12 (github.com/sidestr/spec, SPEC.md and proposals/); chain documents are
  `chains/*/chain.json` in the spec. Pages here live under `play-grounds/sidestr/<name>/`; the
  faucet page (`faucet/`) is the model for an explained example, the IDE (`ide/`) for a tool.
- **Chains to use.** `sidestr:txbt4-evm` runs the EVM (chain id 21474, 1 sat = 1 gwei);
  `sidestr:tally` runs assets and pools; `sidestr:txbt4-fed` is the 2-of-3 federation;
  `sidestr:capewars-s6` is the game ledger. Open any of them by id; the relays find the mirror.
  Test sats come from a kind 23501 faucet request (`wallet.requestFaucet(address)`); gwei come
  from a deposit (`wallet.build({ evmDeposit: true })`) or the faucet contract at
  `0x78598f93469a2df4673c1395b807df1ccc520222` on txbt4-evm (`ask()`, 1,000 gwei per 600 s).
- **Keys.** 32 bytes of hex, in a file with mode 0600 or in the browser's storage under
  `sidestr_key:<chain id>` (the wallet and every page here share it). Never on a command line,
  never in a repo. A did:nostr secret is a valid key.
- **Nothing live changes.** No producer is restarted, no relay list changes, no chain document
  changes, no spec text changes, nothing on any server. If a library needs fixing to finish the
  brief, file an issue on that repo describing the bug and the smallest fix, and work around it
  in the example. The list of such issues is half the deliverable.
- **No hosts in repos.** Mirrors, RPC endpoints and servers are typed by the user or come from
  the relays; the repositories carry chain ids and jsDelivr pins only. No attribution lines or
  session links in commits.
- **Conventions.** Every page: a `<title>`, the OGP set the other pages carry (`og.svg` rendered
  to `og.png` with headless Chromium at 1200×630), a link back to the directory, `?chain=` for
  the chain id, sats shown before any other unit. Every commit message says what changed and why
  in one line. Licence: AGPL-3.0-or-later.
- **Proof.** A test script under `<name>/test/` that runs the example end to end against a
  throwaway chain where possible (the wallet's `test/evm-test.mjs` shows how to spawn
  `siding produce` on one) and against the live chain read-only otherwise. The report is: the
  commit, the live URL, the test output, and the issues filed.

---

## 1. Escrow: the first trade between two keys

**Deliverable.** `examples/escrow/`: a Solidity escrow contract on `sidestr:txbt4-evm` and a page
that walks two keys through it. Payer locks gwei naming a payee and a deadline; payee claims by
presenting a preimage the payer chose; after the deadline the payer refunds. A third role,
none: no arbiter. The page shows the contract's state live from the page's own validated chain
and offers exactly the action each key may take next.

**Why it matters.** Every transaction so far moved value between accounts one person controls.
This is the first exchange between parties who need not trust each other, and the primitive
agents will use to buy from each other.

**Build it with.** The IDE's flow (compile in a worker, `wallet.buildEvm` to deploy and call,
`wallet.evmCall` to read); the faucet page's layout for the explanation. Keep the contract under
40 lines and explain every line beside the code, as the faucet page does.

**Test.** `test/escrow-test.mjs`: two fresh keys on a throwaway EVM chain; deposit, lock, claim
with the right preimage, refuse the wrong one, refund after the deadline, and a second lock that
is refunded because the payee never claims. Use `evmCall` to show each refusal before it is sent.

**Report** the gas of each call and anything the wallet's EVM functions could not express.

---

## 2. Tip jar: a person, not an address

**Deliverable.** `examples/tipjar/`: a page for one did:nostr (given as `?did=` or `?npub=`)
showing their name and picture from their kind 0 profile, their address on a chosen sidestr
chain (the key is the same on every chain, so the page derives it from the pubkey), a QR of
that address, and a live list of who paid them, each payer resolved to a name where the payer's
key has a profile, with the amount in sats.

**Why it matters.** The wallet and the DAO page show hex where a person should be. This is the
names module in its smallest useful form, and it will show whether the wallet library needs a
`profiles` helper (it does not have one).

**Build it with.** The wallet's `history(script)` for payments to the address; a plain relay
subscription for kind 0 (the wallet's relay module, `subscribe`, takes a `kind`); the identity
derivation `5120<pubkey>`. Cache profiles in memory only.

**Test.** `test/tipjar-test.mjs`: against the live `sidestr:txbt4-siding`, resolve a known
pubkey's profile from the relays, derive its address, and list its incoming payments; a fresh
key with no profile shows its npub instead of a name.

**Report** which relays answered kind 0 queries and how long they took; that decides whether
profiles belong in the library.

---

## 3. Pay-per-request: an agent buys an answer

**Deliverable.** `examples/paywall/`: a tiny Node server (`server.mjs`) that serves one endpoint,
say the current block height of the chain it watches, only after a payment of N sats to its
address has been mined; and a client (`client.mjs`, built on the package's agent example) that
reads the price, pays, waits for the block, then asks again with the txid and gets the answer.
The server verifies the payment on its own validated copy of the chain, not by trusting the
client.

**Why it matters.** This is "an agent buys something" with no human anywhere. It also exercises
the package as a dependency in a project that is not ours.

**Build it with.** `npm install sidestr` in the example's own `package.json`; `openWallet` on
both sides; `wallet.mined(txid)` and `wallet.history(script)` on the server side to confirm the
payment pays the right script and amount. The invoice is a JSON body: chain, address, sats, a
nonce the payment must carry in an OP_RETURN so a payment cannot be reused (the wallet's `build`
takes a `carrier` output; a plain OP_RETURN is `6a` + push + bytes).

**Test.** `test/paywall-test.mjs`: spawn the server on a throwaway chain, run the client twice
(first pays, second reuses the txid and is refused), and a client that pays the wrong amount is
refused.

**Report** what the package lacked: a first-class `opReturnOutput`, a `waitForPayment`, anything
the two sides had to hand-roll.

---

## 4. Season ledger: a game's shares as an asset

**Deliverable.** `examples/season/`: the Tideholm season DAO's shares as a §12 asset on
`sidestr:capewars-s6`. A script `issue.mjs` that the season key runs once to issue `S7` with the
season's supply; a page that lists holders from the chain (the asset's balances by script) with
did:nostr names, the treasury as coins at the season script, and a `close.mjs` that computes the
pro-rata payout and builds (does not send) the one transaction that pays every holder.

**Why it matters.** The DAO page reads an API's word for who holds what; this makes the chain
the record, which is the whole argument of the chain version. It is also the first §12 asset
issued for a purpose rather than a demo.

**Build it with.** The market page's `market.mjs` for issuing and transferring assets (it wraps
the records and rules); the DAO page for the layout; `chains/capewars-s6/chain.json` for the
chain. The Tidegate's side, paying shares for gold, is out of scope: `issue.mjs` pays a sample
holder list from a JSON file so the page has something to show.

**Test.** `test/season-test.mjs`: on a throwaway chain with the assets rule, issue, distribute
to three keys, verify the page's holder list equals the chain's balances, and check `close.mjs`
pays exactly the treasury pro rata with rounding to the largest holder.

**Report** whether `market.mjs` should move into the wallet library, and anything §12 lacked
for a season (a close record, say).

---

## 5. Treasury: a federation from the user's side

**Deliverable.** `examples/treasury/`: a page for `sidestr:txbt4-fed` showing the federation's
chain document (signers, threshold), its peg address on the parent, the coins it holds, the
peg-outs so far with their parent transactions, and a "request a peg-out" form that burns from
the user's key and then follows the PSBT round to its parent payment: burn mined, round
proposed, signatures, paid, with links to the explorer and mempool.guide at each step.

**Why it matters.** Level 2 was proven from the producers' logs. Nobody has watched a
federation work from outside. This shows the round as a user sees it and tells us what the
producers should publish so a page can follow it (today: `pegouts.json` on the mirror, and the
round's events on the relays, kinds 23512 and 23513).

**Build it with.** The wallet's `build({ pegout: true })` and `pegoutsPaid()`; a relay
subscription to the round's kinds to show progress; the explorer for the burn. The parent
transaction is shown by txid with a link; the page does not read the parent itself.

**Test.** `test/treasury-test.mjs`: read-only against the live federation: the document's
threshold is 2 of 3, the peg address matches the challenge, the existing peg-out's parent txid
is listed. The burn path is exercised only if the user supplies a funded key; otherwise the
test asserts the form refuses an unfunded one before signing.

**Report** what the round's events lack for a page to follow them (the burn txid in the
proposal's tags, say) as an issue on the spec.
