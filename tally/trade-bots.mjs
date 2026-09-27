#!/usr/bin/env node
// Trades against a pool to give a chain a history: a random walk with a pull back toward the starting price, one
// swap per block, posted straight to a producer. Node only.
//   node tally/trade-bots.mjs --mirror http://127.0.0.1:3453 --url http://127.0.0.1:3453 --key-file ~/.sidestr/tally-faucet.key --trades 150 --max-sats 8000000 --pace-ms 2000
import fs from 'node:fs'; import { homedir } from 'node:os';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const H = homedir(); const local = { cdn: `${H}/bitcoin-desktop/schema`, lib: `${H}/remote/github.com/sidestr/spec/siding/lib`, explorer: `${H}/remote/github.com/sidestr/explorer/explorer.mjs`, wallet: `${H}/remote/github.com/sidestr/wallet/wallet.mjs`, loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')) };
const { openMarket } = await import('./market.mjs');
const m = await openMarket({ mirror: args.mirror ?? 'http://127.0.0.1:3453', ...(args.local === false ? {} : local) });
const key = fs.readFileSync(args['key-file'], 'utf8').trim(); const me = m.w.identity(key); const url = (args.url ?? args.mirror ?? 'http://127.0.0.1:3453').replace(/\/$/, '');
const pool = m.pools()[0]; if (!pool) throw new Error('no pool'); const unit = 10 ** pool.decimals; const mid = () => { const p = m.pool(pool.id); return p.x / p.y * unit; };
const N = Number(args.trades ?? 100), maxSats = Number(args['max-sats'] ?? 5e6), pace = Number(args['pace-ms'] ?? 2000), target = Number(args.target ?? mid());
const rnd = (a, b) => a + Math.random() * (b - a); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let momentum = 0; console.log(`${pool.ticker}: ${N} trades from ${me.address.slice(0, 14)}…, start mid ${mid().toFixed(2)}, target ${target.toFixed(2)}`);
for (let i = 0; i < N; i++) {
  await m.refresh(); const p = m.pool(pool.id); const px = mid(); const sats = m.w.balance(me.script).spendable; const held = m.balances(me.script).get(pool.asset) ?? 0;
  // a pull toward the target, a little momentum, and noise: the probability of a buy
  const pull = -2 * (px / target - 1), pBuy = Math.min(0.85, Math.max(0.15, 0.5 + pull + momentum * 0.15 + rnd(-0.1, 0.1)));
  let sell = Math.random() < pBuy ? 'sats' : 'asset'; if (sell === 'asset' && held < 5 * unit) sell = 'sats'; if (sell === 'sats' && sats < 2e5) sell = 'asset';
  const amount = sell === 'sats' ? Math.min(sats - 1e5, Math.round(rnd(2e5, maxSats) * (Math.random() < 0.15 ? 2 : 1))) : Math.max(unit, Math.round(held * rnd(0.05, 0.45)));
  if (amount <= 0) { console.log(`#${i + 1} nothing to ${sell === 'sats' ? 'buy with' : 'sell'}; stopping`); break; }
  let b; try { b = m.buildSwap({ key, pool: pool.id, sell, amount }); } catch (e) { console.log(`#${i + 1} build failed: ${e.message}`); continue; }
  const r = await fetch(`${url}/tx`, { method: 'POST', body: b.hex }); const j = await r.json().catch(() => ({})); if (!r.ok) { console.log(`#${i + 1} refused: ${j.error ?? r.status}`); await sleep(pace); continue; }
  let mined = null; for (let t = 0; t < 45 && !mined; t++) { await sleep(2000); mined = await m.mined(b.txid).catch(() => null); }
  momentum = sell === 'sats' ? Math.min(1, momentum + 0.3) : Math.max(-1, momentum - 0.3);
  console.log(`#${i + 1} ${sell === 'sats' ? 'buy ' : 'sell'} ${sell === 'sats' ? amount + ' sats' : m.fmt(pool.asset, amount) + ' ' + pool.ticker} → ${sell === 'sats' ? m.fmt(pool.asset, b.quote.out) + ' ' + pool.ticker : b.quote.out + ' sats'} @ ${(sell === 'sats' ? amount / b.quote.out * unit : b.quote.out / amount * unit).toFixed(2)} ${mined ? 'block ' + mined.height : 'NOT MINED'}; mid ${mid().toFixed(2)}`);
  if (!mined) break; await sleep(pace);
}
await m.refresh(); console.log(`done: mid ${mid().toFixed(2)}, ${m.w.balance(me.script).spendable} sats, ${m.fmt(pool.asset, m.balances(me.script).get(pool.asset) ?? 0)} ${pool.ticker} left`); process.exit(0);
