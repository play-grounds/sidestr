// Just enough of the Solidity ABI for a deploy-and-call page: uintN/intN, address, bool, bytesN,
// string, bytes, and one level of arrays (fixed or dynamic) of those. Head/tail encoding as the
// spec says; no tuples, no nested arrays. Values in and out are strings, bigints, booleans, or
// arrays of them. Pure: no DOM, no chain, so it is tested in Node.
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { h = String(h).replace(/^0x/i, ''); if (h.length % 2 || !/^[0-9a-f]*$/i.test(h)) throw new Error(`not hex: ${h.slice(0, 20)}`); return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)); };
const word = (n) => { let h = BigInt.asUintN(256, BigInt(n)).toString(16); return h.padStart(64, '0'); };
const enc = new TextEncoder(), dec = new TextDecoder();
export const parseType = (t) => { const m = /^(.*?)(\[(\d*)\])?$/.exec(t); return { base: m[1], array: !!m[2], length: m[3] === undefined || m[3] === '' ? null : Number(m[3]) }; };
const isDynamic = (t) => { const p = parseType(t); if (p.array) return p.length === null || isDynamic(p.base); return t === 'string' || t === 'bytes'; };
function encodeStatic(t, v) {
  if (/^uint\d*$/.test(t)) { const n = BigInt(typeof v === 'string' ? v.trim() : v); if (n < 0n) throw new Error(`${t} cannot be negative`); return word(n); }
  if (/^int\d*$/.test(t)) return word(BigInt(typeof v === 'string' ? v.trim() : v));
  if (t === 'address') { const h = String(v).trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(h)) throw new Error(`not an address: ${String(v).slice(0, 20)}`); return h.slice(2).padStart(64, '0'); }
  if (t === 'bool') { const b = v === true || v === 'true' || v === 1 || v === '1'; if (!(b || v === false || v === 'false' || v === 0 || v === '0')) throw new Error('a bool is true or false'); return word(b ? 1 : 0); }
  const bn = /^bytes(\d+)$/.exec(t); if (bn) { const n = Number(bn[1]); const b = unhex(v); if (b.length !== n) throw new Error(`${t} needs ${n} bytes`); return hex(b).padEnd(64, '0'); }
  throw new Error(`unsupported type ${t}`);
}
function encodeDynamicBytes(b) { return word(b.length) + (b.length ? hex(b).padEnd(Math.ceil(b.length / 32) * 64, '0') : ''); }
// encode one value of type t: returns { head, tail } where dynamic types put an offset in the head
function encodeOne(t, v) {
  const p = parseType(t);
  if (p.array) { const items = Array.isArray(v) ? v : String(v).trim() === '' ? [] : String(v).split(',').map((x) => x.trim()); if (p.length !== null && items.length !== p.length) throw new Error(`${t} needs ${p.length} items`);
    const body = encodeMany(items.map(() => p.base), items); return p.length === null ? { dynamic: true, data: word(items.length) + body } : isDynamic(p.base) ? { dynamic: true, data: body } : { dynamic: false, data: body }; }
  if (t === 'string') return { dynamic: true, data: encodeDynamicBytes(enc.encode(String(v))) };
  if (t === 'bytes') return { dynamic: true, data: encodeDynamicBytes(unhex(v)) };
  return { dynamic: false, data: encodeStatic(t, v) };
}
export function encodeMany(types, values) {
  if (types.length !== values.length) throw new Error(`${types.length} values expected, ${values.length} given`);
  const parts = types.map((t, i) => encodeOne(t, values[i])); let head = '', tail = ''; const headLen = parts.reduce((a, p) => a + (p.dynamic ? 64 : p.data.length), 0);
  for (const p of parts) { if (p.dynamic) { head += word((headLen + tail.length) / 2); tail += p.data; } else head += p.data; }
  return head + tail;
}
export const encodeCall = (selector, types, values) => selector.toLowerCase() + encodeMany(types, values);
// decode: returns an array of values (bigint, string, boolean, hex string, or arrays)
function decodeOne(t, data, at) {
  const w = (o) => data.slice(o * 2, o * 2 + 64); const p = parseType(t);
  if (p.array) { let base = at, n = p.length; if (n === null) { const off = Number(BigInt('0x' + w(at))); n = Number(BigInt('0x' + w(off))); base = off + 32; } else if (isDynamic(p.base)) base = Number(BigInt('0x' + w(at)));
    const sub = data.slice(base * 2); const out = []; for (let i = 0; i < n; i++) out.push(decodeOne(p.base, sub, i * 32).value); return { value: out }; } // element offsets are relative to the array's own start
  if (t === 'string' || t === 'bytes') { const off = Number(BigInt('0x' + w(at))); const len = Number(BigInt('0x' + w(off))); const b = unhex(data.slice((off + 32) * 2, (off + 32 + len) * 2)); return { value: t === 'string' ? dec.decode(b) : '0x' + hex(b) }; }
  if (/^uint\d*$/.test(t)) return { value: BigInt('0x' + w(at)) };
  if (/^int\d*$/.test(t)) return { value: BigInt.asIntN(256, BigInt('0x' + w(at))) };
  if (t === 'address') return { value: '0x' + w(at).slice(24) };
  if (t === 'bool') return { value: BigInt('0x' + w(at)) !== 0n };
  const bn = /^bytes(\d+)$/.exec(t); if (bn) return { value: '0x' + w(at).slice(0, Number(bn[1]) * 2) };
  throw new Error(`unsupported type ${t}`);
}
export function decodeMany(types, hexData) { const data = String(hexData).replace(/^0x/i, ''); const out = []; let at = 0; for (const t of types) { const p = parseType(t); out.push(decodeOne(t, data, at).value); at += (isDynamic(t) || (p.array && p.length === null)) ? 32 : p.array ? 32 * p.length : 32; } return out; }
// a value for display: bigints as decimal, arrays joined
export const show = (v) => Array.isArray(v) ? '[' + v.map(show).join(', ') + ']' : typeof v === 'bigint' ? v.toString() : String(v);
