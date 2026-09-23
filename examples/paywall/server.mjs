// A server that answers one question — the height and hash of the tip of the chain it watches — and
// only after a payment it has checked itself: mined, to its own address, for at least the price,
// carrying the nonce of the invoice it issued. It trusts nothing the client says except a txid.
//   node server.mjs --key-file F (--chain ID | --mirror URL) [--price 1000] [--port 8402] [--ttl 600]
//
//   GET /                    what this is: chain, address, price
//   GET /height              402 and an invoice: { chain, address, sats, nonce, memo, expires }
//   GET /height?nonce&txid   the answer, once that txid pays that invoice; 402 with the reason if not
import fs from 'node:fs'; import http from 'node:http';
import { openWallet } from 'sidestr';
import { makeInvoice, checkPayment } from './paywall.mjs';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keyFile = arg('key-file'); if (!keyFile) throw new Error('--key-file: a file holding the server\'s key, mode 0600');
if (fs.statSync(keyFile).mode & 0o077) throw new Error(`${keyFile} is readable by others; chmod 600 it`);
const key = fs.readFileSync(keyFile, 'utf8').trim();
const price = Number(arg('price', 1000)), port = Number(arg('port', 8402)), ttl = Number(arg('ttl', 600));
const GRACE = 3600;   // a paid invoice may be redeemed this long after it stops being payable

const w = await openWallet(arg('mirror') ? { mirror: arg('mirror') } : { chain: arg('chain', 'sidestr:txbt4-siding'), onProgress: (s) => say('…', s) });
const me = w.identity(key);
const invoices = new Map();       // nonce → { invoice, redeemed: txid | null, busy }
const spent = new Set();          // txids that have bought an answer: one payment, one answer

const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body, null, 1) + '\n'); };
const purge = (now) => { for (const [n, v] of invoices) if (now > v.invoice.expires + GRACE) invoices.delete(n); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const now = Math.floor(Date.now() / 1000); purge(now);
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
    if (u.pathname === '/') return send(res, 200, { chain: w.chain.id, address: me.address, sats: price, endpoint: '/height', how: 'GET /height for an invoice; pay it with the nonce in an OP_RETURN; GET /height?nonce=…&txid=… once it is mined' });
    if (u.pathname !== '/height') return send(res, 404, { error: 'the only thing for sale is /height' });
    const nonce = u.searchParams.get('nonce'), txid = u.searchParams.get('txid');
    if (!nonce && !txid) { const invoice = makeInvoice(w, { address: me.address, sats: price, ttl, now }); invoices.set(invoice.nonce, { invoice, redeemed: null, busy: false }); say(`invoice ${invoice.nonce.slice(0, 8)}… for ${price} sats`); return send(res, 402, { error: 'payment required', invoice }); }
    const v = invoices.get(nonce ?? '');
    if (!v) return send(res, 404, { error: 'unknown invoice', why: 'this server did not issue that nonce, or has forgotten it; ask for a new invoice' });
    if (v.redeemed) return send(res, 409, { error: 'already answered', why: `invoice ${nonce.slice(0, 8)}… was paid by ${v.redeemed.slice(0, 12)}… and has had its answer: one payment, one answer` });
    if (spent.has(txid)) return send(res, 409, { error: 'payment already used', why: `${txid.slice(0, 12)}… has already bought an answer` });
    if (v.busy) return send(res, 409, { error: 'being checked', why: 'a request for this invoice is already being checked' });
    v.busy = true;
    try {
      const r = await checkPayment(w, { txid, invoice: v.invoice, script: me.script });
      if (!r.ok) { say(`refused ${nonce.slice(0, 8)}…: ${r.code}`); return send(res, r.code === 'bad' ? 400 : 402, { error: r.code, why: r.why }, r.code === 'unmined' ? { 'retry-after': '5' } : {}); }
      v.redeemed = txid; spent.add(txid);
      say(`answered ${nonce.slice(0, 8)}…: ${r.why}`);
      return send(res, 200, { chain: w.chain.id, height: w.tip.height, hash: w.tip.hash, paid: { txid, sats: r.paid, block: r.height } });
    } finally { v.busy = false; }
  } catch (e) { say('error', e.message); return send(res, 500, { error: e.message }); }
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, chain: w.chain.id, address: me.address, sats: price, height: w.tip.height })));
