// The escrow end to end on a throwaway evm chain produced by the reference CLI: deploy, lock, refuse
// the wrong preimage, claim with the right one, and a second lock that nobody claims and the payer
// takes back after the deadline. Every refusal is shown through a read-only call before it would be
// sent, which is what the page does. Two fresh keys: the payer and the payee never share one.
//   node test/escrow-test.mjs            (about 4 minutes: 101 blocks mature the genesis coins)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import * as E from '../escrow.mjs';
const H = os.homedir(), SIDING = `${H}/remote/github.com/sidestr/spec/siding`; let ok = 0, bad = 0; const gas = [];
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 120)})` : ''), !re || re.test(e.message)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-')); const port = 3900 + Math.floor(Math.random() * 300); const mirror = `http://127.0.0.1:${port}`;
// the chain: one signer, 50 genesis coins to it, the evm rule
const { openWallet } = await import(`${H}/remote/github.com/sidestr/wallet/wallet.mjs`);
const { loadEngine } = await import(`${SIDING}/lib/engine.mjs`); const { makeSigner } = await import(`${SIDING}/lib/sign.mjs`);
const base = JSON.parse(fs.readFileSync(`${SIDING}/chain.json`, 'utf8')); const eng0 = await loadEngine(base); const sg = makeSigner(eng0);
const key = sg.randomKey(), pub = sg.pubkeyOf(key), me = '5120' + pub;
const chain = { ...base, id: 'sidestr:escrowtest', name: 'escrowtest', addressPrefix: 'et', challenge: me, signer: pub, rules: ['evm'], evm: { chainId: 21474, gasLimit: 30000000 }, genesisTime: Math.floor(Date.now() / 1000), pegs: [{ txid: 'c'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
fs.writeFileSync(`${dir}/chain.json`, JSON.stringify(chain)); fs.writeFileSync(`${dir}/key`, key, { mode: 0o600 });
const prod = spawn(process.execPath, [`${SIDING}/bin/siding.mjs`, 'produce', '--chain', `${dir}/chain.json`, '--dir', `${dir}/data`, '--port', String(port), '--interval', '1', '--tx-interval', '1', '--key-file', `${dir}/key`], { stdio: ['ignore', 'pipe', 'pipe'] });
let plog = ''; prod.stdout.on('data', (d) => { plog += d; }); prod.stderr.on('data', (d) => { plog += d; }); process.on('exit', () => prod.kill());
console.log(`producer on ${mirror}, waiting for the genesis coins to mature (101 blocks at 1 s)…`);
for (let i = 0; i < 400; i++) { try { const st = await (await fetch(`${mirror}/status.json`)).json(); if (st.height >= 101) break; } catch {} await sleep(1000); if (i === 399) { console.error(plog.slice(-2000)); throw new Error('the producer did not reach height 101'); } }
const w = await openWallet({ mirror, cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: `${SIDING}/lib`, explorer: `${H}/remote/github.com/sidestr/explorer/explorer.mjs`, loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')) });
const deliver = async (b) => { const r = await fetch(`${mirror}/tx`, { method: 'POST', body: b.hex }); const j = await r.json(); if (!r.ok) throw new Error(`producer refused: ${j.error}`); for (let i = 0; i < 40; i++) { await sleep(500); const m = await w.mined(b.txid); if (m) return m; } throw new Error(`${b.txid.slice(0, 12)}… not mined in 20 s\n${plog.slice(-1500)}`); };
const spend = async (b, what) => { const m = await deliver(b); const rc = b.ethHash ? w.evmReceipt(b.ethHash) : null; if (rc) gas.push([what, rc.gasUsed]); return { m, rc }; };

// 0. the design's one assumption about this chain's VM
t('the sha256 precompile is live: the hash the page computes is the hash the contract checks', await E.sha256Live(w));

// 1. two fresh keys, funded with sats for the carrier fees and gwei for gas
const payer = sg.randomKey(), payee = sg.randomKey();
const pr = { key: payer, id: w.identity(payer), eth: w.ethAddress(payer) }, pe = { key: payee, id: w.identity(payee), eth: w.ethAddress(payee) };
t('the payer and the payee are different keys with different EVM addresses', pr.eth !== pe.eth);
for (const p of [pr, pe]) { await deliver(w.build({ key, to: p.id.address, amount: 200000 })); await deliver(w.build({ key, to: p.eth, amount: 1000000, evmDeposit: true })); }
t('both have sats for the carrier and 1,000,000 gwei in the EVM', w.balance(pr.id.script).spendable === 200000 && (await w.evmBalance(pe.eth)) === 1000000n * E.GWEI);

// 2. deploy the escrow from the fixture (solc 0.8.28, optimiser 200, cancun: node test/compile.mjs)
const bin = fs.readFileSync(new URL('./fixtures/Escrow.bin', import.meta.url), 'utf8').trim();
await deliver(w.build({ key, to: w.ethAddress(key), amount: 2000000, evmDeposit: true }));   // the deployer needs gwei of its own
const dep = await w.buildEvm({ key, data: bin }); await spend(dep, 'deploy'); const escrow = dep.contractAddress;
t('the escrow is deployed at the predicted address with runtime code', (await w.evmCode(escrow)) !== '0x' && w.evmReceipt(dep.ethHash)?.status === 1);

// 3. a secret, a hash, an id computed off the chain and agreed with the contract
const secret = E.newSecret(), hash = await E.hashOf(secret);
t('a secret is 32 bytes and its hash is sha256 of those bytes, computed without the chain', /^0x[0-9a-f]{64}$/.test(secret) && /^0x[0-9a-f]{64}$/.test(hash));
const deadline = Math.floor(Date.now() / 1000) + 900;
const id = await E.idOf(w, { payer: pr.eth, payee: pe.eth, hash, deadline });
const onChainId = (await w.evmCall({ to: escrow, data: (await w.selector(E.SIG.idOf)) + [pr.eth, pe.eth].map((a) => a.slice(2).padStart(64, '0')).join('') + hash.slice(2) + BigInt(deadline).toString(16).padStart(64, '0') })).returnValue;
t("the page's id is the contract's id: the same padded-word encoding on both sides", id === onChainId);

// 4. nothing is there yet, and the state machine says so
t('an id with no lock reads as null, and the state is "none" with the lock form for a key', (await E.readLock(w, escrow, id)) === null && E.stateOf(null, { me: pr.eth }).state === 'none' && E.stateOf(null, { me: pr.eth }).action.kind === 'lock');
await throws('a claim against nothing is refused with "gone" before it is sent', () => E.buildClaim(w, { key: payee, escrow, lock: { id, hash, deadline, payee: pe.eth, sats: 1n }, secret }), /not on the chain/);

// 5. the lock, and what the page refuses at the door
await throws('a lock of nothing is refused', () => E.buildLock(w, { key: payer, escrow, payee: pe.eth, hash, deadline, sats: 0 }), /more than none/);
await throws('a deadline in the past is refused before it reaches the chain', () => E.buildLock(w, { key: payer, escrow, payee: pe.eth, hash, deadline: Math.floor(Date.now() / 1000) - 10, sats: 1000 }), /at least/);
await throws('a deadline too soon for the payee to act is refused', () => E.buildLock(w, { key: payer, escrow, payee: pe.eth, hash, deadline: Math.floor(Date.now() / 1000) + 60, sats: 1000 }), /at least/);
const lk = await E.buildLock(w, { key: payer, escrow, payee: pe.eth, hash, deadline, sats: 100000 });
t('the build predicts the id it will create', lk.id === id);
await spend(lk, 'lock');
const l = await E.readLock(w, escrow, id);
t('the lock is on the chain: payer, payee, 100,000 sats, the deadline and the hash', l && l.payer === pr.eth.toLowerCase() && l.payee === pe.eth.toLowerCase() && l.sats === 100000n && l.deadline === deadline && l.hash === hash);
t('the escrow holds the sats, and the payer paid them out of the EVM', (await w.evmBalance(escrow)) === 100000n * E.GWEI);
const ev = await E.history(w, escrow); const locked = ev.find((x) => x.kind === 'locked');
t('the Locked log decodes: indexed id, payer and payee, with the amount, deadline and hash in the data', locked?.id === id && locked.payer === pr.eth.toLowerCase() && locked.payee === pe.eth.toLowerCase() && locked.sats === 100000n && locked.deadline === deadline && locked.hash === hash);
t('history filtered by a key returns that key\'s locks and nobody else\'s', (await E.history(w, escrow, { address: pe.eth })).some((x) => x.id === id) && (await E.history(w, escrow, { address: '0x' + '11'.repeat(20) })).length === 0);

// 6. who may do what, while it is open
const now = Math.floor(Date.now() / 1000);
t('the payer sees a locked escrow and no action: it cannot come back before the deadline', E.stateOf(l, { now, me: pr.eth }).state === 'open' && E.stateOf(l, { now, me: pr.eth }).action === null);
t('the payee sees the one action there is: claim, and it needs the secret', E.stateOf(l, { now, me: pe.eth }).action?.kind === 'claim' && E.stateOf(l, { now, me: pe.eth }).action.needs === 'secret');
t('anyone else sees it read-only', E.stateOf(l, { now, me: '0x' + '22'.repeat(20) }).role === 'observer' && E.stateOf(l, { now, me: '0x' + '22'.repeat(20) }).action === null);
t('inside the safety margin nobody is offered anything, and the payee is told why', E.stateOf(l, { now: deadline - 30, me: pe.eth }).state === 'closing' && E.stateOf(l, { now: deadline - 30, me: pe.eth }).action === null && /public for nothing/.test(E.stateOf(l, { now: deadline - 30, me: pe.eth }).why));

// 7. the refusals, each shown by a read-only call before anything is signed
await throws('the wrong preimage is caught on the page, without a call', () => E.buildClaim(w, { key: payee, escrow, lock: l, secret: E.newSecret() }), /does not match/);
const wrong = await E.dryRun(w, { from: pe.eth, to: escrow, data: (await w.selector(E.SIG.claim)) + id.slice(2) + E.newSecret().slice(2) });
t('and the chain agrees: a claim with the wrong preimage reverts "hash"', !wrong.ok && wrong.reason === 'hash');
const early = await E.dryRun(w, { from: pr.eth, to: escrow, data: (await w.selector(E.SIG.refund)) + id.slice(2) });
t('a refund before the deadline reverts "early"', !early.ok && early.reason === 'early');
await throws('and the page refuses to build it, saying how long is left', () => E.buildRefund(w, { key: payer, escrow, lock: l }), /s away/);
const late = await E.dryRun(w, { from: pe.eth, to: escrow, data: (await w.selector(E.SIG.claim)) + id.slice(2) + secret.slice(2) });
t('the right preimage passes the dry run: the page can light the button knowing it works', late.ok);

// 8. the claim: the payee is paid and the secret becomes public
const before = await w.evmBalance(pe.eth);
const cl = await E.buildClaim(w, { key: payee, escrow, lock: l, secret }); const { rc } = await spend(cl, 'claim');
t('claimed: the payee is up 100,000 sats less the gas they paid', (await w.evmBalance(pe.eth)) === before + 100000n * E.GWEI - rc.gasUsed * E.GWEI);
t('the escrow is empty again', (await w.evmBalance(escrow)) === 0n);
t('the lock is gone from storage', (await E.readLock(w, escrow, id)) === null);
const ev2 = await E.history(w, escrow); const done = E.settlementOf(ev2, id);
t('the Claimed log carries the preimage, so the secret is on the chain as the receipt', done?.kind === 'claimed' && done.preimage === secret);
t('a settled lock reads as claimed, with no action for anyone', E.stateOf(null, { me: pe.eth, settled: done }).state === 'claimed' && E.stateOf(null, { me: pr.eth, settled: done }).action === null);
t('and it still knows who the two parties were, though the lock is gone from storage', done.payer === pr.eth.toLowerCase() && done.payee === pe.eth.toLowerCase() && E.stateOf(null, { me: pe.eth, settled: done }).role === 'payee' && E.stateOf(null, { me: pr.eth, settled: done }).role === 'payer' && E.stateOf(null, { me: '0x' + '33'.repeat(20), settled: done }).role === 'observer');
t('a settled lock is in its parties\' history, found by either address', (await E.history(w, escrow, { address: pe.eth })).some((x) => x.kind === 'claimed' && x.id === id));
const gone = await E.dryRun(w, { from: pe.eth, to: escrow, data: (await w.selector(E.SIG.claim)) + id.slice(2) + secret.slice(2) });
t('claiming twice reverts "gone"', !gone.ok && gone.reason === 'gone');

// 9. a second lock nobody claims: the payer takes it back after the deadline
const s2 = E.newSecret(), h2 = await E.hashOf(s2), d2 = Math.floor(Date.now() / 1000) + 10;
const lk2 = await E.buildLock(w, { key: payer, escrow, payee: pe.eth, hash: h2, deadline: d2, sats: 50000, minTerm: 5 });
await spend(lk2, 'lock (2)');
const l2 = await E.readLock(w, escrow, lk2.id); t('the second lock is on the chain', l2?.sats === 50000n);
await throws('a lock at the same id while the first is open is refused with "taken"', () => E.buildLock(w, { key: payer, escrow, payee: pe.eth, hash: h2, deadline: d2, sats: 50000, minTerm: 5 }), /taken/);
console.log(`  …waiting ${d2 - Math.floor(Date.now() / 1000) + 3} s for the deadline to pass`);
while (Math.floor(Date.now() / 1000) <= d2 + 2) await sleep(1000);
const tooLate = await E.dryRun(w, { from: pe.eth, to: escrow, data: (await w.selector(E.SIG.claim)) + lk2.id.slice(2) + s2.slice(2) });
t('past the deadline the right preimage reverts "late": the claim window is shut', !tooLate.ok && tooLate.reason === 'late');
await throws('and the page refuses to build that claim too', () => E.buildClaim(w, { key: payee, escrow, lock: l2, secret: s2 }), /deadline is/);
t('the payer is now the only one with an action: refund', E.stateOf(l2, { me: pr.eth }).state === 'expired' && E.stateOf(l2, { me: pr.eth }).action?.kind === 'refund' && E.stateOf(l2, { me: pe.eth }).action === null);
const pBefore = await w.evmBalance(pr.eth);
const rf = await E.buildRefund(w, { key: payer, escrow, lock: l2 }); const r2 = await spend(rf, 'refund');
t('refunded: the payer is back up 50,000 sats less the gas', (await w.evmBalance(pr.eth)) === pBefore + 50000n * E.GWEI - r2.rc.gasUsed * E.GWEI);
const back = E.settlementOf(await E.history(w, escrow), lk2.id);
t('the Refunded log says which lock it was, and the state reads as refunded', back?.kind === 'refunded' && E.stateOf(null, { me: pr.eth, settled: back }).state === 'refunded');
const twice = await E.dryRun(w, { from: pr.eth, to: escrow, data: (await w.selector(E.SIG.refund)) + lk2.id.slice(2) });
t('refunding twice reverts "gone"', !twice.ok && twice.reason === 'gone');

console.log('\ngas, as the chain charged it (1 gas = 1 gwei = 1 sat):');
for (const [what, g] of gas) console.log(`  ${what.padEnd(10)} ${g.toLocaleString('en-US').padStart(9)}`);
console.log(`\n${ok} passed, ${bad} failed`); prod.kill(); process.exit(bad ? 1 : 0);
