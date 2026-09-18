// The directory against the live relays: node test/list-test.mjs [--relay wss://a,wss://b]
import { listChains, headerTime } from '../sidechains.mjs';
const H = process.env.HOME; const i = process.argv.indexOf('--relay'); const relays = i > 0 ? process.argv[i + 1].split(',') : undefined;
const t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; };
t('header time is read from bytes 68-72 little-endian', headerTime('00'.repeat(68) + '78563412' + '00'.repeat(92)) === 0x12345678);
const rows = await listChains({ relays, cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: `${H}/remote/github.com/sidestr/spec/siding/lib`, onRelay: (u, s) => console.log(`  … ${u}: ${s}`) });
t(`the relays list at least one chain (${rows.length})`, rows.length >= 1);
for (const r of rows) console.log(`  ${r.id}  tip ${r.tip}  last block ${new Date(r.lastBlock * 1000).toISOString()}  24h ${r.blocks24h}  mirror ${r.mirror ?? '(none: ' + r.note + ')'}  signer ${r.signer.slice(0, 8)}…`);
const s = rows.find((r) => r.id === 'sidestr:txbt4-siding');
t('txbt4-siding is listed with a vouched-for mirror and its chain.json name', !!s && s.ok === true && s.name === 'txbt4-siding' && s.parent === 'btc:testnet4-blake2b');
t('its last-block time is recent and sane', !!s && s.lastBlock > 1_750_000_000 && s.lastBlock <= Math.floor(Date.now() / 1000) + 7200);
process.exit();
