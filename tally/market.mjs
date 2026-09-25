// The market's logic, no DOM: assets, pools, quotes and the three transaction kinds of SPEC 12,
// built on the sidestr wallet (keys, coins, signing, relays) and checked against the chain's own
// rules in this page before anything is published. Runs in a browser or in Node (the test).
// Every dependency is pinned by full commit; chains are named by id, never by host.
export const DEFAULTS = {
  cdn: 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27',
  lib: 'https://cdn.jsdelivr.net/gh/sidestr/spec@5223af24b6260d6acf922f3c8c3da69d5c335670/siding/lib',
  explorer: 'https://cdn.jsdelivr.net/gh/sidestr/explorer@799a74bf67f1578531428ef8ffb9668e1170245b/explorer.mjs',
  wallet: 'https://cdn.jsdelivr.net/gh/sidestr/wallet@a80791976b42cd457182fc28b177488f85d2805d/wallet.mjs',
  relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'],
};
const B = (n) => BigInt(n), N = (b) => Number(b);
export const FEE_PER_MILLE = 3n;      // the pool rule's fee on what comes in
export const CARRIER_SATS = 1000;     // sats an asset output rides on (SPEC 12.1: at least one)

export async function openMarket({ chain, mirror, relays = DEFAULTS.relays, cdn = DEFAULTS.cdn, lib = DEFAULTS.lib, explorer = DEFAULTS.explorer, wallet = DEFAULTS.wallet, loadJson, onProgress = () => {} } = {}) {
  const [{ openWallet }, records] = await Promise.all([import(wallet), import(`${lib}/records.mjs`)]);
  const w = await openWallet({ chain, mirror, relays, cdn, lib, explorer, loadJson, onProgress });
  if (!w.ex.rules?.pool || !w.ex.rules?.assets) throw new Error(`${w.chain.id} does not name the assets and pool rules; this page is for chains that do`);
  return new Market(w, records);
}

export class Market {
  constructor(w, records) { this.w = w; this.R = records; }
  get chain() { return this.w.chain; } get tip() { return this.w.tip; } get ex() { return this.w.ex; } get rules() { return this.w.ex.rules; }
  refresh() { return this.w.refresh(); }
  // --- reading --------------------------------------------------------------------------
  assets() {
    const out = [];
    for (const [id, a] of this.rules.assets.issued) out.push({ id, ticker: a.ticker, decimals: a.decimals, height: a.height, share: false });
    for (const [id, p] of this.rules.pool.pools) { const a = this.rules.assets.issued.get(p.asset); out.push({ id, ticker: `LP·${a?.ticker ?? p.asset.slice(0, 4)}`, decimals: 0, height: null, share: true, pool: id }); }
    return out;
  }
  asset(id) { return this.assets().find((a) => a.id === id) ?? null; }
  fmt(id, amount) { const a = this.asset(id); const d = a?.decimals ?? 0; if (!d) return N(amount).toLocaleString('en-US'); const s = String(amount).padStart(d + 1, '0'); return `${Number(s.slice(0, -d)).toLocaleString('en-US')}.${s.slice(-d)}`; }
  parseAmount(id, text) { const a = this.asset(id); const d = a?.decimals ?? 0; const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(String(text).trim()); if (!m) throw new Error('an amount is a number'); const frac = (m[2] ?? '').padEnd(d, '0'); if (frac.length > d) throw new Error(`${a?.ticker ?? 'this asset'} has ${d} decimals`); return Number(m[1] + frac) || 0; }
  // what a script holds, per asset, over its unspent coins
  balances(script) { const out = new Map(); for (const c of this.w.coins(script)) { const m = this.rules.assets.of(c.txid, c.vout); if (m) for (const [a, n] of m) out.set(a, (out.get(a) ?? 0) + n); } return out; }
  assetCoins(script, asset) { return this.w.coins(script).map((c) => ({ ...c, carried: this.rules.assets.of(c.txid, c.vout) })).filter((c) => c.carried?.has(asset) && c.mature); }
  pools() { return [...this.rules.pool.pools.entries()].map(([id, p]) => { const a = this.rules.assets.issued.get(p.asset); return { id, asset: p.asset, ticker: a?.ticker ?? p.asset.slice(0, 6), decimals: a?.decimals ?? 0, x: p.x, y: p.y, shares: p.shares, outpoint: p.outpoint, price: p.x / p.y }; }); }
  pool(id) { return this.pools().find((p) => p.id === id) ?? null; }
  // a pool's history from the rule's journal: one event per block that changed it — { height, time, kind, x, y, x2, y2, dx, dy, price, volume }
  // price is sats per whole unit of the asset (10^decimals base units); volume is sats that moved; a swap's side is what the trader sold
  history(id) {
    const j = this.rules.pool.journal; if (!j) return []; const p = this.pool(id); if (!p) return []; const unit = 10 ** p.decimals;
    const heights = [...j.keys()].filter((h) => (j.get(h) ?? []).some((e) => e.id === id)).sort((a, b) => a - b); const out = [];
    for (let i = 0; i < heights.length; i++) { const h = heights[i]; const before = j.get(h).find((e) => e.id === id).before; const next = heights[i + 1]; const after = next != null ? j.get(next).find((e) => e.id === id).before : this.rules.pool.pools.get(id);
      if (!after) continue; const x = before?.x ?? 0, y = before?.y ?? 0, x2 = after.x, y2 = after.y; const dx = x2 - x, dy = y2 - y;
      const kind = !before ? 'open' : after.shares === before.shares ? 'swap' : after.shares > before.shares ? 'add' : 'remove';
      const price = kind === 'swap' && dy !== 0 ? Math.abs(dx / dy) * unit : x2 / y2 * unit;
      out.push({ height: h, time: this.ex.blocks[h]?.time ?? null, kind, side: kind === 'swap' ? (dx > 0 ? 'buy' : 'sell') : null, x, y, x2, y2, dx, dy, price, volume: Math.abs(dx), mid: x2 / y2 * unit }); }
    return out;
  }
  // the pool's depth: sats needed to move the mid price by each fraction, both ways, from the constant product
  depth(id, steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2]) { const p = this.pool(id); if (!p) return []; return steps.map((f) => ({ move: f, buySats: Math.round(p.x * (Math.sqrt(1 + f) - 1)), sellSats: Math.round(p.x * (1 - 1 / Math.sqrt(1 + f))) })); } // x' = x·√(1+f) moves the price by (1+f)
  // --- quotes (the rule's arithmetic, in integers, rounded to the pool) ------------------
  invariant(x, y, x2, y2) { const dx = x2 > x ? x2 - x : 0n, dy = y2 > y ? y2 - y : 0n; return (1000n * x2 - FEE_PER_MILLE * dx) * (1000n * y2 - FEE_PER_MILLE * dy) >= 1000000n * x * y; }
  // sell sats for the asset, or the asset for sats; returns the exact out the rule allows
  quoteSwap({ pool, sell, amount }) {
    const p = this.pool(pool); if (!p) throw new Error('no such pool'); amount = Number(amount); if (!(amount >= 1)) throw new Error('an amount is at least 1');
    const x = B(p.x), y = B(p.y), din = B(amount); const k = 1000n - FEE_PER_MILLE;
    let out = sell === 'sats' ? (y * din * k) / (x * 1000n + din * k) : (x * din * k) / (y * 1000n + din * k);
    const ok = (o) => sell === 'sats' ? this.invariant(x, y, x + din, y - o) : this.invariant(x, y, x - o, y + din);
    while (out > 0n && !ok(out)) out--; while (ok(out + 1n) && (sell === 'sats' ? y - out - 1n >= 1n : x - out - 1n >= 1n)) out++;
    if (sell === 'sats' ? y - out < 1n : x - out < 1n) throw new Error('that would empty the pool');
    const mid = sell === 'sats' ? Number(din) * p.y / p.x : Number(din) * p.x / p.y; const impact = mid > 0 ? 1 - N(out) / mid : 0;
    return { out: N(out), impact, fee: N(din * FEE_PER_MILLE / 1000n), price: sell === 'sats' ? Number(din) / N(out) : N(out) / Number(din), x2: sell === 'sats' ? p.x + amount : p.x - N(out), y2: sell === 'sats' ? p.y - N(out) : p.y + amount };
  }
  quoteAdd({ pool, sats }) { const p = this.pool(pool); sats = Number(sats); const asset = N((B(sats) * B(p.y) + B(p.x) - 1n) / B(p.x)); const S = B(p.shares); const shares = N([B(sats) * S / B(p.x), B(asset) * S / B(p.y)].reduce((a, b) => a < b ? a : b)); return { sats, asset, shares, share: shares / (p.shares + shares) }; }
  quoteRemove({ pool, shares }) { const p = this.pool(pool); shares = Number(shares); const d = B(shares), S = B(p.shares); const sats = N(B(p.x) * d / S), asset = N(B(p.y) * d / S); if (p.x - sats < 1 || p.y - asset < 1) throw new Error('a pool is never emptied'); return { sats, asset, shares }; }
  // --- building -------------------------------------------------------------------------
  // one assembler for every kind: pays `outs` (each may carry assets), spends the named pool coin,
  // gathers my sats and asset coins, returns asset change to me, adds records, sizes the fee, signs
  #assemble({ key, outs, poolIn = null, poolRecord = null, needAssets = new Map(), records = [], burn = new Set(), keepBurnRemainder = null }) {
    const w = this.w, k = w.ex.k, me = w.identity(key), rate = w.minFeeRate;
    const inputs = []; const used = new Set();
    const take = (c, prevout) => { if (used.has(c.outpoint)) return; used.add(c.outpoint); inputs.push({ coin: c, prevout, mine: prevout.scriptPubKey === me.script }); };
    if (poolIn) { const u = w.ex.utxo.get(poolIn); if (!u) throw new Error('the pool coin is not in the UTXO set (mirror behind?)'); take({ outpoint: poolIn, txid: poolIn.split(':')[0], vout: Number(poolIn.split(':')[1]), value: u.output.value }, { value: u.output.value, scriptPubKey: u.output.scriptPubKey }); }
    for (const [asset, need] of needAssets) { let got = 0; for (const c of this.assetCoins(me.script, asset).sort((a, b) => b.carried.get(asset) - a.carried.get(asset))) { if (got >= need) break; take(c, { value: c.value, scriptPubKey: me.script }); got += c.carried.get(asset); } if (got < need) throw new Error(`not enough ${this.asset(asset)?.ticker ?? asset.slice(0, 6)}: ${this.fmt(asset, got)} held, ${this.fmt(asset, need)} needed`); }
    const outValue = outs.reduce((s, o) => s + o.value, 0);
    const carriedIn = () => { const m = new Map(); for (const i of inputs) { const c = this.rules.assets.of(i.coin.txid, i.coin.vout); if (c) for (const [a, n] of c) m.set(a, (m.get(a) ?? 0) + n); } return m; };
    const assigned = () => { const m = new Map(); for (const o of outs) for (const [a, n] of o.carry ?? []) m.set(a, (m.get(a) ?? 0) + n); return m; };
    // asset change: whatever the inputs carry beyond what the outs assign comes back to me on one output
    const layout = (fee) => {
      const list = outs.map((o) => ({ value: o.value, scriptPubKey: o.scriptPubKey, carry: new Map(o.carry ?? []) }));
      const inC = carriedIn(), asg = assigned(); const change = new Map(); for (const [a, n] of inC) { const back = n - (asg.get(a) ?? 0); if (back > 0 && !burn.has(a)) change.set(a, back); else if (back > 0 && keepBurnRemainder?.asset === a && back - keepBurnRemainder.keep > 0) change.set(a, back - keepBurnRemainder.keep); }
      const inSats = inputs.reduce((s, i) => s + i.coin.value, 0); let satsBack = inSats - outValue - fee - (change.size ? CARRIER_SATS : 0);
      if (change.size) list.push({ value: CARRIER_SATS, scriptPubKey: me.script, carry: change });
      if (satsBack < 0) return null; if (satsBack > 0) list.push({ value: satsBack, scriptPubKey: me.script, carry: new Map() });
      // records: the pool's, then one tally per asset (self for issuance / opening)
      const recs = [...records]; if (poolRecord) recs.push(poolRecord);
      const per = new Map(); list.forEach((o, vout) => { for (const [a, n] of o.carry) { if (!per.has(a)) per.set(a, []); per.get(a).push(`${vout}=${n}`); } });
      for (const [a, parts] of per) recs.push(`tally:${a}:${parts.join(',')}`);
      return { outputs: [...list.map((o) => ({ value: o.value, scriptPubKey: o.scriptPubKey })), ...recs.map((r) => ({ value: 0, scriptPubKey: this.R.recordScript(r) }))], records: recs };
    };
    // sats: gather mature coins until the layout fits with an estimated fee, then size the fee exactly
    const estimate = 400 * rate; const satsCoins = w.coins(me.script).filter((c) => c.mature).sort((a, b) => b.value - a.value);
    const fits = (fee) => layout(fee) !== null;
    for (const c of satsCoins) { if (fits(estimate)) break; take(c, { value: c.value, scriptPubKey: me.script }); }
    if (!fits(0)) throw new Error('not enough mature sats');
    const mk = (fee) => { const l = layout(fee); if (!l) return null; return { tx: { version: 2, inputs: inputs.map((i) => ({ prevout: { txid: i.coin.txid, vout: i.coin.vout }, scriptSig: '', sequence: 0xfffffffd })), outputs: l.outputs, lockTime: 0, witness: [] }, records: l.records }; };
    let fee = 0, built = mk(0); const sized = { ...built.tx, witness: inputs.map((i) => i.mine ? ['00'.repeat(65)] : []) }; fee = Math.ceil(Math.ceil(k.codec.txWeight(sized) / 4) * rate); built = mk(fee);
    if (!built) { for (const c of satsCoins) { if (mk(fee)) break; take(c, { value: c.value, scriptPubKey: me.script }); } built = mk(fee); if (!built) throw new Error('not enough mature sats for the fee'); }
    const tx = built.tx, prevouts = inputs.map((i) => i.prevout), ht = 0x01 | w.SIGHASH_UNIFIED, h = w.ex.hash;
    tx.witness = tx.inputs.map((_, i) => { if (!inputs[i].mine) return []; let m = k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = h.hexToBytes(m); return [h.bytesToHex(w.signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]; });
    const txid = k.codec.txid(tx); const check = this.check(tx, txid); if (!check.ok) throw new Error(`the rules refuse this transaction: ${check.rule}: ${check.error}`);
    return { tx, hex: k.codec.encodeHex('Transaction', tx), txid, fee, vsize: Math.ceil(k.codec.txWeight(tx) / 4), records: built.records, prevouts, inputs: inputs.length };
  }
  // the chain's own rules, on this transaction, in this page, before it leaves
  check(tx, txid) { const r = this.rules; const view = new r.assets.CarryView(r.assets.carried); const a = r.assets.check(tx, txid, view); if (!a.ok) return { ok: false, rule: 'assets', error: a.error }; const p = r.pool.check(tx, txid, view); if (!p.ok) return { ok: false, rule: 'pool', error: p.error }; return { ok: true, kind: p.kind ?? (p.effect ? 'open' : a.issue ? 'issue' : 'transfer'), effect: p.effect ?? null }; }
  buildIssue({ key, ticker, decimals = 0, supply }) {
    ticker = String(ticker).toUpperCase().trim(); if (!/^[A-Z0-9]{1,8}$/.test(ticker)) throw new Error('a ticker is 1 to 8 letters or digits'); decimals = Number(decimals); if (!(decimals >= 0 && decimals <= 8)) throw new Error('decimals 0 to 8'); supply = Number(supply); if (!(supply >= 1 && supply <= 2 ** 53 - 1)) throw new Error('supply is a whole number of units');
    const me = this.w.identity(key); const b = this.#assemble({ key, outs: [{ value: CARRIER_SATS, scriptPubKey: me.script, carry: new Map([['self', supply]]) }], records: [`issue:${ticker}:${decimals}`] });
    return { ...b, kind: 'issue', ticker, decimals, supply };
  }
  buildTransfer({ key, asset, to, amount }) { const dest = this.w.resolveTo(to); amount = Number(amount); const b = this.#assemble({ key, outs: [{ value: CARRIER_SATS, scriptPubKey: dest.script, carry: new Map([[asset, amount]]) }], needAssets: new Map([[asset, amount]]) }); return { ...b, kind: 'transfer', asset, amount, note: dest.note }; }
  buildOpen({ key, asset, sats, units }) {
    sats = Number(sats); units = Number(units); if (!(sats >= 1 && units >= 1)) throw new Error('a pool opens with sats and units'); const shares = N(this.R.isqrt(B(sats) * B(units))); if (shares < 1) throw new Error('too small to open');
    const me = this.w.identity(key);
    const b = this.#assemble({ key, outs: [{ value: sats, scriptPubKey: '51', carry: new Map([[asset, units]]) }, { value: CARRIER_SATS, scriptPubKey: me.script, carry: new Map([['self', shares]]) }], poolRecord: 'pool:self:0', needAssets: new Map([[asset, units]]) });
    return { ...b, kind: 'open', asset, sats, units, shares };
  }
  buildSwap({ key, pool, sell, amount }) {
    const p = this.pool(pool), q = this.quoteSwap({ pool, sell, amount }); amount = Number(amount); const me = this.w.identity(key);
    const outs = sell === 'sats'
      ? [{ value: p.x + amount, scriptPubKey: '51', carry: new Map([[p.asset, p.y - q.out]]) }, { value: CARRIER_SATS, scriptPubKey: me.script, carry: new Map([[p.asset, q.out]]) }]
      : [{ value: p.x - q.out, scriptPubKey: '51', carry: new Map([[p.asset, p.y + amount]]) }, { value: q.out, scriptPubKey: me.script, carry: new Map() }];
    const b = this.#assemble({ key, outs, poolIn: p.outpoint, poolRecord: `pool:${p.id}:0`, needAssets: sell === 'sats' ? new Map() : new Map([[p.asset, amount]]) });
    return { ...b, kind: 'swap', pool: p.id, sell, amount, quote: q };
  }
  buildAdd({ key, pool, sats }) {
    const p = this.pool(pool), q = this.quoteAdd({ pool, sats }); const me = this.w.identity(key);
    const b = this.#assemble({ key, outs: [{ value: p.x + q.sats, scriptPubKey: '51', carry: new Map([[p.asset, p.y + q.asset]]) }, { value: CARRIER_SATS, scriptPubKey: me.script, carry: new Map([[p.id, q.shares]]) }], poolIn: p.outpoint, poolRecord: `pool:${p.id}:0`, needAssets: new Map([[p.asset, q.asset]]) });
    return { ...b, kind: 'add', pool: p.id, quote: q };
  }
  buildRemove({ key, pool, shares }) {
    const p = this.pool(pool), q = this.quoteRemove({ pool, shares }); const me = this.w.identity(key);
    // the shares come in and are not tallied onward: destroyed, which is what a remove is; extra shares on the same coin come back
    const held = this.assetCoins(me.script, p.id).reduce((s, c) => s + c.carried.get(p.id), 0); shares = Number(shares); if (shares > held) throw new Error(`you hold ${held} shares`);
    const b = this.#assemble({ key, outs: [{ value: p.x - q.sats, scriptPubKey: '51', carry: new Map([[p.asset, p.y - q.asset]]) }, { value: CARRIER_SATS + q.sats, scriptPubKey: me.script, carry: new Map([[p.asset, q.asset]]) }], poolIn: p.outpoint, poolRecord: `pool:${p.id}:0`, needAssets: new Map([[p.id, shares]]), burn: new Set([p.id]), keepBurnRemainder: { asset: p.id, keep: shares } });
    return { ...b, kind: 'remove', pool: p.id, quote: q };
  }
  publish(hex, relays) { return this.w.publish(hex, relays); }
  mined(txid) { return this.w.mined(txid); }
}
