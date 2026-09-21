// The escrow's logic with no DOM: make a secret, derive a lock's id, read a lock from the chain,
// say what state it is in and which single action the key in this browser may take, build the three
// transactions, and decode the contract's logs into a history. The page is a rendering of this file
// and the test drives the same functions, so anything either needs lives here.
//
// Units. The contract counts wei, this chain counts sats, and 1 gwei = 1 sat = 1e9 wei. Everything
// crossing this boundary is named: `sats` is what a person is shown, `wei` is what the contract
// holds, and the wallet's `value` is gwei, which is the same number as sats.
import { encodeMany, decodeMany } from '../../ide/abi.mjs';

// deployed on sidestr:txbt4-evm in block 520, from test/fixtures/Escrow.bin; ?escrow= overrides it
export const ESCROW = { 'sidestr:txbt4-evm': '0x42c6f8bd9c1f44ce52e509b16139023a5d2998d5' };
export const GWEI = 1000000000n;
export const SIG = { lock: 'lock(address,bytes32,uint64)', claim: 'claim(bytes32,bytes32)', refund: 'refund(bytes32)', locks: 'locks(bytes32)', idOf: 'idOf(address,address,bytes32,uint64)' };
export const EVENT = { Locked: 'Locked(bytes32,address,address,uint256,uint64,bytes32)', Claimed: 'Claimed(bytes32,bytes32)', Refunded: 'Refunded(bytes32)' };
// A claim published this close to the deadline may land in a block after it: the call would revert
// "late", the payer could refund, and the secret would be public for nothing. Two block intervals.
export const MARGIN = 120;
export const MIN_TERM = 600;      // the shortest deadline the page offers, for the same reason
// what a role must have in the EVM before it can act, with headroom; the chain charged 114,767,
// 41,622 and 40,482 gas for these in test/escrow-test.mjs, and the deployment 580,854
export const GAS = { lock: 125000n, claim: 50000n, refund: 45000n };

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h) => Uint8Array.from(String(h).replace(/^0x/i, '').match(/../g) ?? [], (x) => parseInt(x, 16));
const is32 = (h) => /^0x[0-9a-f]{64}$/i.test(String(h ?? ''));
const isAddr = (a) => /^0x[0-9a-f]{40}$/i.test(String(a ?? ''));
const low = (s) => String(s ?? '').toLowerCase();
const same = (a, b) => isAddr(a) && low(a) === low(b);

// --- secrets ---------------------------------------------------------------------------------------
// 32 random bytes the payer keeps until the payee has delivered. sha256, not keccak, so the same
// secret unlocks a Bitcoin-style HTLC on the sats side of a chain.
export const newSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function hashOf(secret) { if (!is32(secret)) throw new Error('a secret is 32 bytes of hex'); return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(secret)))); }
export async function opens(secret, lock) { try { return low(await hashOf(secret)) === low(lock?.hash); } catch { return false; } }
// the sha256 precompile is the design's one assumption about the chain's VM: check it before building on it
export async function sha256Live(w) { const r = await w.evmCall({ to: '0x0000000000000000000000000000000000000002', data: '0x' + '00'.repeat(32) }); return r.ok && low(r.returnValue) === low(await hashOf('0x' + '00'.repeat(32))); }

// --- reading the chain -----------------------------------------------------------------------------
// The id of a lock is keccak(payer, payee, hash, deadline) in the padded-word encoding, which is what
// the contract's idOf() computes. Keccak is the EVM's, so this needs the wallet but not a transaction.
export async function idOf(w, { payer, payee, hash, deadline }) {
  if (!isAddr(payer) || !isAddr(payee)) throw new Error('payer and payee are 0x addresses');
  if (!is32(hash)) throw new Error('the hash is 32 bytes of hex');
  return w.keccak(bytes(encodeMany(['address', 'address', 'bytes32', 'uint64'], [low(payer), low(payee), low(hash), BigInt(deadline)])));
}
// A lock as the chain holds it, or null: either it never existed or it has been claimed or refunded.
export async function readLock(w, escrow, id) {
  if (!is32(id)) throw new Error('a lock id is 32 bytes of hex');
  const r = await w.evmCall({ to: escrow, data: (await w.selector(SIG.locks)) + encodeMany(['bytes32'], [id]) });
  if (!r.ok) throw new Error(`locks(${id.slice(0, 10)}…) reverts: ${r.error}`);
  const [payer, deadline, payee, wei, hash] = decodeMany(['address', 'uint64', 'address', 'uint256', 'bytes32'], r.returnValue);
  if (payer === '0x' + '0'.repeat(40)) return null;
  return { id: low(id), payer, payee, wei, sats: wei / GWEI, deadline: Number(deadline), hash };
}
// Every Locked/Claimed/Refunded the page's own validated state has seen, newest first. With an
// address, only the locks that key is party to. The wallet hands back raw logs; this decodes them.
export async function history(w, escrow, { address = null } = {}) {
  const t0 = Object.fromEntries(await Promise.all(Object.entries(EVENT).map(async ([k, sig]) => [low(await w.keccak(sig)), k])));
  const out = [];
  for (const r of w.evmActivity(escrow)) {
    if (low(r.to) !== low(escrow) || r.status !== 1) continue;
    for (const [addr, topics, data] of r.logs ?? []) {
      if (low(hex(addr)) !== low(escrow)) continue;
      const kind = t0[low(hex(topics[0]))]; if (!kind) continue;
      const at = { height: r.height, gasUsed: r.gasUsed, txid: r.sidechainTxid, ethHash: r.transactionHash, from: r.from };
      const id = hex(topics[1]);
      if (kind === 'Locked') { const [wei, deadline, hash] = decodeMany(['uint256', 'uint64', 'bytes32'], hex(data)); out.push({ kind: 'locked', id, payer: '0x' + hex(topics[2]).slice(26), payee: '0x' + hex(topics[3]).slice(26), wei, sats: wei / GWEI, deadline: Number(deadline), hash, ...at }); }
      else if (kind === 'Claimed') out.push({ kind: 'claimed', id, preimage: hex(data).slice(0, 66), ...at });
      else out.push({ kind: 'refunded', id, ...at });
    }
  }
  const mine = (e) => !address || same(address, e.payer) || same(address, e.payee) || same(address, e.from);
  return out.filter(mine).sort((a, b) => b.height - a.height);
}
// What became of a lock that is no longer on the chain: its Claimed or Refunded record, or null.
export const settlementOf = (events, id) => events.find((e) => low(e.id) === low(id) && e.kind !== 'locked') ?? null;

// --- the state machine -----------------------------------------------------------------------------
// One lock, one viewer, one answer: which state it is in, which role the viewer plays, the single
// action that role may take next, and the sentence that says why when there is none. The page is a
// table of these; nothing in it decides policy of its own.
export function stateOf(lock, { now = Math.floor(Date.now() / 1000), me = null, settled = null, margin = MARGIN } = {}) {
  const role = !lock ? (isAddr(me) ? 'payer' : 'observer') : same(me, lock.payer) ? 'payer' : same(me, lock.payee) ? 'payee' : 'observer';
  const at = (state, action, why, secondsLeft = 0) => ({ state, role, action, why, secondsLeft });
  if (!lock) {
    if (settled?.kind === 'claimed') return at('claimed', null, `taken by the payee in block ${settled.height}; the preimage ${settled.preimage.slice(0, 12)}… is public now and is the receipt`);
    if (settled?.kind === 'refunded') return at('refunded', null, `never claimed; the payer took it back in block ${settled.height}`);
    return at('none', isAddr(me) ? { kind: 'lock', label: 'lock sats for a payee', needs: 'form' } : null, isAddr(me) ? 'nothing is locked at this id yet' : 'nothing is locked at this id, and there is no key in this browser');
  }
  const left = lock.deadline - now;
  if (left <= 0) return at('expired', role === 'payer' ? { kind: 'refund', label: `refund ${lock.sats.toLocaleString('en-US')} sats`, needs: null } : null,
    role === 'payer' ? 'the deadline has passed, so the claim window is shut and only you can move this' : 'the deadline has passed: the payee can no longer claim and the payer may take it back', left);
  if (left <= margin) return at('closing', null,
    role === 'payee' ? `${left} s to the deadline — too close to claim safely: a claim published now may land in a block after it, which would revert and make the secret public for nothing. Wait for the refund instead.`
      : `${left} s to the deadline; the payee should not claim this late, and you can refund once it passes`, left);
  return at('open', role === 'payee' ? { kind: 'claim', label: `claim ${lock.sats.toLocaleString('en-US')} sats`, needs: 'secret' } : null,
    role === 'payer' ? 'locked: you cannot take it back before the deadline and it can go nowhere but the payee. Hand over the secret when they have delivered.'
      : role === 'payee' ? 'the payer has locked this for you; the secret they chose releases it' : `locked until the deadline${lock.sats ? `: ${lock.sats.toLocaleString('en-US')} sats` : ''}`, left);
}

// --- building the three transactions ---------------------------------------------------------------
// Every one of these runs the call on the page's own state first, so a refusal ("late", "hash",
// "gone", "early") is a sentence on the page before anything is signed or spent.
export async function dryRun(w, { from, to, data, value = 0n }) {
  const r = await w.evmCall({ from, to, data, value });
  return { ok: r.ok, gasUsed: r.gasUsed, reason: r.ok ? null : /"(.*)"/.exec(r.error ?? '')?.[1] ?? r.error };
}
const refuse = (what, d) => { throw new Error(d.reason === 'gone' ? 'that lock is not on the chain: it was claimed, refunded, or never made' : `the chain would refuse this ${what}: ${d.reason}`); };

export async function buildLock(w, { key, escrow, payee, hash, deadline, sats, minTerm = MIN_TERM }) {
  const from = w.ethAddress(key); sats = BigInt(sats);
  if (!isAddr(payee)) throw new Error('the payee is a 0x address');
  if (sats <= 0n) throw new Error('lock a whole number of sats, more than none');
  const now = Math.floor(Date.now() / 1000); deadline = Number(deadline);
  if (deadline - now < minTerm) throw new Error(`the deadline is ${deadline - now} s away; give the payee at least ${Math.round(minTerm / 60)} minutes, and the block times room to move`);
  const data = (await w.selector(SIG.lock)) + encodeMany(['address', 'bytes32', 'uint64'], [payee, hash, deadline]);
  const d = await dryRun(w, { from, to: escrow, data, value: sats }); if (!d.ok) refuse('lock', d);
  const id = await idOf(w, { payer: from, payee, hash, deadline });
  const b = await w.buildEvm({ key, to: escrow, value: sats, data, note: `lock ${sats.toLocaleString('en-US')} sats for ${payee} until ${new Date(deadline * 1000).toLocaleString()}: only the preimage releases it, and only to them` });
  return { ...b, id, deadline, sats, payee: low(payee), hash: low(hash) };
}
export async function buildClaim(w, { key, escrow, lock, secret, now = Math.floor(Date.now() / 1000), margin = MARGIN }) {
  const from = w.ethAddress(key);
  if (!await opens(secret, lock)) throw new Error('that secret does not match this lock\'s hash, so the chain would refuse it; nothing has been sent');
  const left = lock.deadline - now;
  if (left <= margin) throw new Error(`the deadline is ${left} s away: a claim published now may land in a block after it. It would revert, the payer could refund, and your secret would be public for nothing.`);
  const data = (await w.selector(SIG.claim)) + encodeMany(['bytes32', 'bytes32'], [lock.id, secret]);
  const d = await dryRun(w, { from, to: escrow, data }); if (!d.ok) refuse('claim', d);
  const b = await w.buildEvm({ key, to: escrow, data, note: `claim ${lock.sats.toLocaleString('en-US')} sats: this publishes the secret, which is what pays ${lock.payee}` });
  return { ...b, id: lock.id, sats: lock.sats };
}
export async function buildRefund(w, { key, escrow, lock, now = Math.floor(Date.now() / 1000) }) {
  const from = w.ethAddress(key);
  if (lock.deadline > now) throw new Error(`the deadline is ${lock.deadline - now} s away; until it passes the payee may still claim and a refund cannot be sent`);
  const data = (await w.selector(SIG.refund)) + encodeMany(['bytes32'], [lock.id]);
  const d = await dryRun(w, { from, to: escrow, data }); if (!d.ok) refuse('refund', d);
  const b = await w.buildEvm({ key, to: escrow, data, note: `refund ${lock.sats.toLocaleString('en-US')} sats to ${lock.payer}: the payee never claimed` });
  return { ...b, id: lock.id, sats: lock.sats };
}
// What a role needs in the EVM before it can do anything, in gwei = sats: gas, plus the value for a lock.
export const needs = (kind, sats = 0n) => GAS[kind] + (kind === 'lock' ? BigInt(sats) : 0n);
