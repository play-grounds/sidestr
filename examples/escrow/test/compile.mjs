// Compile Escrow.sol into test/fixtures/, so the test does not need a compiler and the page and the
// test deploy the same bytes. The published soljson bundle is fetched once and cached in the temp
// directory; the settings are the ide's (optimiser on, 200 runs, cancun), which is what the chain
// runs.  node test/compile.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
const VERSION = 'v0.8.28+commit.7893614a';
const here = new URL('.', import.meta.url).pathname, src = fs.readFileSync(path.join(here, '../Escrow.sol'), 'utf8');
const cache = path.join(os.tmpdir(), `soljson-${VERSION}.js`);
if (!fs.existsSync(cache)) { process.stdout.write(`fetching solc ${VERSION} (about 9 MB)… `); const r = await fetch(`https://binaries.soliditylang.org/bin/soljson-${VERSION}.js`); if (!r.ok) throw new Error(`solc download: ${r.status}`); fs.writeFileSync(cache, Buffer.from(await r.arrayBuffer())); console.log('cached in', cache); }
const solc = createRequire(import.meta.url)(cache);
const compile = solc.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
const out = JSON.parse(compile(JSON.stringify({ language: 'Solidity', sources: { 'Escrow.sol': { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.methodIdentifiers'] } } } }), 0, 0));
for (const e of out.errors ?? []) console.log(e.formattedMessage.trim());
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);
const c = out.contracts['Escrow.sol'].Escrow;
fs.mkdirSync(path.join(here, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(here, 'fixtures/Escrow.bin'), c.evm.bytecode.object + '\n');
fs.writeFileSync(path.join(here, 'fixtures/Escrow.abi'), JSON.stringify(c.abi, null, 1) + '\n');
console.log(`Escrow: ${c.evm.bytecode.object.length / 2} bytes of creation code, selectors`, c.evm.methodIdentifiers);
