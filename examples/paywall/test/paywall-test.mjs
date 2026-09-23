// Pay-per-request end to end, as a project that is not ours: everything comes from this example's
// own node_modules (npm install sidestr), including the producer. A throwaway chain, the server and
// the client as separate processes, then every way to get an answer without paying for it.
//   npm install && node test/paywall-test.mjs            (about 3 minutes: 101 blocks mature the genesis coins)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { openWallet, paths } from 'sidestr';
import * as P from '../paywall.mjs';
// The packaged engine looks for the schema in ~/bitcoin-desktop/schema, a developer's checkout, unless
// SCHEMA says otherwise; point it at the copy this package installed, for this process and the producer.
process.env.SCHEMA = paths.cdn;
const SIDING = path.join(path.dirname(createRequire(import.meta.url).resolve('@sidestr/spec/package.json')), 'siding');
const HERE = path.dirname(new URL(import.meta.url).pathname), EX = path.join(HERE, '..');
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = []; process.on('exit', () => kids.forEach((k) => k.kill()));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paywall-')); const port = 4300 + Math.floor(Math.random() * 300), sport = port + 1000;
const mirror = `http://127.0.0.1:${port}`, server = `http://127.0.0.1:${sport}`;

// the chain: one signer, 50 genesis coins to it, no rules beyond the base
const { loadEngine } = await import(`${SIDING}/lib/engine.mjs`); const { makeSigner } = await import(`${SIDING}/lib/sign.mjs`);
const base = JSON.parse(fs.readFileSync(`${SIDING}/chain.json`, 'utf8')); const sg = makeSigner(await loadEngine(base));
const keyOf = (name) => { const k = sg.randomKey(); fs.writeFileSync(`${dir}/${name}.key`, k, { mode: 0o600 }); return { key: k, file: `${dir}/${name}.key` }; };
const gen = keyOf('genesis'), cli = keyOf('client'), srv = keyOf('server'); const me = '5120' + sg.pubkeyOf(gen.key);
const chain = { ...base, id: 'sidestr:paywalltest', name: 'paywalltest', addressPrefix: 'pw', challenge: me, signer: sg.pubkeyOf(gen.key), genesisTime: Math.floor(Date.now() / 1000), pegs: [{ txid: 'd'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
fs.writeFileSync(`${dir}/chain.json`, JSON.stringify(chain));
const run = (args, opts = {}) => { const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, ...opts }); p.out = ''; p.err = ''; p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.err += d; }); return p; };
const prod = run([`${SIDING}/bin/siding.mjs`, 'produce', '--chain', `${dir}/chain.json`, '--dir', `${dir}/data`, '--port', String(port), '--interval', '1', '--tx-interval', '1', '--key-file', gen.file]); kids.push(prod);
console.log(`producer from node_modules on ${mirror}, waiting for the genesis coins to mature (101 blocks at 1 s)…`);
for (let i = 0; i < 400; i++) { try { if ((await (await fetch(`${mirror}/status.json`)).json()).height >= 101) break; } catch {} await sleep(1000); if (i === 399) { console.error(prod.out.slice(-1500), prod.err.slice(-1500)); throw new Error('the producer did not reach height 101'); } }
const w = await openWallet({ mirror });
const deliver = async (b) => { const r = await fetch(`${mirror}/tx`, { method: 'POST', body: b.hex }); if (!r.ok) throw new Error(`producer refused: ${(await r.json()).error}`); return P.waitMined(w, b.txid, { every: 500, tries: 60 }); };
const get = async (p) => { const r = await fetch(server + p); return { status: r.status, body: await r.json(), headers: r.headers }; };

// 1. a funded client, a server with no coins at all
const C = w.identity(cli.key), S = w.identity(srv.key);
await deliver(w.build({ key: gen.key, to: C.address, amount: 200000 }));
t('the client has 200,000 sats; the server has none and needs none', w.balance(C.script).spendable === 200000 && w.balance(S.script).total === 0);
// the trap the first version of buildPayment fell into, kept as a check: the interpreter caches each
// transaction's sighash midstates by object, so a signed tx changed in place and signed again
// commits to the outputs it had before — and verify(), reading the same cache, says it is fine
const trap = w.build({ key: cli.key, to: S.address, amount: 1000 });
trap.tx.outputs.splice(1, 0, { value: 0, scriptPubKey: P.memoScript('00'.repeat(16)) });
w.txsign.signKeyPath({ k: w.ex.k, hash: w.ex.hash, signer: w.signer }, trap.tx, trap.prevouts, cli.key);
const trapHex = w.ex.k.codec.encodeHex('Transaction', trap.tx);
t('a signed transaction changed in place and signed again verifies against the sighash cache…', w.verify(trap, cli.key));
t('…and fails from its own bytes, which is what a validator reads', !w.verify({ tx: w.ex.k.codec.decode('Transaction', trapHex), prevouts: trap.prevouts }, cli.key));

// 2. the server, as its own process, reading the chain for itself
const sp = run([`${EX}/server.mjs`, '--key-file', srv.file, '--mirror', mirror, '--price', '1000', '--port', String(sport)]); kids.push(sp);
for (let i = 0; i < 60 && !sp.out.includes('listening'); i++) await sleep(500);
const up = JSON.parse(sp.out.split('\n').find((l) => l.startsWith('{')) ?? 'null');
t('the server is up on its own validated copy of the chain, at its own address', up?.chain === 'sidestr:paywalltest' && up.address === S.address && up.height >= 101);
const info = await get('/'); t('it says what it sells and for how much', info.status === 200 && info.body.sats === 1000 && info.body.address === S.address);
const ask = await get('/height'); const inv0 = ask.body.invoice;
t('asking without paying is a 402 and an invoice: chain, address, price, nonce, memo, expiry', ask.status === 402 && inv0.chain === 'sidestr:paywalltest' && inv0.address === S.address && inv0.sats === 1000 && /^[0-9a-f]{32}$/.test(inv0.nonce) && inv0.memo === P.memoScript(inv0.nonce) && inv0.expires > Date.now() / 1000);

// 3. the client, as its own process: ask, pay, wait, ask again — no human
const c1 = run([`${EX}/client.mjs`, server, '--key-file', cli.file, '--mirror', mirror]); await new Promise((r) => c1.on('exit', r));
const r1 = JSON.parse(c1.out.trim().split('\n').pop() || 'null');
t('the client paid and got its answer: the tip height, from a server that checked the payment itself', r1?.ok === true && r1.height > 101 && /^[0-9a-f]{64}$/.test(r1.txid));
if (!r1?.ok) console.error(c1.err.slice(-2000), sp.out.slice(-1500), sp.err.slice(-1500));
await w.refresh();
const tx1 = w.ex.txs.get(r1.txid)?.tx;
t('the payment pays the server exactly the price and carries the nonce in a zero-value OP_RETURN', tx1?.outputs[0].scriptPubKey === S.script && tx1.outputs[0].value === 1000 && tx1.outputs[1].value === 0 && tx1.outputs[1].scriptPubKey === P.memoScript(r1.nonce));
t('the server now holds 1,000 sats, as its history shows', w.history(S.script).filter((x) => x.dir === 'in').reduce((s, x) => s + x.value, 0) === 1000);

// 4. the same payment again
const again = await get(`/height?nonce=${r1.nonce}&txid=${r1.txid}`);
t('the same invoice and txid a second time are refused: one payment, one answer', again.status === 409 && again.body.error === 'already answered');
const inv1 = (await get('/height')).body.invoice;
const reuse = await get(`/height?nonce=${inv1.nonce}&txid=${r1.txid}`);
t('the old txid against a fresh invoice is refused too', reuse.status === 409 && reuse.body.error === 'payment already used');

// 5. paying the wrong amount
const inv2 = (await get('/height')).body.invoice;
const under = P.buildPayment(w, { key: cli.key, invoice: inv2, sats: 999 }); await deliver(under);
const short = await get(`/height?nonce=${inv2.nonce}&txid=${under.txid}`);
t('a payment one sat short is refused, and says by how much', short.status === 402 && short.body.error === 'short' && /999/.test(short.body.why) && /1,000/.test(short.body.why));

// 6. paying the right amount without the nonce
const plain = w.build({ key: cli.key, to: S.address, amount: 1000 }); await deliver(plain);
const nomemo = await get(`/height?nonce=${inv2.nonce}&txid=${plain.txid}`);
t('a plain payment of the right amount, without the nonce, is refused: it was not made for this invoice', nomemo.status === 402 && nomemo.body.error === 'memo' && /1,000 sats here, for something else/.test(nomemo.body.why));
const inv3 = (await get('/height')).body.invoice; const memoOther = P.buildPayment(w, { key: cli.key, invoice: inv3 }); await deliver(memoOther);
const cross = await get(`/height?nonce=${inv2.nonce}&txid=${memoOther.txid}`);
t('a full payment carrying another invoice\'s nonce is refused for this one', cross.status === 402 && cross.body.error === 'memo');
const right = await get(`/height?nonce=${inv3.nonce}&txid=${memoOther.txid}`);
t('and redeems the invoice it was made for', right.status === 200 && right.body.paid.txid === memoOther.txid);

// 7. the things that are simply wrong
const unknown = await get(`/height?nonce=${'ab'.repeat(16)}&txid=${r1.txid}`);
t('a nonce this server never issued is a 404', unknown.status === 404 && unknown.body.error === 'unknown invoice');
const inv4 = (await get('/height')).body.invoice;
const junk = await get(`/height?nonce=${inv4.nonce}&txid=nothex`);
t('a txid that is not a txid is a 400', junk.status === 400);
const ghost = await get(`/height?nonce=${inv4.nonce}&txid=${'ee'.repeat(32)}`);
t('a txid that is in no block is "unmined", with a Retry-After', ghost.status === 402 && ghost.body.error === 'unmined' && ghost.headers.get('retry-after') === '5');
const late = P.buildPayment(w, { key: cli.key, invoice: inv4 }); await deliver(late);
const stillOpen = await get(`/height?nonce=${inv4.nonce}&txid=${late.txid}`);
t('and the invoice stays open: paid afterwards, it is answered', stillOpen.status === 200 && stillOpen.body.paid.txid === late.txid);

// 8. two requests racing for one paid invoice
const inv5 = (await get('/height')).body.invoice; const race = P.buildPayment(w, { key: cli.key, invoice: inv5 }); await deliver(race);
await sleep(1500);
const both = await Promise.all([get(`/height?nonce=${inv5.nonce}&txid=${race.txid}`), get(`/height?nonce=${inv5.nonce}&txid=${race.txid}`)]);
t('two simultaneous redemptions of one payment get exactly one answer', both.map((x) => x.status).sort().join() === '200,409');

// 9. the client's own caution
const c2 = run([`${EX}/client.mjs`, server, '--key-file', cli.file, '--mirror', mirror, '--max', '500']); const code2 = await new Promise((r) => c2.on('exit', r));
t('a client with a 500-sat ceiling refuses a 1,000-sat invoice and pays nothing', code2 !== 0 && /pays at most 500/.test(c2.err));
t('an invoice whose memo is not the one its nonce implies is refused before anything is signed', (() => { try { P.checkInvoice(w, { ...inv4, memo: '6a04deadbeef' }, { maxSats: 5000 }); return false; } catch (e) { return /arbitrary script/.test(e.message); } })());
t('so is one for another chain', (() => { try { P.checkInvoice(w, { ...inv4, chain: 'sidestr:txbt4-evm' }, { maxSats: 5000 }); return false; } catch (e) { return /this client opened/.test(e.message); } })());
fs.chmodSync(cli.file, 0o644); const c3 = run([`${EX}/client.mjs`, server, '--key-file', cli.file]); const code3 = await new Promise((r) => c3.on('exit', r)); fs.chmodSync(cli.file, 0o600);
t('and a key file anyone can read is refused', code3 !== 0 && /chmod 600/.test(c3.err));

// what it cost and what the server kept
await w.refresh();
const got = w.history(S.script).filter((x) => x.dir === 'in').reduce((s, x) => s + x.value, 0);
t('the server kept every sat sent to it, including the payments it refused to answer', got === 1000 + 999 + 1000 + 1000 + 1000 + 1000);
console.log(`\na payment with its memo: ${r1.fee} sats of fee (${w.ex.txs.get(r1.txid) ? w.vsize(w.ex.txs.get(r1.txid).tx) : '?'} vB); the server received ${got.toLocaleString('en-US')} sats for 4 answers`);
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
