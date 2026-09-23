// An agent that buys an answer, built on the package's agent example (node_modules/sidestr/examples/
// agent.mjs): the same key, the same openWallet. It asks, is shown a price, checks the invoice, pays
// it with the nonce in an OP_RETURN, waits for the block, and asks again with the txid. No human.
//   SIDESTR_KEY=<hex> node client.mjs <server url> [--key-file F] [--max 10000] [--chain ID | --mirror URL]
// With --mirror the payment is handed to that producer's POST /tx (a throwaway chain has no relays);
// otherwise it goes out over the relays, as every other transaction does.
import fs from 'node:fs';
import { openWallet } from 'sidestr';
import { checkInvoice, buildPayment, waitMined } from './paywall.mjs';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const say = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);   // stdout is the answer, for scripts
const server = (process.argv[2] ?? '').replace(/\/$/, ''); if (!/^https?:\/\//.test(server)) throw new Error('usage: node client.mjs <server url>');
const keyFile = arg('key-file');
if (keyFile && fs.statSync(keyFile).mode & 0o077) throw new Error(`${keyFile} is readable by others; chmod 600 it`);
const key = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : process.env.SIDESTR_KEY;
if (!/^[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('SIDESTR_KEY or --key-file: 32 bytes of hex');
const maxSats = Number(arg('max', 10000)), mirror = arg('mirror');
const get = async (path) => { const r = await fetch(server + path); return { status: r.status, body: await r.json() }; };

// 1. ask, and be told the price
const first = await get('/height');
if (first.status !== 402 || !first.body.invoice) throw new Error(`expected an invoice (402), got ${first.status}: ${JSON.stringify(first.body)}`);
const inv = first.body.invoice;
say(`the server wants ${inv.sats.toLocaleString('en-US')} sats on ${inv.chain} for /height (invoice ${inv.nonce.slice(0, 8)}…)`);

// 2. open that chain myself, validate it, and check the invoice against it before paying anything
const w = await openWallet(mirror ? { mirror } : { chain: arg('chain', inv.chain), onProgress: (s) => say('…', s) });
checkInvoice(w, inv, { maxSats });
const me = w.identity(key);
say(`I am ${me.address} · ${w.balance(me.script).spendable.toLocaleString('en-US')} sats spendable at block ${w.tip.height}`);
if (w.balance(me.script).spendable === 0) { const r = await w.requestFaucet(me.address); say(`no coins: asked a faucet (${r.accepted ? 'a relay took it' : 'no relay accepted'}); run me again once they arrive`); process.exit(2); }

// 3. pay it
const b = buildPayment(w, { key, invoice: inv });
say(`${b.note} · fee ${b.fee} sats · txid ${b.txid.slice(0, 12)}…`);
if (mirror) { const r = await fetch(`${mirror.replace(/\/$/, '')}/tx`, { method: 'POST', body: b.hex }); if (!r.ok) throw new Error(`the producer refused the payment: ${(await r.json()).error}`); }
else { const r = await w.publish(b.hex); if (!r.accepted) throw new Error('no relay accepted the payment'); }
const m = await waitMined(w, b.txid, { onWait: (ms) => { if (ms % 10000 === 0) say(`waiting for a block… ${ms / 1000} s`); } });
say(`mined in block ${m.height}`);

// 4. ask again with the proof; the server may be a block behind me, so "unmined" means ask again
for (let i = 0; i < 20; i++) {
  const r = await get(`/height?nonce=${inv.nonce}&txid=${b.txid}`);
  if (r.status === 200) { say(`answered: ${inv.chain} is at block ${r.body.height}`); console.log(JSON.stringify({ ok: true, height: r.body.height, hash: r.body.hash, nonce: inv.nonce, txid: b.txid, sats: inv.sats, fee: b.fee })); process.exit(0); }
  if (r.body.error !== 'unmined') { console.log(JSON.stringify({ ok: false, status: r.status, ...r.body, nonce: inv.nonce, txid: b.txid })); process.exit(1); }
  await new Promise((x) => setTimeout(x, 2000));
}
throw new Error('the server never saw the payment mined');
