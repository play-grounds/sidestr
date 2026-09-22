// A directory of sidestr chains, built from the relays alone: every producer announces its tip
// as a kind 33333 event tagged t = sidestr (SPEC 11), so one request lists them all. Per chain
// the newest announcement wins; a mirror it names is accepted when that mirror's chain.json is
// signed by the announcer, which is also where the name and comment come from. No host names
// here: mirrors come from the announcements. Runs in a browser or in Node (the test).
export const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'];
export const TIP_KIND = 33333;
export const CDN = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27';
export const LIB = 'https://cdn.jsdelivr.net/gh/sidestr/spec@e457737ac3e0f674273978b653268aad45d1f73e/siding/lib';

// every sidestr announcement the relays hold, deduplicated by event id
export function fetchTips({ relays = DEFAULT_RELAYS, timeout = 6000, onRelay = () => {} } = {}) {
  return new Promise((resolve) => {
    const events = new Map(); let open = relays.length; const finish = () => { clearTimeout(t); resolve([...events.values()]); }; const done = () => { if (--open <= 0) finish(); };
    const t = setTimeout(finish, timeout);
    for (const url of relays) {
      let ws; try { ws = new WebSocket(url); } catch { onRelay(url, 'unreachable'); done(); continue; }
      let n = 0;
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'sidestr', { kinds: [TIP_KIND], '#t': ['sidestr'], limit: 500 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.kind === TIP_KIND && typeof msg[2].id === 'string') { events.set(msg[2].id, msg[2]); n++; }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { onRelay(url, `${n} announcement(s)`); try { ws.close(); } catch {} done(); } };
      ws.onerror = () => { onRelay(url, 'error'); }; ws.onclose = () => done();
    }
  });
}

// the block time in a 164-byte v2 header: the first 80 bytes keep the classic layout, time at 68
export const headerTime = (hex) => parseInt(hex.slice(136, 144).match(/../g).reverse().join(''), 16);

// the chains, ranked: blocks in the last day, then height. Each row: { id, name, parent, comment,
// signer, tip, tipHash, lastBlock, blocks24h, announcedAt, mirrors, mirror, ok, note, announcers }
export async function listChains({ relays = DEFAULT_RELAYS, lib = LIB, cdn = CDN, now = Math.floor(Date.now() / 1000), fetchJson, onRelay, timeout } = {}) {
  const [{ parseTip, chooseMirror }, { verifyNostrEvent }] = await Promise.all([import(`${lib}/announce.mjs`), import(`${cdn}/codec/nostr.js`)]);
  const events = await fetchTips({ relays, onRelay, timeout });
  const byChain = new Map();
  for (const ev of events) {
    let ok = false; try { ok = verifyNostrEvent(ev); } catch {} const p = ok ? parseTip(ev) : null; if (!p || !p.chainId) continue;
    const c = byChain.get(p.chainId) ?? { id: p.chainId, announcers: new Set(), newest: null };
    c.announcers.add(p.pubkey); if (!c.newest || p.tip > c.newest.tip || (p.tip === c.newest.tip && p.created_at > c.newest.created_at)) c.newest = p;
    byChain.set(p.chainId, c);
  }
  const rows = await Promise.all([...byChain.values()].map(async ({ id, announcers, newest: t }) => {
    const times = t.headersHex.map(headerTime);
    const row = { id, name: id.replace(/^sidestr:/, ''), parent: null, comment: null, rules: [], signer: t.pubkey, tip: t.tip, lastBlock: times[times.length - 1] ?? null, blocks24h: times.filter((x) => x > now - 86400).length,
      announcedAt: t.created_at, mirrors: t.mirrors, mirror: null, ok: null, note: null, announcers: announcers.size };
    try { const f = await chooseMirror({ tip: t, chainId: id, fetchJson }); row.mirror = f.mirror; row.name = f.chain.name ?? row.name; row.parent = f.chain.parent ?? null; row.comment = f.chain.comment ?? null; row.rules = f.chain.rules ?? []; row.desk = f.chain.pledge ? { rate: f.chain.pledge.rate, maturity: f.chain.pledge.maturity } : null; row.checkpointed = !!f.chain.checkpointEvery; row.ok = true; row.note = `mirror vouched for by the signer`; }
    catch (e) { row.ok = false; row.note = e.message; }
    return row;
  }));
  return rows.sort((a, b) => b.blocks24h - a.blocks24h || b.tip - a.tip || b.announcedAt - a.announcedAt);
}
