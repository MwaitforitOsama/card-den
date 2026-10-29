// Voice signaling test: peerIds are public in state, voice is opt-in
// ('voice_join'), 'rtc' payloads relay only between voice members to the
// addressed peer, and 'voice' speaking flags fan out to all.
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

// Nobody is in voice until they opt in — relays go nowhere.
if (clients.some(cl => cl.state.players.some(p => p.inVoice))) errors.push('someone in voice before joining');
a.ws.send(JSON.stringify({ type: 'rtc', to: ids.B, data: { kind: 'ice' } }));
await sleep(300);
if (b.rtc.length !== 0) errors.push('rtc relayed before either side joined voice');

a.ws.send(JSON.stringify({ type: 'voice_join', on: true }));
b.ws.send(JSON.stringify({ type: 'voice_join', on: true }));
await sleep(400);
const inVoice = cl => cl.state.players.filter(p => p.inVoice).map(p => p.name).sort().join();
for (const cl of clients) {
  if (inVoice(cl) !== 'A,B') errors.push(`${cl.name} sees in voice: ${inVoice(cl)}, expected A,B`);
}

// C never joined voice: relays to them are dropped.
a.ws.send(JSON.stringify({ type: 'rtc', to: ids.C, data: { kind: 'ice' } }));
await sleep(300);
if (c.rtc.length !== 0) errors.push('rtc relayed to a peer not in voice');

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

// Leaving voice clears membership and the speaking flag.
b.ws.send(JSON.stringify({ type: 'voice_join', on: false }));
await sleep(400);
if (inVoice(a) !== 'A') errors.push(`after B left, A sees in voice: ${inVoice(a)}`);
if (!a.voice.some(v => v.peerId === ids.B && v.speaking === false)) errors.push('leaving voice did not clear speaking');

// The room is still healthy after relay traffic.
if (!clients.every(cl => cl.state.players.length === 3)) errors.push('roster corrupted');

clients.forEach(cl => { try { cl.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('VOICE SIGNALING TEST PASSED: peerIds public, voice opt-in, relay targeted to members, speaking fans out');
process.exit(0);
