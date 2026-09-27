// Prediction markets (spec proposals/markets.md) on a chain naming the markets rule, built on the market module:
// the list with prices from the YES and NO pools, and the five transaction kinds — open, split, merge, redeem, resolve.
import { CARRIER_SATS } from './market.mjs';
export class Markets {
  constructor(m) { this.m = m; }
  get rule() { return this.m.rules.markets; } get height() { return this.m.tip?.height ?? 0; }
  ids(id) { return this.rule.yesNo(id); }
  poolOf(asset) { return this.m.pools().find((p) => p.asset === asset) ?? null; }
  // a market with its outcomes' pools and prices (sats per unit, which is the probability since a unit is worth at most a sat)
  market(id) { const r = this.rule.markets.get(id); if (!r) return null; const { yes, no } = this.ids(id); const yp = this.poolOf(yes), np = this.poolOf(no);
    const price = (p) => p ? p.x / p.y : null; const h = this.height; const closes = r.expiry + r.grace;
    return { ...r, yes, no, yesPool: yp, noPool: np, pYes: price(yp), pNo: price(np), blocksLeft: Math.max(0, r.expiry - h), refundable: r.status !== 'resolved' && h > closes, resolvable: r.status === 'open' && h <= closes }; }
  list() { return [...this.rule.markets.keys()].map((id) => this.market(id)).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.opened - a.opened); }
  // a key's outcome holdings in a market
  holdings(script, id) { const { yes, no } = this.ids(id); const b = this.m.balances(script); return { yes: b.get(yes) ?? 0, no: b.get(no) ?? 0 }; }
  buildOpen({ key, question, resolver, expiry, grace = 1000 }) {
    question = String(question).trim(); if (!question || new TextEncoder().encode(question).length > 200) throw new Error('a question is 1 to 200 bytes'); if (!/^[0-9a-f]{64}$/i.test(resolver)) throw new Error('the resolver is a 64-hex key'); expiry = Number(expiry); grace = Number(grace);
    if (!(expiry > this.height)) throw new Error('expiry is a future height'); if (!(grace >= 1)) throw new Error('grace is at least one block');
    const b = this.m.assemble({ key, outs: [{ value: 1, scriptPubKey: '51' }], records: [`market:self:0:${resolver.toLowerCase()}:${expiry}:${grace}`, `question:${question}`] }); return { ...b, kind: 'open' };
  }
  buildSplit({ key, id, sats }) { const r = this.rule.markets.get(id); if (!r) throw new Error('no such market'); sats = Number(sats); if (!(sats >= 1)) throw new Error('split at least one sat'); const me = this.m.w.identity(key); const { yes, no } = this.ids(id);
    const b = this.m.assemble({ key, outs: [{ value: r.C + sats, scriptPubKey: '51' }, { value: CARRIER_SATS, scriptPubKey: me.script, carry: new Map([[yes, sats], [no, sats]]) }], poolIn: r.coin, poolRecord: `split:${id}:0` }); return { ...b, kind: 'split', sats }; }
  buildMerge({ key, id, n }) { const r = this.rule.markets.get(id); if (!r) throw new Error('no such market'); n = Number(n); if (!(n >= 1)) throw new Error('merge at least one pair'); const { yes, no } = this.ids(id);
    const b = this.m.assemble({ key, outs: [{ value: r.C - n, scriptPubKey: '51' }], poolIn: r.coin, poolRecord: `merge:${id}:0`, needAssets: new Map([[yes, n], [no, n]]), destroy: new Map([[yes, n], [no, n]]) }); return { ...b, kind: 'merge', n }; }
  // after resolution: n of the winner for n sats; after expiry plus grace unresolved: a YES and b NO for floor((a + b) / 2) sats
  buildRedeem({ key, id, n = null, yes: a = 0, no: bb = 0 }) { const r = this.rule.markets.get(id); if (!r) throw new Error('no such market'); const { yes, no } = this.ids(id);
    if (r.status === 'resolved') { n = Number(n); if (!(n >= 1)) throw new Error('redeem at least one unit'); const w = r.winner === 'yes' ? yes : no;
      const b = this.m.assemble({ key, outs: [{ value: r.C - n, scriptPubKey: '51' }], poolIn: r.coin, poolRecord: `redeem:${id}:0`, needAssets: new Map([[w, n]]), destroy: new Map([[w, n]]) }); return { ...b, kind: 'redeem', n }; }
    a = Number(a); bb = Number(bb); const sats = Math.floor((a + bb) / 2); if (!(sats >= 1)) throw new Error('refund at least two units'); if (!(this.height > r.expiry + r.grace)) throw new Error(`the market is open until block ${r.expiry + r.grace}`);
    const need = new Map(); if (a) need.set(yes, a); if (bb) need.set(no, bb);
    const b = this.m.assemble({ key, outs: [{ value: r.C - sats, scriptPubKey: '51' }], poolIn: r.coin, poolRecord: `redeem:${id}:0`, needAssets: need, destroy: new Map(need) }); return { ...b, kind: 'refund', sats }; }
  buildResolve({ key, id, outcome }) { const r = this.rule.markets.get(id); if (!r) throw new Error('no such market'); if (!['yes', 'no'].includes(outcome)) throw new Error('the outcome is yes or no'); const me = this.m.w.identity(key); if (me.pub !== r.resolver) throw new Error('only the resolver answers');
    const b = this.m.assemble({ key, outs: [{ value: r.C, scriptPubKey: '51' }], poolIn: r.coin, poolRecord: `resolve:${id}:${outcome}` }); return { ...b, kind: 'resolve', outcome }; }
  // a pool for an outcome, seeded at a probability: `units` of the outcome against `units * p` sats
  buildOutcomePool({ key, id, side, units, p }) { const { yes, no } = this.ids(id); const asset = side === 'yes' ? yes : no; units = Number(units); const sats = Math.max(1, Math.round(units * Number(p))); return this.m.buildOpen({ key, asset, sats, units }); }
}
