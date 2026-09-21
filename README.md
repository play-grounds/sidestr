# sidestr chains

A directory of sidestr sidechains at https://play-grounds.github.io/sidestr/. It reads the relays: every producer announces its tip as a kind 33333 event tagged `t` = sidestr (spec §11), the page lists the chains ranked by blocks in the last day and height, checks that each mirror's `chain.json` is signed by the announcing key, and links the explorer and wallet by chain id. Nothing is curated and no host is built in: mirrors come from the announcements.

`sidechains.mjs` is the logic with no DOM (`listChains`, `fetchTips`); `node test/list-test.mjs` runs it against the live relays with local checkouts of the engine and the spec library. Playground software.

## tally/

A market page for chains that name the `assets` and `pool` rules (spec §12), at
https://play-grounds.github.io/sidestr/tally/?chain=<chain id> (default `sidestr:tally`): swap
sats for an asset at the rule's exact quote, open a pool, add or remove liquidity, issue and
send assets. `tally/market.mjs` is the logic with no DOM, built on the sidestr wallet by pin;
every transaction is checked against the chain's own rules in the page before it is published.
`node tally/test/market-test.mjs --mirror URL --key-file F [--send]` runs the whole flow. It is
a playground: when the formats have settled, `market.mjs` moves into the wallet.

## mock/

https://play-grounds.github.io/sidestr/mock/ — a static mockup of a phone-first wallet, Phantom's
shape: one balance, plain-words activity with did:nostr names, a send flow that says what will happen
before the tap, receive, swap, a chain switcher from the directory, settings. Sample data only; nothing
is live. It exists to be looked at and argued about before the real wallet is redesigned.

## dao/

https://play-grounds.github.io/sidestr/dao/ — a mockup of the Tideholm season DAO
(tide-games.github.io/dao) on `sidestr:capewars-s6`: season shares as a §12 asset any explorer can
count, the treasury as coins the chain proves, the close as one pro-rata payout transaction,
proposals with a veto window instead of a vote one holder decides anyway, and leaving as a peg-out.
Treasury (mempool.guide, testnet4), holders and the book (the Tideholm API) are read live; proposals, buying and leaving are mocked and labelled. A "view as" toggle shows the other holder's side.

## ide/

https://play-grounds.github.io/sidestr/ide/?chain=<chain id> (default `sidestr:txbt4-evm`): a minimal
Solidity IDE for chains that run the evm rule. The compiler (the published soljson bundle) runs in a
web worker; a deploy is signed with your sidestr key, dry-run on the page's own validated state and
carried in a sidestr transaction over the relays; calls are read from that state, sends go the same
way as deploys. `ide/abi.mjs` is a small ABI coder (static types, string, bytes, one level of arrays),
`node ide/test/abi-test.mjs` checks it. No MetaMask, no RPC. Proven in Chrome on txbt4-evm: Token
deployed from the page, symbol read, a transfer sent, the balance read back.

## faucet/

https://play-grounds.github.io/sidestr/faucet/ — the first contract on `sidestr:txbt4-evm`, a
16-line faucet, explained line by line, with its live state (balance, drip, interval, drips so far)
read from the page's own validated copy of the chain, and a button that asks it for a drip with the
wallet's key. A baby-steps page for smart contracts: units (1 gwei = 1 sat), storage, events, require,
ordering, gas versus drip.

## examples/

Self-contained briefs for working examples in `examples/BRIEFS.md`: one page, one deliverable, one
test each, and a list of what the example found wrong in the libraries.

`examples/escrow/` is the first of them, the first exchange between two keys that need not trust each
other. `Escrow.sol` is a 34-line sha256-and-deadline lock, live on `sidestr:txbt4-evm` at
`0x42c6f8bd9c1f44ce52e509b16139023a5d2998d5` since block 520: the payer locks
sats naming a payee and a deadline, the payee takes them by showing the preimage the payer chose,
and after the deadline only the payer can take them back. No arbiter. `escrow.mjs` is the logic with
no DOM — secrets, the lock's id, the state machine that says which single action a key may take
next, and the three transactions, each dry-run on the page's own state so a refusal is a sentence
before anything is signed. `node examples/escrow/test/escrow-test.mjs` runs the whole thing against a
throwaway evm chain (39 checks: claim, the wrong preimage, the deadline race, the refund).
`examples/escrow/DESIGN.md` is the design and the brief for the page, which is next.
