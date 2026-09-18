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
