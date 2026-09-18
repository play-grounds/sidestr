// The market against a live producer or mirror: quotes match the rule, every kind builds and
// passes the chain's rules in-process, and with --send each is published and seen mined.
//   node test/market-test.mjs --mirror URL --key-file F [--send] [--relay wss://a,wss://b]
import fs from 'node:fs'; import { homedir } from 'node:os';
import { openMarket } from '../market.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const H = homedir(); let okc = 0, bad = 0; const t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? okc++ : bad++; };
const local = { cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: `${H}/remote/github.com/sidestr/spec/siding/lib`, explorer: `${H}/remote/github.com/sidestr/explorer/explorer.mjs`, wallet: `${H}/remote/github.com/sidestr/wallet/wallet.mjs`, loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')) };
const relays = args.relay ? String(args.relay).split(',') : undefined;
const m = await openMarket({ mirror: args.mirror, chain: args.chain, relays, ...local, onProgress: (s) => console.log('  … ' + s) });
const key = fs.readFileSync(args['key-file'] ?? `${H}/.sidestr/${m.chain.name}.key`, 'utf8').trim(); const me = m.w.identity(key);
console.log(`chain ${m.chain.id} at ${m.tip.height}: ${m.assets().length} asset(s), ${m.pools().length} pool(s); ${me.address} holds ${m.w.balance(me.script).spendable} sats`);
const send = async (b, what) => { if (!args.send) return null; const r = await m.publish(b.hex, relays); if (!r.accepted) throw new Error(`${what}: no relay accepted`); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 3000)); const x = await m.mined(b.txid); if (x) return x; } throw new Error(`${what}: not mined in 2 minutes`); };
// issue
const iss = m.buildIssue({ key, ticker: 'SHELL', decimals: 2, supply: 100000000 });
t('issue builds, passes the rules in-process, records issue: + tally:self', iss.records.some((r) => r === 'issue:SHELL:2') && iss.records.some((r) => r.startsWith('tally:self:0=100000000')) && m.check(iss.tx, iss.txid).ok);
let SHELL = iss.txid;
if (args.send) { const x = await send(iss, 'issue'); t(`issue mined in block ${x.height}`, !!x); t('the asset is listed and I hold the supply', m.asset(SHELL)?.ticker === 'SHELL' && m.balances(me.script).get(SHELL) === 100000000); }
else { const a = m.assets().find((x) => x.ticker === 'SHELL'); if (a) SHELL = a.id; }
if (!m.balances(me.script).get(SHELL)) { console.log('  (no SHELL held; run with --send to issue; the rest needs it)'); console.log(`\n${okc} passed, ${bad} failed`); process.exit(bad ? 1 : 0); }
// open
const open = m.buildOpen({ key, asset: SHELL, sats: 10000000, units: 50000000 });
t(`open builds: 0.1 tBTC + 500,000.00 SHELL, ${open.shares} shares (isqrt)`, open.shares === 22360679 && m.check(open.tx, open.txid).ok && open.records.includes('pool:self:0'));
if (args.send) { const x = await send(open, 'open'); t(`pool opened in block ${x.height}`, !!x && m.pool(open.txid)?.x === 10000000); }
const P = m.pools()[0]; if (!P) { console.log('  (no pool; --send to open one)'); console.log(`\n${okc} passed, ${bad} failed`); process.exit(bad ? 1 : 0); }
// quotes at the boundary
const q = m.quoteSwap({ pool: P.id, sell: 'sats', amount: 100000 });
t(`quote: 100,000 sats -> ${m.fmt(SHELL, q.out)} SHELL, impact ${(q.impact * 100).toFixed(2)}%, exactly the rule's edge`, m.invariant(BigInt(P.x), BigInt(P.y), BigInt(P.x + 100000), BigInt(P.y - q.out)) && !m.invariant(BigInt(P.x), BigInt(P.y), BigInt(P.x + 100000), BigInt(P.y - q.out - 1)));
const q2 = m.quoteSwap({ pool: P.id, sell: 'asset', amount: 100000 });
t(`quote the other way: 1,000.00 SHELL -> ${q2.out} sats`, q2.out > 0 && m.invariant(BigInt(P.x), BigInt(P.y), BigInt(P.x - q2.out), BigInt(P.y + 100000)));
const sw = m.buildSwap({ key, pool: P.id, sell: 'sats', amount: 100000 });
t('swap builds and passes the rules (pool input witness empty)', m.check(sw.tx, sw.txid).kind === 'swap' && sw.tx.witness[0].length === 0);
if (args.send) { const x = await send(sw, 'swap'); t(`swap mined in block ${x.height}; pool moved`, !!x && m.pool(P.id).x === P.x + 100000); }
const P2 = m.pool(P.id);
const sw2 = m.buildSwap({ key, pool: P2.id, sell: 'asset', amount: 200000 });
t('swap asset -> sats builds', m.check(sw2.tx, sw2.txid).kind === 'swap');
if (args.send) { const x = await send(sw2, 'swap back'); t(`swap back mined in block ${x.height}`, !!x); }
const P3 = m.pool(P.id); const ad = m.buildAdd({ key, pool: P3.id, sats: 1000000 });
t(`add builds: ${ad.quote.sats} sats + ${m.fmt(SHELL, ad.quote.asset)} SHELL mints ${ad.quote.shares} shares`, m.check(ad.tx, ad.txid).kind === 'add');
if (args.send) { const x = await send(ad, 'add'); t(`add mined in block ${x.height}; I hold the new shares`, !!x && (m.balances(me.script).get(P.id) ?? 0) >= P3.shares + ad.quote.shares - m.pool(P.id).shares + ad.quote.shares - ad.quote.shares); }
const P4 = m.pool(P.id); const held = m.balances(me.script).get(P.id) ?? 0;
if (held) { const rm = m.buildRemove({ key, pool: P4.id, shares: Math.floor(held / 10) }); t(`remove builds: ${Math.floor(held / 10)} shares -> ${rm.quote.sats} sats + ${m.fmt(SHELL, rm.quote.asset)} SHELL`, m.check(rm.tx, rm.txid).kind === 'remove');
  if (args.send) { const x = await send(rm, 'remove'); t(`remove mined in block ${x.height}; shares fell`, !!x && m.pool(P.id).shares === P4.shares - Math.floor(held / 10)); } }
const xf = m.buildTransfer({ key, asset: SHELL, to: me.address, amount: 12345 });
t('an asset transfer builds and passes', m.check(xf.tx, xf.txid).kind === 'transfer');
console.log(`\n${okc} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
