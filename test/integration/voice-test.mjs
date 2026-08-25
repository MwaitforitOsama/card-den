// Voice signaling test: peerIds are public in state, 'rtc' payloads relay
// only to the addressed peer, and 'voice' speaking flags fan out to all.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
const clients = [];

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null, rtc: [], voice: [] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') c.state = m;
    if (m.type === 'rtc') c.rtc.push(m);
    if (m.type === 'voice') c.voice.push(m);
    if (m.type === 'error') errors.push(`${name}: ${m.message}`);
  };
  clients.push(c);
  return c;
}

const [a, b, c] = [client('A'), client('B'), client('C')];
await sleep(1000);

// Everyone sees everyone's public peerId, and their own.
const ids = {};
for (const cl of clients) {
  if (!cl.state?.youPeerId) errors.push(`${cl.name} has no youPeerId`);
  ids[cl.name] = cl.state.youPeerId;
  if (cl.state.players.some(p => !p.peerId)) errors.push(`${cl.name} sees players without peerId`);
}

// Targeted relay: only the addressee receives it, stamped with the sender.
a.ws.send(JSON.stringify({ type: 'rtc', to: ids.B, data: { kind: 'sdp', sdp: { type: 'offer', fake: true } } }));
await sleep(400);
if (b.rtc.length !== 1) errors.push(`B got ${b.rtc.length} rtc messages, expected 1`);
else {
  if (b.rtc[0].from !== ids.A) errors.push('rtc not stamped with sender peerId');
  if (b.rtc[0].data?.sdp?.type !== 'offer') errors.push('rtc payload mangled');
}
if (c.rtc.length !== 0) errors.push('C received a relay not addressed to them');
if (a.rtc.length !== 0) errors.push('sender received their own relay');

// Unknown target: silently dropped, no crash.
a.ws.send(JSON.stringify({ type: 'rtc', to: 'no-such-peer', data: { kind: 'ice' } }));
await sleep(300);

// Speaking flag fans out to everyone.
b.ws.send(JSON.stringify({ type: 'voice', speaking: true }));
await sleep(400);
for (const cl of clients) {
  const got = cl.voice.filter(v => v.peerId === ids.B && v.speaking === true);
  if (got.length !== 1) errors.push(`${cl.name} got ${got.length} speaking flags, expected 1`);
}

// The room is still healthy after relay traffic.
if (!clients.every(cl => cl.state.players.length === 3)) errors.push('roster corrupted');

clients.forEach(cl => { try { cl.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('VOICE SIGNALING TEST PASSED: peerIds public, relay targeted, speaking fans out');
process.exit(0);
