# sidestr chains

A directory of sidestr sidechains at https://play-grounds.github.io/sidestr/. It reads the relays: every producer announces its tip as a kind 33333 event tagged `t` = sidestr (spec §11), the page lists the chains ranked by blocks in the last day and height, checks that each mirror's `chain.json` is signed by the announcing key, and links the explorer and wallet by chain id. Nothing is curated and no host is built in: mirrors come from the announcements.

`sidechains.mjs` is the logic with no DOM (`listChains`, `fetchTips`); `node test/list-test.mjs` runs it against the live relays with local checkouts of the engine and the spec library. Playground software.
