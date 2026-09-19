// The Solidity compiler in a worker: the published soljson bundle (Emscripten) loaded once, then
// Standard JSON in, Standard JSON out. The page never blocks while it compiles.
let ready = null;
function load(version) {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    self.Module = { onRuntimeInitialized: () => resolve(self.Module), print: () => {}, printErr: () => {} };
    try { importScripts(`https://binaries.soliditylang.org/bin/soljson-${version}.js`); } catch (e) { return reject(new Error(`could not load solc ${version}: ${e.message}`)); }
    // the published bundles initialise synchronously during the import (the wasm is embedded), so the callback may never fire
    if (self.Module && typeof self.Module.cwrap === 'function' && self.Module._solidity_compile) resolve(self.Module);
  });
  return ready;
}
self.onmessage = async (ev) => {
  const { id, version, input } = ev.data;
  try {
    const M = await load(version);
    const compile = M.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
    const out = compile(JSON.stringify(input), 0, 0);
    self.postMessage({ id, output: JSON.parse(out) });
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
