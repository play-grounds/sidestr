// Pay-per-request with no I/O: the invoice a server issues, the payment a client builds for it, and
// the check the server makes on its own validated copy of the chain before it answers. server.mjs
// and client.mjs are thin wrappers around this file and the test drives it directly.
//
// The invoice binds a payment to one request: the payment must pay the server's address at least
// the price, and must carry an OP_RETURN holding "paywall:" and the invoice's 16-byte nonce. A
// payment made for one invoice cannot redeem another, and a redeemed invoice cannot be redeemed
// twice. There is no signature from the server on the invoice and none is needed: the client checks
// the address against the one it was told to pay, and the server checks everything else on the chain.
import { randomBytes } from 'node:crypto';

const TAG = new TextEncoder().encode('paywall:');
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const is = (re) => (s) => re.test(String(s ?? ''));
const isNonce = is(/^[0-9a-f]{32}$/), isTxid = is(/^[0-9a-f]{64}$/);

// OP_RETURN <"paywall:" ‖ nonce>: one push of 24 bytes, well inside a standard carrier
export function memoScript(nonce) {
  if (!isNonce(nonce)) throw new Error('a nonce is 16 bytes of lowercase hex');
  const body = hex(TAG) + nonce;
  return '6a' + (body.length / 2).toString(16).padStart(2, '0') + body;
}

// --- the server's side -----------------------------------------------------------------------------
export function makeInvoice(w, { address, sats, ttl = 600, now = Math.floor(Date.now() / 1000) }) {
  if (!Number.isInteger(sats) || sats <= 0) throw new Error('a price is a whole number of sats');
  const nonce = randomBytes(16).toString('hex');
  return { chain: w.chain.id, address, sats, nonce, memo: memoScript(nonce), expires: now + ttl };
}

// Did this txid pay this invoice, as this server's own copy of the chain sees it? Everything is read
// from the validated state: the client's word is only the txid. Returns { ok, code, why, height }.
// A mined transaction is only reachable through the explorer's index (w.ex.txs): the wallet's public
// history() skips OP_RETURN outputs, so it cannot show the memo, and there is no wallet.tx(txid).
export async function checkPayment(w, { txid, invoice, script }) {
  const no = (code, why) => ({ ok: false, code, why });
  if (!isTxid(txid)) return no('bad', 'a txid is 32 bytes of lowercase hex');
  const m = await w.mined(txid);                                      // refreshes to the tip first
  if (!m) return no('unmined', `${txid.slice(0, 12)}… is not in a block this server has validated yet; ask again after the next one`);
  const t = w.ex.txs.get(txid);
  if (!t || t.coinbase) return no('bad', 'that transaction is not a payment');
  const paid = t.tx.outputs.filter((o) => o.scriptPubKey === script).reduce((s, o) => s + o.value, 0);
  if (!t.tx.outputs.some((o) => o.scriptPubKey === invoice.memo)) return no('memo', `that transaction does not carry this invoice's nonce, so it was not made for it${paid ? ` (it does pay ${paid.toLocaleString('en-US')} sats here, for something else)` : ''}`);
  if (paid < invoice.sats) return no('short', `that transaction pays ${paid.toLocaleString('en-US')} sats to this server; the invoice is for ${invoice.sats.toLocaleString('en-US')}`);
  return { ok: true, code: 'paid', why: `paid ${paid.toLocaleString('en-US')} sats in block ${m.height}`, height: m.height, paid };
}

// --- the client's side -----------------------------------------------------------------------------
// An invoice is data from a stranger: check it before paying it. The memo must be exactly the one
// the nonce implies (so the client knows it is paying a zero-value OP_RETURN and nothing else), the
// chain must be the one the client opened, the price must be under the client's own ceiling.
export function checkInvoice(w, invoice, { maxSats, address = null, now = Math.floor(Date.now() / 1000) }) {
  const i = invoice ?? {};
  if (i.chain !== w.chain.id) throw new Error(`the invoice is for ${i.chain}; this client opened ${w.chain.id}`);
  if (!Number.isInteger(i.sats) || i.sats <= 0) throw new Error('the invoice has no sensible price');
  if (i.sats > maxSats) throw new Error(`the invoice asks ${i.sats.toLocaleString('en-US')} sats; this client pays at most ${maxSats.toLocaleString('en-US')}`);
  if (address && i.address !== address) throw new Error(`the invoice pays ${i.address}, not the address this client was told to expect`);
  if (i.memo !== memoScript(i.nonce)) throw new Error('the invoice\'s memo is not the OP_RETURN its nonce implies; refusing to pay an arbitrary script');
  if (i.expires <= now + 30) throw new Error('the invoice has expired, or will before a block can carry the payment');
  w.resolveTo(i.address);                                             // throws on an address this chain cannot pay
  return i;
}

// The wallet's build() has one destination: an amount to an address, or a zero-value carrier, not
// both. So: build the payment, lay out a new transaction with the memo after the payment, pay for
// the memo's bytes out of the change at the chain's own fee rate, and sign that. Six wallet internals
// (ex.k, ex.hash, signer, txsign, vsize, minFeeRate) to add one output; that is the gap reported.
//
// It must be a NEW transaction object. The schema's interpreter caches each transaction's sighash
// midstates — the hash of its outputs among them — in a WeakMap keyed by the object. build() has
// already signed b.tx, so changing b.tx.outputs and signing again commits to the outputs build()
// saw, not these; and w.verify(), reading the same cache, agrees. The producer decodes the bytes
// fresh and refuses the signature. So: a fresh object to sign, and a fresh decode to verify.
export function buildPayment(w, { key, invoice, sats = invoice.sats }) {
  const b = w.build({ key, to: invoice.address, amount: sats });
  const me = w.identity(key).script, k = w.ex.k;
  const sum = b.prevouts.reduce((s, p) => s + p.value, 0);
  const outs = [{ ...b.tx.outputs[0] }, { value: 0, scriptPubKey: invoice.memo }];
  const lay = (fee) => { const change = sum - sats - fee; return [...outs, ...(change > 0 ? [{ value: change, scriptPubKey: me }] : [])]; };
  const shape = { version: b.tx.version, inputs: b.tx.inputs.map((x) => ({ ...x, prevout: { ...x.prevout } })), lockTime: b.tx.lockTime };
  const fee = Math.ceil(w.vsize({ ...shape, outputs: lay(0), witness: shape.inputs.map(() => ['00'.repeat(65)]) }) * w.minFeeRate);
  if (sum - sats - fee < 0) throw new Error(`not enough in the coins picked for ${sats} sats, the memo and a ${fee}-sat fee`);
  const tx = { ...shape, outputs: lay(fee), witness: [] };
  w.txsign.signKeyPath({ k, hash: w.ex.hash, signer: w.signer }, tx, b.prevouts, key);
  const hex = k.codec.encodeHex('Transaction', tx);
  const out = { ...b, tx, hex, txid: k.codec.txid(tx), fee, vsize: w.vsize(tx), change: sum - sats - fee, amount: sats,
    note: `pay ${sats.toLocaleString('en-US')} sats to ${invoice.address} for invoice ${invoice.nonce.slice(0, 8)}…, with the nonce in an OP_RETURN` };
  // check what will be sent, not the object that made it: decoded from the hex, with no cache behind it
  if (!w.verify({ tx: k.codec.decode('Transaction', hex), prevouts: b.prevouts }, key)) throw new Error('the payment\'s signatures do not verify');
  return out;
}

// No waitForPayment in the wallet: poll mined() until the transaction is in a block.
export async function waitMined(w, txid, { every = 2000, tries = 150, onWait = null } = {}) {
  for (let i = 0; i < tries; i++) { const m = await w.mined(txid); if (m) return m; onWait?.((i + 1) * every); await new Promise((r) => setTimeout(r, every)); }
  throw new Error(`${txid.slice(0, 12)}… not mined after ${(tries * every) / 1000} s`);
}
